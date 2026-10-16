/** Reconciliation: link expenses to invoices/receipts with allocated amounts. */

var MAPS = {
  invoice: { table: 'expense_invoice_map', col: 'invoice_id', ent: 'invoices' },
  receipt: { table: 'expense_receipt_map', col: 'receipt_id', ent: 'receipts' }
};
function map_(kind) { var m = MAPS[kind]; if (!m) throw new Error('Unknown link type.'); return m; }

function reconExpense_(sess, expenseId) {
  var x = bq('SELECT e.expense_id AS id, e.center_id, e.vendor_id, v.name AS vendor_name, e.expense_date, e.amount, e.description, ' +
    'cat.name AS category_name, rv.matched_amount, rv.receipt_amount, rv.outstanding_amount, rv.match_status FROM ' + T('expenses') + ' e ' +
    'JOIN ' + T('v_reconciliation') + " rv ON rv.record_type = 'expense' AND rv.record_id = e.expense_id " +
    'LEFT JOIN ' + T('vendors') + ' v ON v.vendor_id = e.vendor_id LEFT JOIN ' + T('expense_categories') + ' cat ON cat.category_id = e.category_id ' +
    "WHERE e.expense_id = @id AND e.status = 'active' AND e.center_id IN UNNEST(@centers)", { id: expenseId, centers: SA(sess.center_ids) })[0];
  if (!x) throw new Error('Expense not found (or deleted).');
  return x;
}

function getReconcileData(token, expenseId) {
  var sess = requireSession(token);
  var x = reconExpense_(sess, expenseId);
  var p = { id: expenseId, c: x.center_id, v: S(x.vendor_id) };
  var vendorCond = x.vendor_id ? ' AND {a}.vendor_id = @v' : '';
  var links = bq(
    "SELECT 'invoice' AS kind, m.invoice_id AS other_id, i.invoice_no AS ref, i.invoice_date AS doc_date, i.total_amount AS doc_amount, m.allocated_amount  FROM " +
    T('expense_invoice_map') + ' m JOIN ' + T('invoices') + " i USING (invoice_id) WHERE m.expense_id = @id AND m.status = 'active' " +
    "UNION ALL SELECT 'receipt', m.receipt_id, CAST(NULL AS STRING), r.receipt_date, r.amount, m.allocated_amount FROM " +
    T('expense_receipt_map') + ' m JOIN ' + T('receipts') + " r USING (receipt_id) WHERE m.expense_id = @id AND m.status = 'active' ORDER BY kind, other_id", p);
  var invoices = bq('SELECT rv.record_id AS id, i.invoice_no, rv.record_date AS doc_date, rv.amount, rv.outstanding_amount, rv.match_status, v.name AS vendor_name FROM ' +
    T('v_reconciliation') + ' rv JOIN ' + T('invoices') + ' i ON i.invoice_id = rv.record_id LEFT JOIN ' + T('vendors') + ' v ON v.vendor_id = rv.vendor_id ' +
    "WHERE rv.record_type = 'invoice' AND rv.center_id = @c AND rv.outstanding_amount > 0" + vendorCond.replace('{a}', 'rv') +
    ' ORDER BY rv.record_date DESC LIMIT 100', p);
  var receipts = bq('SELECT r.receipt_id AS id, r.receipt_date AS doc_date, r.amount, r.amount - IFNULL(SUM(m.allocated_amount), 0) AS outstanding_amount, ANY_VALUE(v.name) AS vendor_name FROM ' +
    T('receipts') + ' r LEFT JOIN ' + T('expense_receipt_map') + " m ON m.receipt_id = r.receipt_id AND m.status = 'active' LEFT JOIN " + T('vendors') + ' v ON v.vendor_id = r.vendor_id ' +
    "WHERE r.center_id = @c AND r.status = 'active'" + vendorCond.replace('{a}', 'r') +
    ' GROUP BY r.receipt_id, r.receipt_date, r.amount HAVING outstanding_amount > 0 ORDER BY r.receipt_date DESC LIMIT 100', p);
  return { expense: x, links: links, invoices: invoices, receipts: receipts };
}

/** Link (or re-link / change amount of) an expense to an invoice or receipt. */
function linkRecord(token, kind, expenseId, otherId, amount) {
  var sess = requireSession(token);
  var m = map_(kind);
  var amt = Math.round(Number(amount) * 100) / 100;
  if (!(amt > 0)) throw new Error('Allocated amount must be more than zero.');
  return withLock_(function () {
    var x = reconExpense_(sess, expenseId);
    var e = ENTITIES[m.ent];
    var o = bq('SELECT ' + e.idCol + ' AS id, center_id, ' + e.amountCol + ' AS amount FROM ' + T(e.table) +
      " WHERE " + e.idCol + " = @id AND status = 'active' AND center_id IN UNNEST(@centers)", { id: otherId, centers: SA(sess.center_ids) })[0];
    if (!o) throw new Error(e.label + ' not found (or deleted).');
    if (o.center_id !== x.center_id) throw new Error('Both records must belong to the same center.');
    // Amounts already allocated, excluding any existing link between this pair (it will be replaced).
    var used = bq('SELECT ' +
      'IFNULL(SUM(IF(expense_id = @ex AND ' + m.col + ' != @o, allocated_amount, 0)), 0) AS exp_used, ' +
      'IFNULL(SUM(IF(' + m.col + ' = @o AND expense_id != @ex, allocated_amount, 0)), 0) AS other_used FROM ' + T(m.table) +
      " WHERE status = 'active' AND (expense_id = @ex OR " + m.col + ' = @o)', { ex: expenseId, o: otherId })[0];
    if (amt > Math.round((x.amount - used.exp_used) * 100) / 100) throw new Error('That is more than the expense amount still unallocated (' + (x.amount - used.exp_used).toFixed(2) + ').');
    if (amt > Math.round((o.amount - used.other_used) * 100) / 100) throw new Error('That is more than the ' + kind + ' amount still unallocated (' + (o.amount - used.other_used).toFixed(2) + ').');
    bqDml('MERGE ' + T(m.table) + ' t USING (SELECT @ex AS expense_id, @o AS other_id) s ON t.expense_id = s.expense_id AND t.' + m.col + ' = s.other_id ' +
      "WHEN MATCHED THEN UPDATE SET allocated_amount = @amt, status = 'active', updated_by = @by, updated_at = CURRENT_TIMESTAMP() " +
      'WHEN NOT MATCHED THEN INSERT (expense_id, ' + m.col + ", allocated_amount, status, sys_remarks, mapped_by, mapped_at) VALUES (s.expense_id, s.other_id, @amt, 'active', JSON '{}', @by, CURRENT_TIMESTAMP())",
      { ex: expenseId, o: otherId, amt: N(amt), by: sess.user_id });
    writeAudit_(m.table, expenseId + '|' + otherId, 'link', null, { allocated_amount: amt }, sess.user_id);
    return true;
  });
}

function unlinkRecord(token, kind, expenseId, otherId) {
  var sess = requireSession(token);
  var m = map_(kind);
  reconExpense_(sess, expenseId); // access check
  var n = bqDml('UPDATE ' + T(m.table) + " SET status = 'removed', updated_by = @by, updated_at = CURRENT_TIMESTAMP() " +
    'WHERE expense_id = @ex AND ' + m.col + " = @o AND status = 'active'", { ex: expenseId, o: otherId, by: sess.user_id });
  if (!n) throw new Error('Link not found.');
  writeAudit_(m.table, expenseId + '|' + otherId, 'unlink', { status: 'active' }, { status: 'removed' }, sess.user_id);
  return true;
}

/** Expenses that still need matching, for the Reconcile picker. */
function listUnmatchedExpenses(token, centerId) {
  var sess = requireSession(token);
  return bq('SELECT rv.record_id AS id, c.center_code, rv.record_date AS expense_date, rv.amount, rv.matched_amount, rv.receipt_amount, rv.match_status, v.name AS vendor_name FROM ' +
    T('v_reconciliation') + ' rv JOIN ' + T('centers') + ' c USING (center_id) LEFT JOIN ' + T('vendors') + ' v ON v.vendor_id = rv.vendor_id ' +
    "WHERE rv.record_type = 'expense' AND rv.center_id IN UNNEST(@centers) AND (rv.match_status != 'fully_matched' OR rv.receipt_amount < rv.amount) " +
    'ORDER BY rv.record_date DESC LIMIT 200', { centers: SA(centersFor_(sess, centerId)) });
}

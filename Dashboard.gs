/** Lookups (centers, vendors, categories, entity metadata) and dashboard totals. */

function getBootstrap(token) {
  var sess = requireSession(token);
  var centers = bq('SELECT center_id, center_code, name, TO_JSON_STRING(JSON_QUERY(sys_remarks, \'$.allowed_expense_categories\')) AS allowed FROM ' +
    T('centers') + ' WHERE center_id IN UNNEST(@c) ORDER BY LOWER(name)', { c: SA(sess.center_ids) });
  centers.forEach(function (c) { c.allowed_categories = c.allowed ? (JSON.parse(c.allowed) || []) : []; delete c.allowed; });
  var vendors = bq('SELECT vendor_id, name FROM ' + T('vendors') + ' WHERE active ORDER BY LOWER(name)');
  var categories = bq('SELECT category_id, name, parent_id FROM ' + T('expense_categories') + ' WHERE active ORDER BY LOWER(name)');
  var meta = {};
  Object.keys(ENTITIES).forEach(function (k) {
    var e = ENTITIES[k];
    meta[k] = { label: e.label, dateCol: e.dateCol, amountCol: e.amountCol, hasFile: e.hasFile, fields: e.fields };
  });
  return { role: sess.role, username: sess.username, centers: centers, vendors: vendors, categories: categories, meta: meta,
           attachmentsEnabled: true, today: todayStr_() };
}

/** month = 'YYYY-MM' */
function getDashboard(token, centerId, month) {
  var sess = requireSession(token);
  var centers = centersFor_(sess, centerId);
  if (!/^\d{4}-\d{2}$/.test(month || '')) month = todayStr_().slice(0, 7);
  var from = month + '-01';
  var p = { c: SA(centers), from: D(from) };
  var end = 'DATE_SUB(DATE_ADD(@from, INTERVAL 1 MONTH), INTERVAL 1 DAY)';
  var t = bq('SELECT ' +
    "(SELECT AS STRUCT COUNT(*) AS n, IFNULL(SUM(amount),0) AS amt FROM " + T('expenses') + " WHERE status='active' AND center_id IN UNNEST(@c) AND expense_date BETWEEN @from AND " + end + ') AS expenses, ' +
    "(SELECT AS STRUCT COUNT(*) AS n, IFNULL(SUM(total_amount),0) AS amt FROM " + T('invoices') + " WHERE status='active' AND center_id IN UNNEST(@c) AND invoice_date BETWEEN @from AND " + end + ') AS invoices, ' +
    "(SELECT AS STRUCT COUNT(*) AS n, IFNULL(SUM(amount),0) AS amt FROM " + T('receipts') + " WHERE status='active' AND center_id IN UNNEST(@c) AND receipt_date BETWEEN @from AND " + end + ') AS receipts', p)[0];
  var u = bq("SELECT COUNTIF(record_type='expense' AND match_status IN ('unmatched','partially_matched')) AS exp_unmatched, " +
    "COUNTIF(record_type='invoice' AND match_status IN ('unmatched','partially_matched')) AS inv_unmatched, " +
    "COUNTIF(match_status = 'over_matched') AS over_matched FROM " + T('v_reconciliation') + ' WHERE center_id IN UNNEST(@c)', { c: SA(centers) })[0];
  var byCat = bq('SELECT IFNULL(cat.name, \'(none)\') AS category, SUM(e.amount) AS amt FROM ' + T('expenses') + ' e LEFT JOIN ' + T('expense_categories') +
    " cat USING (category_id) WHERE e.status='active' AND e.center_id IN UNNEST(@c) AND e.expense_date BETWEEN @from AND " + end + ' GROUP BY 1 ORDER BY amt DESC LIMIT 10', p);
  var pending = sess.role === 'admin' ? countPending_(centers) : null;
  return { month: month, totals: t, unmatched: u, byCategory: byCat, pendingEdits: pending };
}

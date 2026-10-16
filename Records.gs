/**
 * Expenses / invoices / receipts: list, get, create, edit/delete (pending for non-admins).
 * Field types: s=string, n=numeric, d=date. Center is fixed after creation (it's part of the ID).
 */
var ENTITIES = {
  expenses: {
    table: 'expenses', idCol: 'expense_id', dateCol: 'expense_date', code: 'EXP', label: 'Expense',
    byCol: 'created_by', atCol: 'created_at', amountCol: 'amount', hasFile: false,
    fields: {
      expense_date: { t: 'd', req: true, label: 'Date' },
      category_id: { t: 's', req: true, label: 'Category', lookup: 'categories' },
      vendor_id: { t: 's', label: 'Vendor', lookup: 'vendors' },
      amount: { t: 'n', req: true, label: 'Amount' },
      payment_mode: { t: 's', req: true, label: 'Payment mode', options: ['cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other'] },
      payment_ref: { t: 's', label: 'Payment ref' },
      description: { t: 's', label: 'Description', long: true }
    }
  },
  invoices: {
    table: 'invoices', idCol: 'invoice_id', dateCol: 'invoice_date', code: 'INV', label: 'Invoice',
    byCol: 'uploaded_by', atCol: 'uploaded_at', amountCol: 'total_amount', hasFile: true,
    fields: {
      invoice_date: { t: 'd', req: true, label: 'Invoice date' },
      vendor_id: { t: 's', req: true, label: 'Vendor', lookup: 'vendors' },
      invoice_no: { t: 's', req: true, label: 'Invoice no.' },
      taxable_amount: { t: 'n', label: 'Taxable amount' },
      gst_amount: { t: 'n', label: 'GST amount' },
      total_amount: { t: 'n', req: true, label: 'Total amount' },
      file_id: { t: 's', label: 'Attachment', file: true }
    }
  },
  receipts: {
    table: 'receipts', idCol: 'receipt_id', dateCol: 'receipt_date', code: 'RCP', label: 'Receipt',
    byCol: 'uploaded_by', atCol: 'uploaded_at', amountCol: 'amount', hasFile: true,
    fields: {
      receipt_date: { t: 'd', req: true, label: 'Receipt date' },
      vendor_id: { t: 's', label: 'Vendor', lookup: 'vendors' },
      amount: { t: 'n', req: true, label: 'Amount' },
      file_id: { t: 's', label: 'Attachment', file: true }
    }
  }
};

function ent_(name) {
  var e = ENTITIES[name];
  if (!e) throw new Error('Unknown record type.');
  return e;
}

function typed_(f, v) {
  if (f.t === 'n') return N(v);
  if (f.t === 'd') return D(v);
  return S(cleanStr_(v, f.long ? 2000 : 200));
}

/** Validate + normalise a payload into {col: value}. partial=true only checks provided fields. */
function cleanPayload_(e, data, partial) {
  var out = {};
  Object.keys(e.fields).forEach(function (k) {
    var f = e.fields[k];
    if (partial && !(k in data)) return;
    var v = data[k];
    if (f.t === 'n' && v !== '' && v !== null && v !== undefined) {
      v = Math.round(Number(v) * 100) / 100;
      if (!isFinite(v)) throw new Error(f.label + ' must be a number.');
      if (v < 0) throw new Error(f.label + ' cannot be negative.');
    } else if (typeof v === 'string') v = v.trim();
    if (v === '' || v === undefined) v = null;
    if (f.req && v === null) throw new Error(f.label + ' is required.');
    if (f.options && v !== null && f.options.indexOf(v) < 0) throw new Error('Invalid ' + f.label + '.');
    if (f.t === 'd' && v !== null) {
      D(v);
      if (v > todayStr_()) throw new Error(f.label + ' cannot be in the future.');
    }
    out[k] = v;
  });
  if (e.table === 'expenses' && 'amount' in out && out.amount !== null && out.amount <= 0) throw new Error('Amount must be more than zero.');
  return out;
}

/** Category must exist, be active, and be in the center's allowed list (empty/missing = none allowed). */
function checkCategory_(centerId, categoryId) {
  var c = centerById_(centerId);
  var allowed = (c.sys_remarks && c.sys_remarks.allowed_expense_categories) || [];
  if (allowed.indexOf(categoryId) < 0) throw new Error('That category is not allowed for ' + c.center_code + '.');
  if (!bq('SELECT 1 AS x FROM ' + T('expense_categories') + ' WHERE category_id = @c AND active', { c: categoryId }).length)
    throw new Error('Category not found or inactive.');
}
function checkVendor_(vendorId) {
  if (!vendorId) return;
  if (!bq('SELECT 1 AS x FROM ' + T('vendors') + ' WHERE vendor_id = @v AND active', { v: vendorId }).length)
    throw new Error('Vendor not found or inactive.');
}
function validateRefs_(e, centerId, data) {
  if (e.table === 'expenses' && data.category_id) checkCategory_(centerId, data.category_id);
  if ('vendor_id' in data) checkVendor_(data.vendor_id);
  if (e.table === 'invoices' && data.invoice_no) {
    // Duplicate invoice number for the same vendor is almost always a mistake.
    var dup = bq('SELECT invoice_id FROM ' + T('invoices') + ' WHERE vendor_id = @v AND LOWER(invoice_no) = LOWER(@n) AND status = \'active\'' +
      (data._selfId ? ' AND invoice_id != @self' : '') + ' LIMIT 1',
      data._selfId ? { v: data.vendor_id, n: data.invoice_no, self: data._selfId } : { v: data.vendor_id, n: data.invoice_no });
    if (dup.length) throw new Error('Invoice ' + data.invoice_no + ' already exists for this vendor (' + dup[0].invoice_id + ').');
  }
}

/**
 * List with filters. f = {entity, center_id, from, to, vendor_id, status: 'active'|'deleted'|'pending'|'all', page}
 * Date range is always applied (partition pruning); default current FY to today.
 */
function listRecords(token, f) {
  var sess = requireSession(token);
  f = f || {};
  var e = ent_(f.entity);
  var centers = centersFor_(sess, f.center_id);
  var to = f.to || todayStr_(), from = f.from || fyStartStr_(to);
  D(from); D(to);
  var page = Math.max(0, Number(f.page) || 0);
  var where = ['r.' + e.dateCol + ' BETWEEN @from AND @to', 'r.center_id IN UNNEST(@centers)'];
  var p = { from: D(from), to: D(to), centers: SA(centers), lim: PAGE_SIZE + 1, off: page * PAGE_SIZE };
  if (f.vendor_id) { where.push('r.vendor_id = @vendor'); p.vendor = f.vendor_id; }
  var st = f.status || 'active';
  if (st === 'pending') where.push("JSON_QUERY(r.sys_remarks, '$.pending_edit') IS NOT NULL");
  else if (st !== 'all') { where.push('r.status = @status'); p.status = st; }
  var cols = ['r.' + e.idCol + ' AS id', 'r.center_id', 'c.center_code', 'r.status', 'v.name AS vendor_name',
    "JSON_QUERY(r.sys_remarks, '$.pending_edit') IS NOT NULL AS has_pending"];
  Object.keys(e.fields).forEach(function (k) { cols.push('r.' + k); });
  if (e.table === 'expenses') cols.push('cat.name AS category_name');
  var sql = 'SELECT ' + cols.join(', ') + ' FROM ' + T(e.table) + ' r JOIN ' + T('centers') + ' c USING (center_id) ' +
    'LEFT JOIN ' + T('vendors') + ' v ON v.vendor_id = r.vendor_id ' +
    (e.table === 'expenses' ? 'LEFT JOIN ' + T('expense_categories') + ' cat ON cat.category_id = r.category_id ' : '') +
    'WHERE ' + where.join(' AND ') + ' ORDER BY r.' + e.dateCol + ' DESC, id DESC LIMIT @lim OFFSET @off';
  var rows = bq(sql, p);
  var total = bq('SELECT COUNT(*) AS n, IFNULL(SUM(r.' + e.amountCol + '), 0) AS amt FROM ' + T(e.table) + ' r WHERE ' + where.join(' AND '), p)[0];
  return { rows: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE, page: page, from: from, to: to,
           totalCount: total.n, totalAmount: total.amt };
}

/** Fetch one record (with pending edit) the caller can see. */
function getRecord_(sess, e, id) {
  var cols = ['r.' + e.idCol + ' AS id', 'r.center_id', 'r.status', 'TO_JSON_STRING(r.sys_remarks) AS sr'];
  Object.keys(e.fields).forEach(function (k) { cols.push('r.' + k); });
  var r = bq('SELECT ' + cols.join(', ') + ' FROM ' + T(e.table) + ' r WHERE r.' + e.idCol + ' = @id AND r.center_id IN UNNEST(@centers)',
    { id: id, centers: SA(sess.center_ids) })[0];
  if (!r) throw new Error(e.label + ' not found.');
  r.sys_remarks = r.sr ? JSON.parse(r.sr) : {};
  delete r.sr;
  return r;
}

function getRecord(token, entity, id) {
  var sess = requireSession(token);
  var r = getRecord_(sess, ent_(entity), id);
  return { record: r, pending_edit: r.sys_remarks.pending_edit || null };
}

function createRecord(token, entity, centerId, data, requestId) {
  var sess = requireSession(token);
  return idempotent_(sess, 'create_' + entity, requestId, function () { return createRecord_(sess, entity, centerId, data); });
}

function createRecord_(sess, entity, centerId, data) {
  var e = ent_(entity);
  assertCenter_(sess, centerId);
  var clean = cleanPayload_(e, data || {}, false);
  validateRefs_(e, centerId, clean);
  if (clean.file_id) assertAttachmentOk_(clean.file_id);
  var center = centerById_(centerId);
  var cols = Object.keys(clean);
  var p = { center: centerId, by: sess.user_id };
  cols.forEach(function (k) { p['f_' + k] = typed_(e.fields[k], clean[k]); });
  var extraCols = e.table === 'expenses' ? ', user_id' : '';
  var extraVals = e.table === 'expenses' ? ', @by' : '';
  return withLock_(function () {
    var id = nextId_(center.center_code, e.code, clean[e.dateCol]);
    p.id = id;
    bqDml('INSERT INTO ' + T(e.table) + ' (' + e.idCol + ', center_id' + extraCols + ', ' + cols.join(', ') +
      ', status, sys_remarks, ' + e.byCol + ', ' + e.atCol + ') VALUES (@id, @center' + extraVals + ', ' +
      cols.map(function (k) { return '@f_' + k; }).join(', ') + ", 'active', JSON '{}', @by, CURRENT_TIMESTAMP())", p);
    writeAudit_(e.table, id, 'create', null, clean, sess.user_id);
    return { id: id };
  });
}

/** Admin: apply directly. User: store as pending_edit (one at a time). */
function updateRecord(token, entity, id, changes, reason) {
  var sess = requireSession(token);
  var e = ent_(entity);
  var r = getRecord_(sess, e, id);
  if (r.status !== 'active') throw new Error('Only active records can be edited.');
  var clean = cleanPayload_(e, changes || {}, true);
  var diff = {};
  Object.keys(clean).forEach(function (k) { if (!sameVal_(r[k], clean[k])) diff[k] = clean[k]; });
  if (!Object.keys(diff).length) throw new Error('Nothing changed.');
  var refs = {};
  if ('category_id' in diff) refs.category_id = diff.category_id;
  if ('vendor_id' in diff) refs.vendor_id = diff.vendor_id;
  if (e.table === 'invoices' && ('vendor_id' in diff || 'invoice_no' in diff)) {
    refs.vendor_id = 'vendor_id' in diff ? diff.vendor_id : r.vendor_id;
    refs.invoice_no = 'invoice_no' in diff ? diff.invoice_no : r.invoice_no;
    refs._selfId = id;
  }
  validateRefs_(e, r.center_id, refs);
  if (diff.file_id) assertAttachmentOk_(diff.file_id);
  if (sess.role === 'admin') {
    applyChanges_(e, r, diff, sess.user_id, 'update');
    return { applied: true };
  }
  requestPending_(sess, e, r, { type: 'edit', changes: diff }, reason);
  return { applied: false, pending: true };
}

function deleteRecord(token, entity, id, reason) {
  var sess = requireSession(token);
  var e = ent_(entity);
  var r = getRecord_(sess, e, id);
  if (r.status !== 'active') throw new Error('This record is already deleted.');
  if (sess.role === 'admin') {
    softDelete_(e, r, sess.user_id);
    return { applied: true };
  }
  requestPending_(sess, e, r, { type: 'delete', changes: {} }, reason);
  return { applied: false, pending: true };
}

function sameVal_(a, b) {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

function requestPending_(sess, e, r, pe, reason) {
  reason = cleanStr_(reason, 500);
  if (!reason) throw new Error('Please give a reason for the change.');
  pe.requested_by = sess.user_id;
  pe.requested_by_name = sess.username;
  pe.requested_at = new Date().toISOString();
  pe.reason = reason;
  var n = bqDml('UPDATE ' + T(e.table) + " SET sys_remarks = JSON_SET(IFNULL(sys_remarks, JSON '{}'), '$.pending_edit', PARSE_JSON(@pe)) " +
    'WHERE ' + e.idCol + " = @id AND center_id IN UNNEST(@centers) AND status = 'active' " +
    "AND JSON_QUERY(sys_remarks, '$.pending_edit') IS NULL", { pe: JSON.stringify(pe), id: r.id, centers: SA(sess.center_ids) });
  if (!n) throw new Error('This record already has a change waiting for approval.');
  writeAudit_(e.table, r.id, 'request_' + pe.type, null, pe, sess.user_id);
}

function applyChanges_(e, r, diff, by, action) {
  var sets = [], p = { id: r.id, by: by };
  Object.keys(diff).forEach(function (k) { sets.push(k + ' = @f_' + k); p['f_' + k] = typed_(e.fields[k], diff[k]); });
  bqDml('UPDATE ' + T(e.table) + ' SET ' + sets.join(', ') + ", sys_remarks = JSON_REMOVE(IFNULL(sys_remarks, JSON '{}'), '$.pending_edit'), " +
    'updated_by = @by, updated_at = CURRENT_TIMESTAMP() WHERE ' + e.idCol + ' = @id', p);
  var old = {};
  Object.keys(diff).forEach(function (k) { old[k] = r[k]; });
  writeAudit_(e.table, r.id, action, old, diff, by);
}

/** Never hard delete: status = 'deleted'. Also removes the record's active reconciliation links. */
function softDelete_(e, r, by) {
  bqDml('UPDATE ' + T(e.table) + " SET status = 'deleted', sys_remarks = JSON_REMOVE(IFNULL(sys_remarks, JSON '{}'), '$.pending_edit'), " +
    'updated_by = @by, updated_at = CURRENT_TIMESTAMP() WHERE ' + e.idCol + ' = @id', { id: r.id, by: by });
  var maps = e.table === 'expenses' ? [['expense_invoice_map', 'expense_id'], ['expense_receipt_map', 'expense_id']]
    : e.table === 'invoices' ? [['expense_invoice_map', 'invoice_id']] : [['expense_receipt_map', 'receipt_id']];
  maps.forEach(function (m) {
    bqDml('UPDATE ' + T(m[0]) + " SET status = 'removed', updated_by = @by, updated_at = CURRENT_TIMESTAMP() WHERE " + m[1] + " = @id AND status = 'active'",
      { id: r.id, by: by });
  });
  writeAudit_(e.table, r.id, 'delete', { status: 'active' }, { status: 'deleted' }, by);
}

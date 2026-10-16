/** Admin-only functions: users, vendors, categories, center category lists, pending edits. */

function admin_(token) { return requireSession(token, { admin: true }); }

// ---------- users ----------
function adminListUsers(token) {
  admin_(token);
  // Center list via LEFT JOIN + ARRAY_AGG (BigQuery rejects correlated ARRAY subqueries on another table).
  return bq('SELECT u.user_id, u.username, u.name, u.email, u.role, u.active, IFNULL(u.must_change_password, FALSE) AS must_change_password, ' +
    '(u.locked_until IS NOT NULL AND u.locked_until > CURRENT_TIMESTAMP()) AS locked, u.last_login_at, ' +
    'ARRAY_AGG(uc.center_id IGNORE NULLS ORDER BY uc.center_id) AS center_ids FROM ' + T('users') + ' u LEFT JOIN ' +
    T('user_centers') + ' uc ON uc.user_id = u.user_id AND uc.active ' +
    'GROUP BY u.user_id, u.username, u.name, u.email, u.role, u.active, must_change_password, locked, u.last_login_at ' +
    'ORDER BY u.active DESC, u.username');
}

function tempPassword_() {
  return 'Bt' + Utilities.getUuid().replace(/-/g, '').slice(0, 8) + Math.floor(Math.random() * 90 + 10);
}

function validRole_(r) { if (['admin', 'user'].indexOf(r) < 0) throw new Error('Role must be admin or user.'); return r; }

function cleanEmail_(e) {
  e = cleanStr_(e, 200);
  if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('Invalid email.');
  return e ? e.toLowerCase() : null;
}

function validCenterIds_(ids) {
  ids = (ids || []).filter(String);
  if (!ids.length) return [];
  var found = bq('SELECT center_id FROM ' + T('centers') + ' WHERE center_id IN UNNEST(@c)', { c: SA(ids) }).map(function (r) { return r.center_id; });
  if (found.length !== ids.length) throw new Error('Unknown center selected.');
  return ids;
}

/** Create a user; returns a one-time temporary password for the admin to pass on. */
function adminCreateUser(token, u, requestId) {
  var sess = admin_(token);
  // Note: the cached duplicate-result includes the one-time temp password (server-side cache only, 10 min).
  return idempotent_(sess, 'user', requestId, function () { return adminCreateUser_(sess, u); });
}

function adminCreateUser_(sess, u) {
  var uname = normUsername_(u.username);
  var name = cleanStr_(u.name, 100); if (!name) throw new Error('Name is required.');
  var role = validRole_(u.role || 'user');
  var email = cleanEmail_(u.email);
  var centers = validCenterIds_(u.center_ids);
  if (role === 'user' && !centers.length) throw new Error('Pick at least one center for this user.');
  var temp = tempPassword_();
  var salt = newSalt_();
  var hash = hashPassword_(temp, salt, CONFIG.HASH_ITERATIONS);
  var uid = withLock_(function () {
    if (bq('SELECT 1 AS x FROM ' + T('users') + ' WHERE LOWER(username) = @u', { u: uname }).length) throw new Error('Username "' + uname + '" is already taken.');
    var id = shortId_('USR');
    bqDml('INSERT INTO ' + T('users') + ' (user_id, username, email, name, role, active, sys_remarks, password_hash, password_salt, hash_iterations, ' +
      "must_change_password, failed_attempts, created_at, updated_at) VALUES (@id, @u, @e, @n, @r, TRUE, JSON '{}', @h, @s, @it, TRUE, 0, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())",
      { id: id, u: uname, e: S(email), n: name, r: role, h: hash, s: salt, it: CONFIG.HASH_ITERATIONS });
    return id;
  });
  setUserCenters_(uid, centers);
  writeAudit_('users', uid, 'create', null, { username: uname, name: name, role: role, center_ids: centers }, sess.user_id);
  return { user_id: uid, username: uname, temporary_password: temp };
}

function setUserCenters_(uid, centers) {
  bqDml('UPDATE ' + T('user_centers') + ' SET active = FALSE, updated_at = CURRENT_TIMESTAMP() WHERE user_id = @u AND active AND center_id NOT IN UNNEST(@c)',
    { u: uid, c: SA(centers) });
  if (!centers.length) return;
  bqDml('MERGE ' + T('user_centers') + ' t USING (SELECT @u AS user_id, c AS center_id, off = 0 AS is_primary FROM UNNEST(@c) c WITH OFFSET off) s ' +
    'ON t.user_id = s.user_id AND t.center_id = s.center_id ' +
    'WHEN MATCHED AND NOT t.active THEN UPDATE SET active = TRUE, updated_at = CURRENT_TIMESTAMP() ' +
    'WHEN NOT MATCHED THEN INSERT (user_id, center_id, is_primary, active, created_at) VALUES (s.user_id, s.center_id, s.is_primary, TRUE, CURRENT_TIMESTAMP())',
    { u: uid, c: SA(centers) });
}

/** Update name/email/role/active/centers. Changes take effect at the user's next login. */
function adminUpdateUser(token, userId, u) {
  var sess = admin_(token);
  var old = bq('SELECT user_id, username, name, email, role, active FROM ' + T('users') + ' WHERE user_id = @id', { id: userId })[0];
  if (!old) throw new Error('User not found.');
  var name = cleanStr_(u.name, 100) || old.name;
  var role = validRole_(u.role || old.role);
  var active = u.active === undefined ? old.active : !!u.active;
  if (userId === sess.user_id && (role !== 'admin' || !active)) throw new Error('You cannot remove your own admin access.');
  var email = 'email' in u ? cleanEmail_(u.email) : old.email;
  bqDml('UPDATE ' + T('users') + ' SET name = @n, email = @e, role = @r, active = @a, updated_at = CURRENT_TIMESTAMP() WHERE user_id = @id',
    { n: name, e: S(email), r: role, a: active, id: userId });
  if (u.center_ids) setUserCenters_(userId, validCenterIds_(u.center_ids));
  writeAudit_('users', userId, 'update', { name: old.name, role: old.role, active: old.active },
    { name: name, role: role, active: active, center_ids: u.center_ids || null }, sess.user_id);
  return true;
}

/** Unlock a locked-out user without changing their password. */
function adminUnlockUser(token, userId) {
  var sess = admin_(token);
  bqDml('UPDATE ' + T('users') + ' SET failed_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP() WHERE user_id = @id', { id: userId });
  writeAudit_('users', userId, 'unlock', null, null, sess.user_id);
  return true;
}

// ---------- vendors ----------
var VENDOR_FIELDS = ['name', 'gstin', 'pan', 'phone', 'email', 'address', 'bank_account_name', 'bank_account_no', 'bank_ifsc', 'upi_id'];

function adminListVendors(token) {
  admin_(token);
  return bq('SELECT vendor_id, ' + VENDOR_FIELDS.join(', ') + ', active FROM ' + T('vendors') + ' ORDER BY active DESC, name');
}

function cleanVendor_(v) {
  var o = {};
  VENDOR_FIELDS.forEach(function (k) { o[k] = cleanStr_(v[k], 300); });
  if (!o.name) throw new Error('Vendor name is required.');
  if (o.gstin) { o.gstin = o.gstin.toUpperCase(); if (!/^[0-9A-Z]{15}$/.test(o.gstin)) throw new Error('GSTIN must be 15 letters/digits.'); }
  if (o.pan) { o.pan = o.pan.toUpperCase(); if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(o.pan)) throw new Error('Invalid PAN.'); }
  if (o.bank_ifsc) { o.bank_ifsc = o.bank_ifsc.toUpperCase(); if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(o.bank_ifsc)) throw new Error('Invalid IFSC.'); }
  if (o.email) o.email = cleanEmail_(o.email);
  return o;
}

/** Users may also add vendors (needed while entering expenses); only admins can edit them. */
function createVendor(token, v, requestId) {
  var sess = requireSession(token);
  return idempotent_(sess, 'vendor', requestId, function () { return createVendor_(sess, v); });
}

function createVendor_(sess, v) {
  var o = cleanVendor_(v || {});
  return withLock_(function () {
    if (bq('SELECT 1 AS x FROM ' + T('vendors') + ' WHERE LOWER(name) = LOWER(@n) AND active', { n: o.name }).length)
      throw new Error('A vendor named "' + o.name + '" already exists.');
    var id = shortId_('VEN');
    var p = { id: id };
    VENDOR_FIELDS.forEach(function (k) { p[k] = S(o[k]); });
    bqDml('INSERT INTO ' + T('vendors') + ' (vendor_id, ' + VENDOR_FIELDS.join(', ') + ", active, sys_remarks, created_at) VALUES (@id, " +
      VENDOR_FIELDS.map(function (k) { return '@' + k; }).join(', ') + ", TRUE, JSON '{}', CURRENT_TIMESTAMP())", p);
    writeAudit_('vendors', id, 'create', null, { name: o.name }, sess.user_id);
    return { vendor_id: id, name: o.name };
  });
}

function adminUpdateVendor(token, vendorId, v) {
  var sess = admin_(token);
  var o = cleanVendor_(v || {});
  var p = { id: vendorId, active: v.active === undefined ? true : !!v.active };
  VENDOR_FIELDS.forEach(function (k) { p[k] = S(o[k]); });
  var n = bqDml('UPDATE ' + T('vendors') + ' SET ' + VENDOR_FIELDS.map(function (k) { return k + ' = @' + k; }).join(', ') +
    ', active = @active, updated_at = CURRENT_TIMESTAMP() WHERE vendor_id = @id', p);
  if (!n) throw new Error('Vendor not found.');
  writeAudit_('vendors', vendorId, 'update', null, { name: o.name, active: p.active }, sess.user_id);
  return true;
}

// ---------- categories ----------
function adminListCategories(token) {
  admin_(token);
  return bq('SELECT c.category_id, c.name, c.parent_id, p.name AS parent_name, c.gst_applicable, c.active FROM ' + T('expense_categories') +
    ' c LEFT JOIN ' + T('expense_categories') + ' p ON p.category_id = c.parent_id ORDER BY c.active DESC, IFNULL(p.name, c.name), c.parent_id IS NOT NULL, c.name');
}

function checkParent_(parentId, selfId) {
  if (!parentId) return null;
  if (parentId === selfId) throw new Error('A category cannot be its own parent.');
  var p = bq('SELECT parent_id FROM ' + T('expense_categories') + ' WHERE category_id = @p', { p: parentId })[0];
  if (!p) throw new Error('Parent category not found.');
  if (p.parent_id) throw new Error('Only one level of sub-categories is supported.');
  return parentId;
}

function adminCreateCategory(token, c) {
  var sess = admin_(token);
  var name = cleanStr_(c.name, 100); if (!name) throw new Error('Category name is required.');
  var parent = checkParent_(cleanStr_(c.parent_id), null);
  return withLock_(function () {
    if (bq('SELECT 1 AS x FROM ' + T('expense_categories') + ' WHERE LOWER(name) = LOWER(@n) AND IFNULL(parent_id, \'\') = IFNULL(@p, \'\')', { n: name, p: S(parent) }).length)
      throw new Error('That category already exists.');
    var id = shortId_('CAT');
    bqDml('INSERT INTO ' + T('expense_categories') + " (category_id, name, parent_id, gst_applicable, active, sys_remarks, created_at) VALUES (@id, @n, @p, @g, TRUE, JSON '{}', CURRENT_TIMESTAMP())",
      { id: id, n: name, p: S(parent), g: !!c.gst_applicable });
    writeAudit_('expense_categories', id, 'create', null, { name: name, parent_id: parent }, sess.user_id);
    return { category_id: id };
  });
}

function adminUpdateCategory(token, categoryId, c) {
  var sess = admin_(token);
  var name = cleanStr_(c.name, 100); if (!name) throw new Error('Category name is required.');
  var parent = checkParent_(cleanStr_(c.parent_id), categoryId);
  if (parent && bq('SELECT 1 AS x FROM ' + T('expense_categories') + ' WHERE parent_id = @id', { id: categoryId }).length)
    throw new Error('This category has sub-categories, so it cannot be moved under another one.');
  var n = bqDml('UPDATE ' + T('expense_categories') + ' SET name = @n, parent_id = @p, gst_applicable = @g, active = @a, updated_at = CURRENT_TIMESTAMP() WHERE category_id = @id',
    { n: name, p: S(parent), g: !!c.gst_applicable, a: c.active === undefined ? true : !!c.active, id: categoryId });
  if (!n) throw new Error('Category not found.');
  writeAudit_('expense_categories', categoryId, 'update', null, { name: name, parent_id: parent, active: c.active }, sess.user_id);
  return true;
}

// ---------- center allowed categories ----------
function adminListCenters(token) {
  admin_(token);
  var rows = bq('SELECT center_id, center_code, name, active, TO_JSON_STRING(JSON_QUERY(sys_remarks, \'$.allowed_expense_categories\')) AS allowed FROM ' +
    T('centers') + ' ORDER BY center_code');
  rows.forEach(function (r) { r.allowed_categories = r.allowed ? (JSON.parse(r.allowed) || []) : []; delete r.allowed; });
  return rows;
}

function adminSetCenterCategories(token, centerId, categoryIds) {
  var sess = admin_(token);
  categoryIds = (categoryIds || []).filter(String);
  if (categoryIds.length) {
    var ok = bq('SELECT COUNT(*) AS n FROM ' + T('expense_categories') + ' WHERE category_id IN UNNEST(@c)', { c: SA(categoryIds) })[0].n;
    if (ok !== categoryIds.length) throw new Error('Unknown category selected.');
  }
  var old = centerById_(centerId);
  bqDml('UPDATE ' + T('centers') + " SET sys_remarks = JSON_SET(IFNULL(sys_remarks, JSON '{}'), '$.allowed_expense_categories', PARSE_JSON(@a)), updated_at = CURRENT_TIMESTAMP() WHERE center_id = @id",
    { a: JSON.stringify(categoryIds), id: centerId });
  writeAudit_('centers', centerId, 'set_allowed_categories', { allowed_expense_categories: old.sys_remarks.allowed_expense_categories || [] },
    { allowed_expense_categories: categoryIds }, sess.user_id);
  return true;
}

// ---------- pending edits ----------
function countPending_(centers) {
  var q = Object.keys(ENTITIES).map(function (k) {
    return 'SELECT COUNT(*) AS n FROM ' + T(ENTITIES[k].table) + " WHERE center_id IN UNNEST(@c) AND status = 'active' AND JSON_QUERY(sys_remarks, '$.pending_edit') IS NOT NULL";
  }).join(' UNION ALL ');
  return bq('SELECT SUM(n) AS n FROM (' + q + ')', { c: SA(centers) })[0].n;
}

function adminListPending(token) {
  var sess = admin_(token);
  var out = [];
  Object.keys(ENTITIES).forEach(function (k) {
    var e = ENTITIES[k];
    var cols = Object.keys(e.fields).map(function (f) { return 'r.' + f; });
    var rows = bq('SELECT r.' + e.idCol + ' AS id, c.center_code, TO_JSON_STRING(JSON_QUERY(r.sys_remarks, \'$.pending_edit\')) AS pe, ' + cols.join(', ') +
      ' FROM ' + T(e.table) + ' r JOIN ' + T('centers') + " c USING (center_id) WHERE r.status = 'active' AND JSON_QUERY(r.sys_remarks, '$.pending_edit') IS NOT NULL " +
      'AND r.center_id IN UNNEST(@c) ORDER BY r.' + e.idCol, { c: SA(sess.center_ids) });
    rows.forEach(function (r) {
      var pe = JSON.parse(r.pe); delete r.pe;
      var id = r.id, cc = r.center_code; delete r.id; delete r.center_code;
      out.push({ entity: k, label: e.label, id: id, center_code: cc, current: r, pending: pe, fields: e.fields });
    });
  });
  out.sort(function (a, b) { return String(a.pending.requested_at).localeCompare(String(b.pending.requested_at)); });
  return out;
}

function adminApprovePending(token, entity, id) {
  var sess = admin_(token);
  var e = ent_(entity);
  return withLock_(function () {
    var r = getRecord_(sess, e, id);
    var pe = r.sys_remarks.pending_edit;
    if (!pe) throw new Error('No pending change on this record (maybe already handled).');
    if (pe.type === 'delete') softDelete_(e, r, sess.user_id);
    else {
      var clean = cleanPayload_(e, pe.changes || {}, true);   // re-validate at approval time
      var refs = {};
      if ('category_id' in clean) refs.category_id = clean.category_id;
      if ('vendor_id' in clean) refs.vendor_id = clean.vendor_id;
      validateRefs_(e, r.center_id, refs);
      applyChanges_(e, r, clean, sess.user_id, 'approve_edit');
    }
    // Edits are audited by applyChanges_ (old/new values); this row records who asked and why.
    writeAudit_(e.table, id, 'approve_' + pe.type + '_request', null, { requested_by: pe.requested_by, reason: pe.reason }, sess.user_id);
    return true;
  });
}

function adminRejectPending(token, entity, id, note) {
  var sess = admin_(token);
  var e = ent_(entity);
  var r = getRecord_(sess, e, id);
  var pe = r.sys_remarks.pending_edit;
  if (!pe) throw new Error('No pending change on this record.');
  bqDml('UPDATE ' + T(e.table) + " SET sys_remarks = JSON_REMOVE(sys_remarks, '$.pending_edit'), updated_at = CURRENT_TIMESTAMP(), updated_by = @by WHERE " + e.idCol + ' = @id',
    { id: id, by: sess.user_id });
  writeAudit_(e.table, id, 'reject_' + pe.type, pe, { note: cleanStr_(note, 500) }, sess.user_id);
  return true;
}

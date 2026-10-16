/**
 * Authentication: username + password stored as salted, iterated SHA-256.
 * Sessions are random tokens in CacheService. Every server entry point must call requireSession().
 */

// ---------- hashing ----------
function newSalt_() {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + Utilities.getUuid() + Date.now() + Math.random());
  return Utilities.base64Encode(bytes);
}

function hashPassword_(password, salt, iterations) {
  var saltBytes = Utilities.base64Decode(salt);
  var h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    saltBytes.concat(Utilities.newBlob(password).getBytes()));
  for (var i = 1; i < iterations; i++) {
    h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h.concat(saltBytes));
  }
  return Utilities.base64Encode(h);
}

function constantTimeEquals_(a, b) {
  a = String(a || ''); b = String(b || '');
  var diff = a.length ^ b.length;
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0);
  return diff === 0;
}

function validatePassword_(pw) {
  if (typeof pw !== 'string' || pw.length < CONFIG.MIN_PASSWORD_LENGTH)
    throw new Error('Password must be at least ' + CONFIG.MIN_PASSWORD_LENGTH + ' characters.');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw))
    throw new Error('Password must contain letters and numbers.');
}

function normUsername_(u) {
  u = String(u || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(u)) throw new Error('Invalid username.');
  return u;
}

// ---------- logging ----------
function logLogin_(username, userId, result, reason) {
  try {
    bqDml('INSERT INTO ' + T('login_log') +
      ' (log_id, username, user_id, result, reason, logged_at) VALUES (@id, @login, @uid, @res, @reason, CURRENT_TIMESTAMP())',
      { id: Utilities.getUuid(), login: username || '(blank)', uid: { type: 'STRING', value: userId || null },
        res: result, reason: { type: 'STRING', value: reason || null } });
  } catch (e) { console.error('login_log failed: ' + e); }
}

// ---------- sessions ----------
function userCenterIds_(userId, role) {
  var rows = role === 'admin'
    ? bq('SELECT center_id FROM ' + T('centers') + ' WHERE active ORDER BY center_code')
    : bq('SELECT uc.center_id FROM ' + T('user_centers') + ' uc JOIN ' + T('centers') +
         ' c USING (center_id) WHERE uc.user_id = @uid AND uc.active AND c.active ORDER BY c.center_code', { uid: userId });
  return rows.map(function (r) { return r.center_id; });
}

function createSession_(user) {
  var token = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + Utilities.getUuid() + Math.random())).replace(/=+$/, '');
  var sess = {
    user_id: user.user_id, username: user.username, name: user.name, role: user.role,
    center_ids: userCenterIds_(user.user_id, user.role),
    must_change_password: !!user.must_change_password,
    issued_at: Date.now()
  };
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(sess), CONFIG.CACHE_TTL_SEC);
  return { token: token, session: sess };
}

/**
 * Validate a session token. Throws if invalid/expired.
 * opts.allowPasswordChange: allow sessions flagged must_change_password (only for changePassword/logout).
 * opts.admin: require admin role.
 */
function requireSession(token, opts) {
  opts = opts || {};
  if (!token || typeof token !== 'string') throw new Error('SESSION_EXPIRED');
  var cache = CacheService.getScriptCache();
  var raw = cache.get('sess_' + token);
  if (!raw) throw new Error('SESSION_EXPIRED');
  var sess = JSON.parse(raw);
  var age = (Date.now() - sess.issued_at) / 1000;
  if (age > CONFIG.SESSION_MAX_AGE_SEC) { cache.remove('sess_' + token); throw new Error('SESSION_EXPIRED'); }
  if (sess.must_change_password && !opts.allowPasswordChange) throw new Error('PASSWORD_CHANGE_REQUIRED');
  if (opts.admin && sess.role !== 'admin') throw new Error('Not allowed.');
  cache.put('sess_' + token, raw, Math.min(CONFIG.CACHE_TTL_SEC, Math.max(60, Math.floor(CONFIG.SESSION_MAX_AGE_SEC - age))));
  sess.token = token;
  return sess;
}

function publicSession_(sess) {
  var centers = sess.center_ids.length
    ? bq('SELECT center_id, center_code, name FROM ' + T('centers') + ' WHERE center_id IN UNNEST(@ids) ORDER BY center_code',
         { ids: { type: 'STRING', value: sess.center_ids } })
    : [];
  return { username: sess.username, name: sess.name, role: sess.role,
           must_change_password: sess.must_change_password, centers: centers };
}

// ---------- public API (called from client) ----------
function login(username, password) {
  var uname;
  try { uname = normUsername_(username); } catch (e) { throw new Error('Invalid username or password.'); }
  var generic = 'Invalid username or password.';
  var rows = bq('SELECT user_id, username, name, role, active, password_hash, password_salt, hash_iterations, ' +
    'must_change_password, IFNULL(failed_attempts,0) AS failed_attempts, ' +
    '(locked_until IS NOT NULL AND locked_until > CURRENT_TIMESTAMP()) AS is_locked FROM ' + T('users') +
    ' WHERE username = @u LIMIT 1', { u: uname });
  var u = rows[0];
  if (!u || !u.active || !u.password_hash) {
    logLogin_(uname, u && u.user_id, 'failure', !u ? 'unknown_user' : (!u.active ? 'inactive' : 'no_password'));
    throw new Error(generic);
  }
  if (u.is_locked) {
    logLogin_(uname, u.user_id, 'failure', 'locked');
    throw new Error('Too many failed attempts. Try again in ' + CONFIG.LOCKOUT_MINUTES + ' minutes.');
  }
  var ok = constantTimeEquals_(hashPassword_(String(password || ''), u.password_salt, u.hash_iterations || CONFIG.HASH_ITERATIONS), u.password_hash);
  if (!ok) {
    var fails = u.failed_attempts + 1;
    var lock = fails >= CONFIG.MAX_FAILED_ATTEMPTS;
    bqDml('UPDATE ' + T('users') + ' SET failed_attempts = @f, locked_until = ' +
      (lock ? 'TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL @m MINUTE)' : 'locked_until') +
      ', updated_at = CURRENT_TIMESTAMP() WHERE user_id = @uid',
      lock ? { f: lock ? 0 : fails, m: CONFIG.LOCKOUT_MINUTES, uid: u.user_id } : { f: fails, uid: u.user_id });
    logLogin_(uname, u.user_id, 'failure', lock ? 'bad_password_locked' : 'bad_password');
    if (lock) throw new Error('Too many failed attempts. Try again in ' + CONFIG.LOCKOUT_MINUTES + ' minutes.');
    throw new Error(generic);
  }
  bqDml('UPDATE ' + T('users') + ' SET failed_attempts = 0, locked_until = NULL, last_login_at = CURRENT_TIMESTAMP() WHERE user_id = @uid',
    { uid: u.user_id });
  logLogin_(uname, u.user_id, 'success', null);
  var s = createSession_(u);
  return { token: s.token, user: publicSession_(s.session) };
}

function getSessionInfo(token) {
  return publicSession_(requireSession(token, { allowPasswordChange: true }));
}

function logout(token) {
  if (token) CacheService.getScriptCache().remove('sess_' + token);
  return true;
}

function changePassword(token, oldPassword, newPassword) {
  var sess = requireSession(token, { allowPasswordChange: true });
  var u = bq('SELECT password_hash, password_salt, hash_iterations FROM ' + T('users') + ' WHERE user_id = @uid', { uid: sess.user_id })[0];
  if (!u || !constantTimeEquals_(hashPassword_(String(oldPassword || ''), u.password_salt, u.hash_iterations || CONFIG.HASH_ITERATIONS), u.password_hash))
    throw new Error('Current password is incorrect.');
  validatePassword_(newPassword);
  if (newPassword === oldPassword) throw new Error('New password must be different.');
  setPasswordInternal_(sess.user_id, newPassword, false);
  sess.must_change_password = false;
  delete sess.token;
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(sess), CONFIG.CACHE_TTL_SEC);
  return publicSession_(sess);
}

function setPasswordInternal_(userId, password, mustChange) {
  var salt = newSalt_();
  var hash = hashPassword_(password, salt, CONFIG.HASH_ITERATIONS);
  return bqDml('UPDATE ' + T('users') + ' SET password_hash = @h, password_salt = @s, hash_iterations = @it, ' +
    'must_change_password = @mc, failed_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP() WHERE user_id = @uid',
    { h: hash, s: salt, it: CONFIG.HASH_ITERATIONS, mc: !!mustChange, uid: userId });
}

function writeAudit_(table, recordId, action, oldVal, newVal, by) {
  bqDml('INSERT INTO ' + T('audit_log') + ' (log_id, table_name, record_id, action, old_value, new_value, changed_by, changed_at) ' +
    'VALUES (@id, @t, @r, @a, SAFE.PARSE_JSON(@o), SAFE.PARSE_JSON(@n), @by, CURRENT_TIMESTAMP())',
    { id: Utilities.getUuid(), t: table, r: recordId, a: action,
      o: { type: 'STRING', value: oldVal ? JSON.stringify(oldVal) : null },
      n: { type: 'STRING', value: newVal ? JSON.stringify(newVal) : null }, by: by });
}

/** Admin: set a specific temporary password for a user (user must change it at next login). */
function setUserPassword(token, username, tempPassword) {
  var sess = requireSession(token, { admin: true });
  validatePassword_(tempPassword);
  var u = bq('SELECT user_id FROM ' + T('users') + ' WHERE username = @u', { u: normUsername_(username) })[0];
  if (!u) throw new Error('User not found.');
  setPasswordInternal_(u.user_id, tempPassword, true);
  writeAudit_('users', u.user_id, 'password_set', null, { must_change_password: true }, sess.user_id);
  return true;
}

/** Admin: generate a random temporary password, returned once to the admin to pass on. */
function resetPassword(token, username) {
  var sess = requireSession(token, { admin: true });
  var u = bq('SELECT user_id FROM ' + T('users') + ' WHERE username = @u', { u: normUsername_(username) })[0];
  if (!u) throw new Error('User not found.');
  var temp = 'Bt' + Utilities.getUuid().replace(/-/g, '').slice(0, 8) + Math.floor(Math.random() * 90 + 10);
  setPasswordInternal_(u.user_id, temp, true);
  writeAudit_('users', u.user_id, 'password_reset', null, { must_change_password: true }, sess.user_id);
  return { username: normUsername_(username), temporary_password: temp };
}

/**
 * ONE-TIME bootstrap. Set Script Property BOOTSTRAP_PASSWORD first, then run from the editor:
 *   createFirstAdmin('ameyabondre', 'Ameya Bondre')   (use the wrapper runCreateFirstAdmin below)
 * Creates an admin with must_change_password = true, maps to all active centers, deletes the property.
 */
function createFirstAdmin(username, name) {
  username = username || 'ameyabondre';
  name = name || 'Ameya Bondre';
  var props = PropertiesService.getScriptProperties();
  var pw = props.getProperty('BOOTSTRAP_PASSWORD');
  if (!pw) throw new Error('Set Script Property BOOTSTRAP_PASSWORD first.');
  validatePassword_(pw);
  var uname = normUsername_(username);
  if (!name) throw new Error('Name required.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (bq('SELECT 1 AS x FROM ' + T('users') + ' WHERE username = @u', { u: uname }).length)
      throw new Error('Username already exists.');
    var uid = 'USR-' + Utilities.getUuid().slice(0, 8).toUpperCase();
    var salt = newSalt_();
    bqDml('INSERT INTO ' + T('users') + ' (user_id, username, email, name, role, active, sys_remarks, password_hash, password_salt, ' +
      'hash_iterations, must_change_password, failed_attempts, created_at, updated_at) VALUES ' +
      "(@uid, @u, NULL, @n, 'admin', TRUE, JSON '{}', @h, @s, @it, TRUE, 0, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())",
      { uid: uid, u: uname, n: name, h: hashPassword_(pw, salt, CONFIG.HASH_ITERATIONS), s: salt, it: CONFIG.HASH_ITERATIONS });
    bqDml('INSERT INTO ' + T('user_centers') + ' (user_id, center_id, is_primary, active, created_at) ' +
      'SELECT @uid, center_id, FALSE, TRUE, CURRENT_TIMESTAMP() FROM ' + T('centers') + ' WHERE active', { uid: uid });
    writeAudit_('users', uid, 'bootstrap_admin', null, { username: uname, role: 'admin' }, 'bootstrap');
    props.deleteProperty('BOOTSTRAP_PASSWORD');
    console.log('Created admin ' + uname + ' (' + uid + '). BOOTSTRAP_PASSWORD deleted.');
    return uid;
  } finally { lock.releaseLock(); }
}

/** Editor convenience: edit the two values, then Run. */
function runCreateFirstAdmin() {
  createFirstAdmin('ameyabondre', 'Ameya Bondre');
}

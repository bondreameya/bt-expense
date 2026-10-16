/** Shared server helpers: access checks, typed params, financial year, ID generation. */

var PAGE_SIZE = 50;

/** Returns array of center_ids the caller may act on. centerId '' / null = all of the caller's centers. */
function centersFor_(sess, centerId) {
  if (centerId) {
    if (sess.center_ids.indexOf(centerId) < 0) throw new Error('You do not have access to that center.');
    return [centerId];
  }
  if (!sess.center_ids.length) throw new Error('No centers are assigned to you. Ask an admin.');
  return sess.center_ids.slice();
}

function assertCenter_(sess, centerId) { centersFor_(sess, centerId || '__none__'); }

function S(v) { return { type: 'STRING', value: (v === undefined || v === '') ? null : v }; }
function SA(arr) { return { type: 'STRING', array: true, value: arr || [] }; }
function N(v) {
  if (v === null || v === undefined || v === '') return { type: 'NUMERIC', value: null };
  var n = Number(v);
  if (!isFinite(n)) throw new Error('Invalid amount: ' + v);
  return { type: 'NUMERIC', value: n.toFixed(2) };
}
function D(v) {
  if (v === null || v === undefined || v === '') return { type: 'DATE', value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('Invalid date: ' + v);
  return { type: 'DATE', value: v };
}
function B(v) { return { type: 'BOOL', value: !!v }; }

/** Financial year label for a YYYY-MM-DD date, Apr–Mar. 2026-05-01 -> '2627'; 2027-02-01 -> '2627'. */
function finYear_(dateStr) {
  var y = Number(dateStr.slice(0, 4)), m = Number(dateStr.slice(5, 7));
  var start = m >= 4 ? y : y - 1;
  return String(start % 100).padStart(2, '0') + String((start + 1) % 100).padStart(2, '0');
}

function todayStr_() { return Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd'); }
function fyStartStr_(dateStr) {
  var y = Number(dateStr.slice(0, 4)), m = Number(dateStr.slice(5, 7));
  return (m >= 4 ? y : y - 1) + '-04-01';
}

function centerById_(centerId) {
  var c = bq('SELECT center_id, center_code, name, TO_JSON_STRING(sys_remarks) AS sr FROM ' + T('centers') +
    ' WHERE center_id = @c', { c: centerId })[0];
  if (!c) throw new Error('Center not found.');
  c.sys_remarks = c.sr ? JSON.parse(c.sr) : {};
  delete c.sr;
  return c;
}

/** Next ID like PCM-EXP-2627-00042. Must be called while holding the script lock. */
function nextId_(centerCode, entityCode, dateStr) {
  var fy = finYear_(dateStr);
  bqDml('MERGE ' + T('id_counters') + ' t USING (SELECT @cc AS center_code, @et AS entity_type, @fy AS fin_year) s ' +
    'ON t.center_code = s.center_code AND t.entity_type = s.entity_type AND t.fin_year = s.fin_year ' +
    'WHEN MATCHED THEN UPDATE SET last_seq = t.last_seq + 1, updated_at = CURRENT_TIMESTAMP() ' +
    'WHEN NOT MATCHED THEN INSERT (center_code, entity_type, fin_year, last_seq, updated_at) VALUES (s.center_code, s.entity_type, s.fin_year, 1, CURRENT_TIMESTAMP())',
    { cc: centerCode, et: entityCode, fy: fy });
  var seq = bq('SELECT last_seq FROM ' + T('id_counters') + ' WHERE center_code = @cc AND entity_type = @et AND fin_year = @fy',
    { cc: centerCode, et: entityCode, fy: fy })[0].last_seq;
  return centerCode + '-' + entityCode + '-' + fy + '-' + String(seq).padStart(5, '0');
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) throw new Error('The system is busy. Please try again in a moment.');
  try { return fn(); } finally { lock.releaseLock(); }
}

function shortId_(prefix) { return prefix + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase(); }

function cleanStr_(v, max) {
  if (v === null || v === undefined) return null;
  v = String(v).trim();
  if (!v) return null;
  return v.slice(0, max || 500);
}

/**
 * Idempotency guard for creates. Same user + same client request_id within 10 min returns the first result
 * instead of creating a duplicate. A second call while the first is still running gets a friendly error.
 */
function idempotent_(sess, scope, requestId, fn) {
  if (!requestId) return fn();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(String(requestId))) throw new Error('Bad request id.');
  var cache = CacheService.getScriptCache(), key = 'idem_' + scope + '_' + sess.user_id + '_' + requestId;
  var claimed = withLock_(function () {
    var v = cache.get(key);
    if (v) return v;
    cache.put(key, 'PENDING', 600);
    return null;
  });
  if (claimed === 'PENDING') throw new Error('Already saving — please wait a moment.');
  if (claimed) return JSON.parse(claimed);
  try {
    var res = fn();
    cache.put(key, JSON.stringify(res), 600);
    return res;
  } catch (e) {
    cache.remove(key);
    throw e;
  }
}

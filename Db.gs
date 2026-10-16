/**
 * BigQuery helper. ALWAYS pass values via params — never concatenate user input into SQL.
 *   bq('SELECT * FROM ' + T('users') + ' WHERE username = @u', {u: 'ameya'})
 * Param values: string, number (int -> INT64, else FLOAT64), boolean, Date (TIMESTAMP),
 * arrays of those, or an explicit {type:'STRING'|'INT64'|..., value:x} (required for nulls
 * of non-STRING type, and for arrays of explicit type use {type:'STRING', array:true, value:[...]}).
 * Returns array of plain objects keyed by column name. DML returns [] (see bqDml for row count).
 */
function bq(sql, params) {
  return bqRaw_(sql, params).rows;
}

function bqDml(sql, params) {
  return bqRaw_(sql, params).affected;
}

function bqRaw_(sql, params) {
  var req = {
    query: sql,
    useLegacySql: false,
    location: CONFIG.LOCATION,
    parameterMode: 'NAMED',
    queryParameters: buildParams_(params || {}),
    timeoutMs: 30000,
    maxResults: 1000
  };
  var res = BigQuery.Jobs.query(req, CONFIG.PROJECT_ID);
  var jobId = res.jobReference.jobId;
  var start = Date.now();
  var sleep = 300;
  while (!res.jobComplete) {
    if (Date.now() - start > 240000) throw new Error('Query timed out');
    Utilities.sleep(sleep);
    sleep = Math.min(sleep * 2, 3000);
    res = BigQuery.Jobs.getQueryResults(CONFIG.PROJECT_ID, jobId, { location: CONFIG.LOCATION, timeoutMs: 30000 });
  }
  var fields = res.schema ? res.schema.fields : [];
  var rows = [];
  appendRows_(rows, res.rows, fields);
  var pageToken = res.pageToken;
  while (pageToken) {
    var page = BigQuery.Jobs.getQueryResults(CONFIG.PROJECT_ID, jobId, { location: CONFIG.LOCATION, pageToken: pageToken });
    appendRows_(rows, page.rows, fields);
    pageToken = page.pageToken;
  }
  return { rows: rows, affected: res.numDmlAffectedRows ? Number(res.numDmlAffectedRows) : 0 };
}

function appendRows_(out, rows, fields) {
  (rows || []).forEach(function (r) {
    var o = {};
    fields.forEach(function (f, i) { o[f.name] = convertCell_(r.f[i].v, f); });
    out.push(o);
  });
}

function convertCell_(v, f) {
  if (v === null || v === undefined) return null;
  if (f.mode === 'REPEATED') return v.map(function (x) { return convertCell_(x.v, { type: f.type, fields: f.fields }); });
  switch (f.type) {
    case 'INTEGER': case 'INT64': case 'FLOAT': case 'FLOAT64': case 'NUMERIC': case 'BIGNUMERIC': return Number(v);
    case 'BOOLEAN': case 'BOOL': return v === 'true';
    case 'TIMESTAMP': return new Date(Number(v) * 1000).toISOString();
    case 'RECORD': case 'STRUCT':
      var o = {};
      f.fields.forEach(function (sf, i) { o[sf.name] = convertCell_(v.f[i].v, sf); });
      return o;
    case 'JSON':
      try { return JSON.parse(v); } catch (e) { return v; }
    default: return v; // STRING, DATE, DATETIME, etc.
  }
}

function buildParams_(params) {
  return Object.keys(params).map(function (name) {
    var p = params[name];
    var explicit = p !== null && typeof p === 'object' && !(p instanceof Date) && !Array.isArray(p) && 'type' in p;
    var type, value, isArray;
    if (explicit) { type = p.type; value = p.value; isArray = !!p.array || Array.isArray(p.value); }
    else { value = p; isArray = Array.isArray(p); type = inferType_(isArray ? p[0] : p); }
    if (isArray) {
      return {
        name: name,
        parameterType: { type: 'ARRAY', arrayType: { type: type } },
        parameterValue: { arrayValues: (value || []).map(function (x) { return { value: toParamStr_(x) }; }) }
      };
    }
    return {
      name: name,
      parameterType: { type: type },
      parameterValue: value === null || value === undefined ? {} : { value: toParamStr_(value) }
    };
  });
}

function inferType_(v) {
  if (typeof v === 'boolean') return 'BOOL';
  if (typeof v === 'number') return Number.isInteger(v) ? 'INT64' : 'FLOAT64';
  if (v instanceof Date) return 'TIMESTAMP';
  return 'STRING';
}

function toParamStr_(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

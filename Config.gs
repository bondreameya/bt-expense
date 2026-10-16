/** Project-wide constants. Secrets never live here — use PropertiesService. */
var CONFIG = {
  PROJECT_ID: 'btdata',
  DATASET: 'expenses',
  LOCATION: 'us-central1',
  SESSION_MAX_AGE_SEC: 8 * 60 * 60,  // absolute session lifetime
  CACHE_TTL_SEC: 6 * 60 * 60,        // CacheService max; refreshed on each use
  MAX_FAILED_ATTEMPTS: 5,
  LOCKOUT_MINUTES: 15,
  HASH_ITERATIONS: 10000,
  MIN_PASSWORD_LENGTH: 8,
  APP_TITLE: 'BT Expense Tracker'
};

/** Fully qualified table name, e.g. T('users') -> `btdata.expenses.users` */
function T(name) {
  if (!/^[a-z_]+$/.test(name)) throw new Error('Bad table name');
  return '`' + CONFIG.PROJECT_ID + '.' + CONFIG.DATASET + '.' + name + '`';
}

function getSecret_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

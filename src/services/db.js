const { Pool, types } = require('pg');
const cfg = require('./config');
types.setTypeParser(20, (v) => parseInt(v, 10)); // bigint -> number (kobo stays well under 2^53)

const pool = new Pool({
  connectionString: cfg.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
  keepAlive: true,
});

// Hosted databases (like Neon) close idle connections. Without this listener Node treats that as a
// crash and the whole server stops. With it, the pool simply opens a fresh connection next time.
pool.on('error', (err) => console.error('[db] idle connection error (ignored):', err.message));

// Safety net: log unexpected background errors instead of shutting the server down.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err && err.message ? err.message : err));

async function withTx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
module.exports = { pool, withTx };
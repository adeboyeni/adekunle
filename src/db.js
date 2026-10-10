const { Pool, types } = require('pg');
const cfg = require('./config');
types.setTypeParser(20, (v) => parseInt(v, 10)); // bigint -> number (kobo stays well under 2^53)
const pool = new Pool({ connectionString: cfg.databaseUrl });

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

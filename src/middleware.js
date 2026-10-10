const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cfg = require('./config');
const { pool } = require('./db');
const { HttpError } = require('./util');

function requireAuth(req, _res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return next(new HttpError(401, 'Missing token'));
  try {
    req.user = { id: jwt.verify(h.slice(7), cfg.jwtSecret).sub };
    next();
  } catch (_) {
    next(new HttpError(401, 'Invalid or expired token'));
  }
}

// Checks the 4-digit transaction PIN sent in the request body. Locks for 15 min after 5 wrong tries.
async function requirePin(req, _res, next) {
  try {
    const pin = String((req.body && req.body.pin) || '');
    const r = await pool.query('SELECT pin_hash, pin_attempts, pin_locked_until FROM users WHERE id=$1', [req.user.id]);
    const u = r.rows[0];
    if (!u || !u.pin_hash) throw new HttpError(403, 'Set a transaction PIN first');
    if (u.pin_locked_until && new Date(u.pin_locked_until) > new Date()) throw new HttpError(429, 'PIN locked. Try again later');
    if (!(await bcrypt.compare(pin, u.pin_hash))) {
      await pool.query(
        `UPDATE users SET
           pin_locked_until = CASE WHEN pin_attempts + 1 >= 5 THEN now() + interval '15 minutes' ELSE pin_locked_until END,
           pin_attempts = CASE WHEN pin_attempts + 1 >= 5 THEN 0 ELSE pin_attempts + 1 END WHERE id=$1`, [req.user.id]);
      throw new HttpError(403, 'Incorrect PIN');
    }
    await pool.query('UPDATE users SET pin_attempts=0, pin_locked_until=NULL WHERE id=$1', [req.user.id]);
    next();
  } catch (e) { next(e); }
}

function requireIdempotencyKey(req, _res, next) {
  const k = req.headers['idempotency-key'];
  if (!k || k.length < 8 || k.length > 100) return next(new HttpError(400, 'Idempotency-Key header required (unique per purchase attempt)'));
  req.idemKey = k;
  next();
}
module.exports = { requireAuth, requirePin, requireIdempotencyKey };

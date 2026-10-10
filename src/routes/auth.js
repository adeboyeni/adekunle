const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const cfg = require('../config');
const { pool, withTx } = require('../db');
const { HttpError, asyncH } = require('../util');
const { requireAuth } = require('../middleware');

const sign = (id) => jwt.sign({ sub: id }, cfg.jwtSecret, { expiresIn: '12h' });
const phoneRe = /^0[789][01]\d{8}$/;

router.post('/register', asyncH(async (req, res) => {
  const b = z.object({ email: z.string().email(), phone: z.string().regex(phoneRe), password: z.string().min(8) }).parse(req.body);
  const hash = await bcrypt.hash(b.password, 12);
  try {
    const id = await withTx(async (c) => {
      const u = await c.query('INSERT INTO users (email,phone,password_hash) VALUES ($1,$2,$3) RETURNING id', [b.email.toLowerCase(), b.phone, hash]);
      await c.query('INSERT INTO wallets (user_id) VALUES ($1)', [u.rows[0].id]);
      return u.rows[0].id;
    });
    res.status(201).json({ token: sign(id) });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'Email or phone already registered');
    throw e;
  }
}));

router.post('/login', asyncH(async (req, res) => {
  const b = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
  const r = await pool.query('SELECT id, password_hash, pin_hash IS NOT NULL AS has_pin FROM users WHERE email=$1', [b.email.toLowerCase()]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(b.password, u.password_hash))) throw new HttpError(401, 'Invalid email or password');
  res.json({ token: sign(u.id), hasPin: u.has_pin });
}));

// Set the PIN once; changing it requires the account password.
router.post('/pin', requireAuth, asyncH(async (req, res) => {
  const b = z.object({ pin: z.string().regex(/^\d{4}$/), password: z.string().optional() }).parse(req.body);
  const r = await pool.query('SELECT password_hash, pin_hash FROM users WHERE id=$1', [req.user.id]);
  const u = r.rows[0];
  if (u.pin_hash && !(b.password && (await bcrypt.compare(b.password, u.password_hash)))) throw new HttpError(403, 'Password required to change PIN');
  await pool.query('UPDATE users SET pin_hash=$2, pin_attempts=0, pin_locked_until=NULL WHERE id=$1', [req.user.id, await bcrypt.hash(b.pin, 10)]);
  res.json({ ok: true });
}));
module.exports = router;

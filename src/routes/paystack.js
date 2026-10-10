// Wallet funding via Paystack. The webhook is the only thing that credits a wallet.
const router = require('express').Router();
const crypto = require('crypto');
const { z } = require('zod');
const cfg = require('../config');
const { pool, withTx } = require('../db');
const wallet = require('../services/wallet');
const { HttpError, asyncH, fromKobo } = require('../util');
const { requireAuth } = require('../middleware');

// Start a funding: returns a Paystack checkout URL for the app to open.
router.post('/fund', requireAuth, asyncH(async (req, res) => {
  const b = z.object({ amount: z.number().int().min(100).max(1000000) }).parse(req.body); // naira
  const u = await pool.query('SELECT email FROM users WHERE id=$1', [req.user.id]);
  const reference = 'SS' + crypto.randomBytes(12).toString('hex');
  await pool.query(
    `INSERT INTO transactions (user_id,type,amount_kobo,status,idempotency_key) VALUES ($1,'funding',$2,'pending',$3)`,
    [req.user.id, b.amount * 100, reference]
  );
  const r = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.paystack.secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: u.rows[0].email, amount: b.amount * 100, reference, callback_url: cfg.paystack.callbackUrl, currency: 'NGN' }),
  });
  const j = await r.json();
  if (!j.status) throw new HttpError(502, 'Could not start payment');
  res.json({ reference, authorizationUrl: j.data.authorization_url });
}));

// Mounted with express.raw() so the signature can be checked against the exact bytes Paystack sent.
async function webhook(req, res) {
  const sig = req.headers['x-paystack-signature'];
  const expected = crypto.createHmac('sha512', cfg.paystack.secret).update(req.body).digest('hex');
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.sendStatus(401);
  const event = JSON.parse(req.body.toString('utf8'));
  if (event.event === 'charge.success') {
    const d = event.data;
    await withTx(async (c) => {
      const t = await c.query(`SELECT * FROM transactions WHERE type='funding' AND idempotency_key=$1 FOR UPDATE`, [d.reference]);
      const tx = t.rows[0];
      if (!tx || tx.status !== 'pending') return; // unknown reference or already credited
      if (d.currency !== 'NGN' || d.amount !== tx.amount_kobo) { // never credit a mismatched amount
        await c.query(`UPDATE transactions SET message='amount mismatch', updated_at=now() WHERE id=$1`, [tx.id]);
        return;
      }
      await c.query(`UPDATE transactions SET status='completed', message='Wallet funded', updated_at=now() WHERE id=$1`, [tx.id]);
      await wallet.credit(c, tx.user_id, tx.amount_kobo, tx.id, 'wallet funding (Paystack)');
    });
  }
  res.sendStatus(200); // always ack valid signatures so Paystack stops retrying
}
module.exports = { router, webhook };

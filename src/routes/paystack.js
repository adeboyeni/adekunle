// Wallet funding via Paystack.
// A wallet is only ever credited after WE ask Paystack "was this reference really paid, and how much?"
// (the webhook just triggers that check, and /wallet/verify-pending lets the app trigger it too).
const router = require('express').Router();
const crypto = require('crypto');
const { z } = require('zod');
const cfg = require('../config');
const { pool, withTx } = require('../db');
const wallet = require('../services/wallet');
const { HttpError, asyncH } = require('../util');
const { requireAuth } = require('../middleware');

async function paystackVerify(reference) {
  const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${cfg.paystack.secret}` },
  });
  const j = await r.json().catch(() => null);
  return j && j.status ? j.data : null; // null = unknown reference or Paystack problem
}

// Credits the wallet once, if Paystack confirms payment. Safe to call many times for the same reference.
async function settleFunding(reference) {
  const t = await pool.query(`SELECT * FROM transactions WHERE type='funding' AND idempotency_key=$1`, [reference]);
  const tx = t.rows[0];
  if (!tx) return 'unknown';
  if (tx.status !== 'pending') return tx.status;

  const d = await paystackVerify(reference);
  if (!d || d.status !== 'success') return 'pending'; // not paid (yet)

  const paid = d.amount; // kobo
  if (d.currency !== 'NGN' || paid < tx.amount_kobo) {
    const note = `paid ${paid} ${d.currency}, expected ${tx.amount_kobo} NGN kobo`;
    console.warn(`[funding] ${reference}: ${note}`);
    await pool.query(`UPDATE transactions SET message=$2, updated_at=now() WHERE id=$1 AND status='pending'`, [tx.id, note]);
    return 'pending';
  }

  // Credit what the customer asked to fund. If Paystack added fees on top, the customer paid them; we don't credit them.
  await withTx(async (c) => {
    const l = await c.query('SELECT status FROM transactions WHERE id=$1 FOR UPDATE', [tx.id]);
    if (l.rows[0].status !== 'pending') return;
    await c.query(`UPDATE transactions SET status='completed', message=$2, updated_at=now() WHERE id=$1`,
      [tx.id, paid > tx.amount_kobo ? 'Wallet funded (payment included fees)' : 'Wallet funded']);
    await wallet.credit(c, tx.user_id, tx.amount_kobo, tx.id, 'wallet funding (Paystack)');
  });
  return 'completed';
}

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
  const j = await r.json().catch(() => null);
  if (!j || !j.status) {
    console.error('[paystack] initialize failed:', j && j.message);
    throw new HttpError(502, 'Could not start payment');
  }
  res.json({ reference, authorizationUrl: j.data.authorization_url });
}));

// The app calls this when the customer comes back from paying, so a missed webhook never leaves them uncredited.
router.post('/verify-pending', requireAuth, asyncH(async (req, res) => {
  const r = await pool.query(
    `SELECT idempotency_key FROM transactions WHERE user_id=$1 AND type='funding' AND status='pending'
     AND created_at > now() - interval '24 hours' ORDER BY created_at DESC LIMIT 5`, [req.user.id]);
  const results = [];
  for (const row of r.rows) results.push(await settleFunding(row.idempotency_key));
  res.json({ checked: results.length, credited: results.filter((s) => s === 'completed').length });
}));

// Mounted with express.raw() so the signature can be checked against the exact bytes Paystack sent.
async function webhook(req, res) {
  const sig = req.headers['x-paystack-signature'];
  const expected = crypto.createHmac('sha512', cfg.paystack.secret).update(req.body).digest('hex');
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.sendStatus(401);
  const event = JSON.parse(req.body.toString('utf8'));
  if (event.event === 'charge.success' && event.data && event.data.reference) {
    await settleFunding(event.data.reference); // verifies with Paystack itself; throws -> 500 -> Paystack retries
  }
  res.sendStatus(200);
}
module.exports = { router, webhook };

const router = require('express').Router();
const { z } = require('zod');
const { pool } = require('../db');
const { HttpError, asyncH, fromKobo } = require('../util');
const { requireAuth, requirePin, requireIdempotencyKey } = require('../middleware');
const { purchase } = require('../services/purchase');
const plans = require('../services/plans');
const ag = require('../arewagate');

router.use(requireAuth);

const phone = z.string().regex(/^0[789][01]\d{8}$/, 'Invalid Nigerian phone number');
// Airtime and data use different codes for 9mobile in ArewaGate's API; keep the mapping in one place.
const airtimeNetworks = ['mtn', 'glo', 'airtel', '9mobile'];
const airtimeCode = (n) => (n === '9mobile' ? 'etisalat' : n);

const view = (t) => ({
  id: t.id, type: t.type, status: t.status, amount: fromKobo(t.amount_kobo),
  beneficiary: t.beneficiary, message: t.message, createdAt: t.created_at,
});

router.get('/wallet', asyncH(async (req, res) => {
  const r = await pool.query('SELECT balance_kobo FROM wallets WHERE user_id=$1', [req.user.id]);
  res.json({ balance: fromKobo(r.rows[0].balance_kobo), currency: 'NGN' });
}));

router.get('/data/plan-types/:network', asyncH(async (req, res) => {
  const network = z.enum(airtimeNetworks).parse(req.params.network);
  const r = await ag.get(`/data-subscription/plan-types/${network}`);
  if (!r.body || !r.body.success) throw new HttpError(502, 'Could not load plan types');
  res.json(r.body.data);
}));

router.get('/data/plans', asyncH(async (req, res) => {
  const q = z.object({ network: z.enum(airtimeNetworks), plan_type: z.string().min(2) }).parse(req.query);
  const list = await plans.getPlans(q.network, q.plan_type);
  res.json(list.map((p) => ({ id: p.id, name: p.name, validity: p.validity, price: fromKobo(p.priceKobo) })));
}));

router.post('/data/buy', requireIdempotencyKey, requirePin, asyncH(async (req, res) => {
  const b = z.object({ network: z.enum(airtimeNetworks), plan_type: z.string(), plan_id: z.string(), phone_number: phone }).parse(req.body);
  const plan = await plans.findPlan(b.network, b.plan_type, b.plan_id);
  if (!plan) throw new HttpError(404, 'Plan not available');
  const tx = await purchase({
    userId: req.user.id, idemKey: req.idemKey, type: 'data', beneficiary: b.phone_number, priceKobo: plan.priceKobo,
    providerRequest: { endpoint: '/data-subscription/buy-data', payload: { network: b.network, plan_type: b.plan_type, plan_id: b.plan_id, phone_number: b.phone_number } },
    meta: { plan: plan.name, network: b.network },
  });
  res.status(tx.status === 'failed' ? 422 : 200).json(view(tx));
}));

router.post('/airtime/buy', requireIdempotencyKey, requirePin, asyncH(async (req, res) => {
  const b = z.object({ network: z.enum(airtimeNetworks), phone, amount: z.number().int().min(50).max(50000) }).parse(req.body);
  const tx = await purchase({
    userId: req.user.id, idemKey: req.idemKey, type: 'airtime', beneficiary: b.phone, priceKobo: b.amount * 100,
    providerRequest: { endpoint: '/airtime/purchase', payload: { phone: b.phone, network: airtimeCode(b.network), amount: b.amount } },
    meta: { network: b.network },
  });
  res.status(tx.status === 'failed' ? 422 : 200).json(view(tx));
}));

router.get('/transactions', asyncH(async (req, res) => {
  const r = await pool.query('SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json(r.rows.map(view));
}));

router.get('/transactions/:id', asyncH(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const r = await pool.query('SELECT * FROM transactions WHERE id=$1 AND user_id=$2', [id, req.user.id]);
  if (!r.rowCount) throw new HttpError(404, 'Not found');
  res.json(view(r.rows[0]));
}));
module.exports = router;

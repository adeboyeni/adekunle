// Run once with your live keys to see ArewaGate's REAL response shapes (the spec leaves plan lists undocumented).
// Usage: npm run probe   (needs the AREWAGATE_* variables in .env; DATABASE_URL/JWT_SECRET/PAYSTACK can be dummies)
require('dotenv').config();
const ag = require('../src/arewagate');
const show = (label, r) => console.log(`\n=== ${label} (HTTP ${r.status}) ===\n`, JSON.stringify(r.body, null, 2).slice(0, 2500));
(async () => {
  show('wallet', await ag.get('/user/wallet'));
  show('airtime networks', await ag.get('/airtime/networks'));
  show('MTN plan types', await ag.get('/data-subscription/plan-types/mtn'));
  const t = await ag.get('/data-subscription/plan-types/mtn');
  const first = t.body && t.body.data && (Array.isArray(t.body.data) ? t.body.data[0] : (t.body.data.plan_types || [])[0]);
  const slug = first && (first.slug || first);
  if (slug) show(`MTN plans (${slug})`, await ag.post('/data-subscription/get-plans', { network: 'mtn', plan_type: slug }));
})().catch((e) => { console.error(e); process.exit(1); });

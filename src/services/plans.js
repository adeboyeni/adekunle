// Data plan catalogue from ArewaGate with your margin applied. Prices are always computed server-side.
const ag = require('../arewagate');
const cfg = require('../config');
const { toKobo } = require('../util');

const cache = new Map(); // key -> { at, plans }
const TTL = 10 * 60 * 1000;

function normalize(body) {
  const d = body && body.data;
  const raw = Array.isArray(d) ? d : (d && (d.plans || d.data)) || [];
  return raw
    .map((p) => ({
      id: String(p.id ?? p.plan_id ?? p.code ?? ''),
      name: String(p.planName ?? p.name ?? p.plan ?? p.plan_name ?? p.title ?? '').trim(),
      // ArewaGate sends things like "--- 7 days" or "---30 days": strip the leading dashes
      validity: p.validity ? String(p.validity).replace(/^[\s-]+/, '').trim() : null,
      costKobo: toKobo(p.amount ?? p.price ?? p.cost ?? 0),
    }))
    .filter((p) => p.id && p.costKobo > 0);
}

const sellKobo = (costKobo) => Math.ceil((costKobo * (1 + cfg.marginPercentData / 100)) / 100) * 100; // round up to next naira

async function getPlans(network, planType, { force = false } = {}) {
  const key = `${network}:${planType}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.plans;
  const res = await ag.post('/data-subscription/get-plans', { network, plan_type: planType });
  if (!res.body || !res.body.success) throw new Error(`Could not load plans: ${res.body && res.body.message}`);
  const plans = normalize(res.body).map((p) => ({ ...p, priceKobo: sellKobo(p.costKobo) }));
  cache.set(key, { at: Date.now(), plans });
  return plans;
}

async function findPlan(network, planType, planId) {
  let plans = await getPlans(network, planType);
  let p = plans.find((x) => x.id === String(planId));
  if (!p) { plans = await getPlans(network, planType, { force: true }); p = plans.find((x) => x.id === String(planId)); }
  return p || null;
}
module.exports = { getPlans, findPlan, normalize };
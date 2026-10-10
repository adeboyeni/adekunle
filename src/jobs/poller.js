// Background jobs: resolve 'processing' transactions and warn when your ArewaGate float runs low.
const { pool } = require('../db');
const { reconcile } = require('../services/purchase');
const ag = require('../arewagate');
const cfg = require('../config');

let busy = false;
async function resolveProcessing() {
  if (busy) return;
  busy = true;
  try {
    const r = await pool.query(
      `SELECT * FROM transactions WHERE status='processing' AND type <> 'funding' AND updated_at < now() - interval '20 seconds'
       ORDER BY updated_at LIMIT 50`);
    for (const tx of r.rows) {
      try {
        const done = await reconcile(tx);
        if (!done) await pool.query('UPDATE transactions SET updated_at=now() WHERE id=$1', [tx.id]);
        if (!done && Date.now() - new Date(tx.created_at) > 6 * 3600 * 1000) console.warn(`[ALERT] tx ${tx.id} still processing after 6h - check manually`);
      } catch (e) { console.error(`reconcile ${tx.id} failed:`, e.message); }
    }
  } finally { busy = false; }
}

async function checkProviderBalance() {
  try {
    const r = await ag.get('/user/wallet');
    const bal = r.body && r.body.data && Math.round(parseFloat(r.body.data.balance) * 100);
    if (bal != null && bal < cfg.ag.lowBalanceKobo) console.warn(`[ALERT] ArewaGate balance low: NGN ${(bal / 100).toFixed(2)} - top up in their dashboard`); // TODO: send WhatsApp/email
  } catch (e) { console.error('balance check failed:', e.message); }
}

function start() {
  setInterval(resolveProcessing, 30 * 1000);
  setInterval(checkProviderBalance, 5 * 60 * 1000);
  checkProviderBalance();
}
module.exports = { start };

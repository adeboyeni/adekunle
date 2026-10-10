// Core purchase flow: debit -> call provider -> settle (complete / keep processing / refund).
// A refund can only ever happen once because settle() only acts when the row is still pending/processing.
const { pool, withTx } = require('../db');
const ag = require('../arewagate');
const wallet = require('./wallet');

async function createAndDebit({ userId, idemKey, type, beneficiary, priceKobo, providerRequest, meta = {} }) {
  return withTx(async (c) => {
    const ins = await c.query(
      `INSERT INTO transactions (user_id,type,beneficiary,amount_kobo,status,idempotency_key,meta)
       VALUES ($1,$2,$3,$4,'pending',$5,$6) ON CONFLICT (user_id,idempotency_key) DO NOTHING RETURNING *`,
      [userId, type, beneficiary, priceKobo, idemKey, { ...meta, providerRequest }]
    );
    if (!ins.rowCount) {
      const ex = await c.query('SELECT * FROM transactions WHERE user_id=$1 AND idempotency_key=$2', [userId, idemKey]);
      return { tx: ex.rows[0], replay: true };
    }
    await wallet.debit(c, userId, priceKobo, ins.rows[0].id, `${type} purchase`);
    return { tx: ins.rows[0], replay: false };
  });
}

async function settle(txId, outcome) {
  if (outcome.state === 'unknown') {
    const r = await pool.query(`UPDATE transactions SET status='processing', message=$2, updated_at=now() WHERE id=$1 AND status IN ('pending','processing') RETURNING *`, [txId, outcome.message || null]);
    return r.rows[0];
  }
  if (outcome.state === 'completed' || outcome.state === 'processing') {
    const r = await pool.query(
      `UPDATE transactions SET status=$2, provider_reference=COALESCE($3,provider_reference), cost_kobo=COALESCE($4,cost_kobo), message=$5, updated_at=now()
       WHERE id=$1 AND status IN ('pending','processing') RETURNING *`,
      [txId, outcome.state, outcome.providerRef || null, outcome.costKobo ?? null, outcome.message || null]
    );
    return r.rows[0];
  }
  // failed -> mark failed and refund, atomically, exactly once
  return withTx(async (c) => {
    const r = await c.query(
      `UPDATE transactions SET status='failed', message=$2, updated_at=now() WHERE id=$1 AND status IN ('pending','processing') RETURNING *`,
      [txId, outcome.message || 'Failed']
    );
    if (r.rowCount) await wallet.credit(c, r.rows[0].user_id, r.rows[0].amount_kobo, txId, 'refund: purchase failed');
    return r.rows[0];
  });
}

async function callProvider(tx) {
  const { endpoint, payload } = tx.meta.providerRequest;
  try {
    const res = await ag.post(endpoint, payload, { idempotencyKey: tx.id });
    return ag.classify(res);
  } catch (e) {
    if (e instanceof ag.ProviderUnknownError) return { state: 'unknown', message: e.message };
    throw e;
  }
}

async function purchase(args) {
  const { tx, replay } = await createAndDebit(args);
  if (replay) return tx;
  const outcome = await callProvider(tx);
  return (await settle(tx.id, outcome)) || tx;
}

// Used by the poller to resolve 'processing' transactions.
async function reconcile(tx) {
  if (tx.provider_reference) {
    const res = await ag.get(`/transaction/request/${encodeURIComponent(tx.provider_reference)}`);
    const b = res.body || {};
    if (b.success && b.data) {
      const s = b.data.status;
      if (s === 'completed') return settle(tx.id, { state: 'completed', message: (b.data.response_payload && b.data.response_payload.message) || b.message });
      if (s === 'failed') return settle(tx.id, { state: 'failed', message: (b.data.response_payload && b.data.response_payload.message) || 'Failed at provider' });
    }
    return null; // still processing
  }
  // We never got a provider reference (timeout etc). Replaying with the SAME idempotency key is safe:
  // ArewaGate returns the original result, or processes it once if it never arrived.
  return settle(tx.id, await callProvider(tx));
}

module.exports = { purchase, reconcile, settle };

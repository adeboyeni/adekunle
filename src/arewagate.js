// ArewaGate client: key-to-token auth with caching, timeouts, idempotency.
const cfg = require('./config');

class ProviderUnknownError extends Error {} // outcome unknown (timeout / network / unclear 5xx)

let token = null;
let tokenExpiresAt = 0;
let inflight = null;

async function rawFetch(method, path, { body, headers = {}, timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.ag.base + path, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { status: res.status, body: json };
  } catch (e) {
    throw new ProviderUnknownError(`ArewaGate request failed: ${e.name} ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function refreshToken() {
  const basic = Buffer.from(`${cfg.ag.pk}:${cfg.ag.sk}`).toString('base64');
  const res = await rawFetch('POST', '/auth/token', { headers: { Authorization: `Basic ${basic}` } });
  if (!res.body || !res.body.success) throw new Error(`ArewaGate auth failed (HTTP ${res.status}): ${res.body && res.body.message}`);
  token = res.body.data.access_token;
  tokenExpiresAt = Date.now() + (res.body.data.expires_in - 300) * 1000; // refresh 5 min early
}

async function getToken(force = false) {
  if (!force && token && Date.now() < tokenExpiresAt) return token;
  if (!inflight) inflight = refreshToken().finally(() => { inflight = null; });
  await inflight;
  return token;
}

async function call(method, path, { body, idempotencyKey } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await getToken(attempt > 0);
    const res = await rawFetch(method, path, {
      body,
      headers: { Authorization: `Bearer ${t}`, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    });
    const code = res.body && res.body.response_code;
    if (res.status === 401 && ['03', '10', '01'].includes(code) && attempt === 0) continue; // token expired -> retry once
    return res;
  }
}

/**
 * Decide what a purchase response means.
 * returns { state: 'completed'|'processing'|'failed'|'unknown', providerRef, costKobo, message }
 */
function classify(res) {
  const b = res.body || {};
  const code = b.response_code;
  if (b.success && b.data) {
    const s = b.data.status;
    const out = {
      providerRef: b.data.transaction_reference || null,
      costKobo: b.data.amount != null ? Math.round(parseFloat(b.data.amount) * 100) : null,
      message: b.message,
    };
    if (s === 'completed') return { state: 'completed', ...out };
    if (s === 'failed') return { state: 'failed', ...out };
    return { state: 'processing', ...out }; // processing / pending / anything unexpected: keep debit, poll
  }
  if (code === '07') return { state: 'unknown', message: 'duplicate request' };
  if (res.status >= 500 && code !== '09') return { state: 'unknown', message: b.message || `HTTP ${res.status}` };
  // 4xx, or 503 "service unavailable": request was not processed -> safe to refund
  const reason = b.message || `Provider error (code ${code})`;
  if (/insufficient/i.test(reason)) {
    console.error('[ALERT] ArewaGate wallet too low to fulfil an order - top up now');
    return { state: 'failed', message: 'Service temporarily unavailable. You have not been charged.', providerCode: code };
  }
  return { state: 'failed', message: reason, providerCode: code };
}

module.exports = {
  ProviderUnknownError,
  classify,
  get: (path) => call('GET', path),
  post: (path, body, opts = {}) => call('POST', path, { body, ...opts }),
};

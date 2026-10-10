// Wallet helpers. Always call inside withTx with the row locked.
const { HttpError } = require('../util');

async function lockWallet(c, userId) {
  const r = await c.query('SELECT balance_kobo FROM wallets WHERE user_id=$1 FOR UPDATE', [userId]);
  if (!r.rowCount) throw new HttpError(404, 'Wallet not found');
  return r.rows[0].balance_kobo;
}

async function debit(c, userId, kobo, txId, reason) {
  const bal = await lockWallet(c, userId);
  if (bal < kobo) throw new HttpError(402, 'Insufficient wallet balance');
  const r = await c.query('UPDATE wallets SET balance_kobo = balance_kobo - $2, updated_at=now() WHERE user_id=$1 RETURNING balance_kobo', [userId, kobo]);
  await c.query(`INSERT INTO ledger (user_id, transaction_id, direction, reason, amount_kobo, balance_after_kobo) VALUES ($1,$2,'debit',$3,$4,$5)`,
    [userId, txId, reason, kobo, r.rows[0].balance_kobo]);
}

async function credit(c, userId, kobo, txId, reason) {
  await lockWallet(c, userId);
  const r = await c.query('UPDATE wallets SET balance_kobo = balance_kobo + $2, updated_at=now() WHERE user_id=$1 RETURNING balance_kobo', [userId, kobo]);
  await c.query(`INSERT INTO ledger (user_id, transaction_id, direction, reason, amount_kobo, balance_after_kobo) VALUES ($1,$2,'credit',$3,$4,$5)`,
    [userId, txId, reason, kobo, r.rows[0].balance_kobo]);
}
module.exports = { debit, credit };

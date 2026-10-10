require('dotenv').config();
const need = (k) => { if (!process.env[k]) throw new Error(`Missing env var ${k}`); return process.env[k]; };
module.exports = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: need('DATABASE_URL'),
  jwtSecret: need('JWT_SECRET'),
  ag: {
    base: process.env.AREWAGATE_BASE_URL || 'https://api.arewagate.com/api/v1',
    pk: need('AREWAGATE_PUBLIC_KEY'),
    sk: need('AREWAGATE_SECRET_KEY'),
    lowBalanceKobo: Math.round(Number(process.env.AREWAGATE_LOW_BALANCE_NGN || 20000) * 100),
  },
  paystack: {
    secret: need('PAYSTACK_SECRET_KEY'),
    callbackUrl: process.env.PAYSTACK_CALLBACK_URL || undefined,
  },
  marginPercentData: Number(process.env.MARGIN_PERCENT_DATA || 5),
};

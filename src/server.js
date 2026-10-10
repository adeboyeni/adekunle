const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ZodError } = require('zod');
const cfg = require('./config');
const paystack = require('./routes/paystack');
const poller = require('./jobs/poller');

const app = express();
app.set('trust proxy', 1);
app.use(helmet());

// Webhook needs the raw body, so it is registered BEFORE express.json().
app.post('/webhooks/paystack', express.raw({ type: '*/*' }), (req, res, next) => paystack.webhook(req, res).catch(next));

app.use(express.json({ limit: '50kb' }));
app.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 }), require('./routes/auth'));
app.use('/wallet', paystack.router);
app.use('/vtu', rateLimit({ windowMs: 60 * 1000, limit: 60 }), require('./routes/vtu'));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.use((err, _req, res, _next) => {
  if (err instanceof ZodError) return res.status(422).json({ error: 'Validation failed', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(cfg.port, () => { console.log(`Softsub API on :${cfg.port}`); poller.start(); });

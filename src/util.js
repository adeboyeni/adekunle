class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const toKobo = (v) => Math.round(parseFloat(v) * 100);
const fromKobo = (k) => (k / 100).toFixed(2);
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
module.exports = { HttpError, toKobo, fromKobo, asyncH };

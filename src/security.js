'use strict';
// Small in-memory security helpers: real client IP behind Render/Cloudflare and fixed-window rate limits.
const TRUST_CF = process.env.TRUST_CF === '1' || process.env.NODE_ENV === 'production';
// On Render every request arrives via Cloudflare, which overwrites CF-Connecting-IP with the real client IP
// (clients cannot spoof it). Locally we fall back to the socket / proxy IP.
function clientIp(req) {
  const cf = TRUST_CF && req.get('cf-connecting-ip');
  return (cf && /^[0-9a-f:.]{3,45}$/i.test(cf) ? cf : req.ip) || 'unknown';
}
const buckets = new Map();
function hit(key, limit, windowMs) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || now - b.start >= windowMs) { b = { start: now, n: 0 }; buckets.set(key, b); }
  b.n += 1;
  return { ok: b.n <= limit, retryAfter: Math.ceil((b.start + windowMs - now) / 1000) };
}
function peek(key, windowMs) { const b = buckets.get(key); return b && Date.now() - b.start < windowMs ? b.n : 0; }
function reset(key) { buckets.delete(key); }
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.start > 3600000) buckets.delete(k); }, 600000).unref();
// Express middleware factory
const limit = (name, max, windowMs, keyFn) => (req, res, next) => {
  const r = hit(`${name}:${keyFn ? keyFn(req) : clientIp(req)}`, max, windowMs);
  if (r.ok) return next();
  res.set('Retry-After', String(r.retryAfter));
  res.status(429).json({ error: 'Too many requests — please slow down and try again shortly.' });
};
function resetMatching(re) { for (const k of [...buckets.keys()]) if (re.test(k)) buckets.delete(k); }
function peekMatching(re, windowMs) { let m = 0; const now = Date.now(); for (const [k, b] of buckets) if (re.test(k) && now - b.start < windowMs) m = Math.max(m, b.n); return m; }
module.exports = { clientIp, hit, peek, reset, resetMatching, peekMatching, limit };

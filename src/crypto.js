'use strict';
// Field-level encryption (AES-256-GCM) for sensitive profile data and uploaded document photos.
// Key comes from DATA_KEY env (64 hex chars) or a server-only key file created on first run.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function loadKey() {
  if (process.env.DATA_KEY) return Buffer.from(process.env.DATA_KEY, 'hex');
  const p = path.join(__dirname, '..', 'data', 'data.key');
  if (!fs.existsSync(p)) fs.writeFileSync(p, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'hex');
}
const KEY = loadKey();

function encrypt(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}
function decrypt(buf) {
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}
const encJSON = (o) => encrypt(Buffer.from(JSON.stringify(o))).toString('base64');
const decJSON = (s) => JSON.parse(decrypt(Buffer.from(s, 'base64')).toString());

// Password hashing: scrypt with per-user salt
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const calc = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

module.exports = { encrypt, decrypt, encJSON, decJSON, hashPassword, verifyPassword, sha256, token };

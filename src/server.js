'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');
const db = require('./db');
const C = require('./crypto');
const V = require('./validate');
const { evaluate } = require('./status');
const assistant = require('./assistant');
const { seed, SEED_VERSION, syncPasswords } = require('./seed');
const SEC = require('./security');
const TK = require('./tickets');
const OWNER = require('./owner');

const PORT = Number(process.env.PORT || 4300);
const DEMO_MODE = process.env.DEMO_MODE !== '0';
const SESSION_HOURS = 12;
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
let SEEDED_NOW = false;
// Demo auto-setup (idempotent). Demo mode is on unless DEMO_MODE=0. The demo data set is (re)built only when there is no demo
// data yet or the seed version changed — never on a plain restart — and real accounts (owner + invited) are always kept.
const countUsers = (where) => db.prepare(`SELECT COUNT(*) n FROM users WHERE ${where}`).get().n;
const demoNeedsSeed = () => !countUsers("kind != 'owner'") || (DEMO_MODE && (db.meta.get('seed_version') !== SEED_VERSION || !countUsers("kind = 'demo'")));
if (demoNeedsSeed()) {
  for (const f of fs.readdirSync(UPLOAD_DIR)) fs.unlinkSync(path.join(UPLOAD_DIR, f));
  seed(); console.log(`Seeded demo data v${SEED_VERSION}`); SEEDED_NOW = true;
}
if (DEMO_MODE) { const n = syncPasswords(); if (n) console.log(`Demo account passwords updated from env (${n} accounts)`); }
OWNER.ensure();
function resetDemo(reason) {
  for (const f of fs.readdirSync(UPLOAD_DIR)) fs.unlinkSync(path.join(UPLOAD_DIR, f));
  seed(); TK.seedDemo(); OWNER.ensure();
  db.prepare("INSERT INTO audit_log (user_id, action, details, ip) VALUES (NULL, 'demo_reseed', ?, '')").run(reason);
  console.log(`Demo reseeded: ${reason}`);
}
// Self-restoring demo: reseed every night at 03:00 America/Los_Angeles (DST-aware), once per day.
if (DEMO_MODE) setInterval(() => {
  const f = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const day = `${f.year}-${f.month}-${f.day}`;
  if (f.hour === '03' && db.meta.get('last_nightly_reseed') !== day) { db.meta.set('last_nightly_reseed', day); resetDemo('nightly 3am Pacific reseed'); }
}, 60000).unref();

// ---- Web push (VAPID keys generated once, stored server-side only) ----
const vapidPath = path.join(__dirname, '..', 'data', 'vapid.json');
if (!fs.existsSync(vapidPath)) fs.writeFileSync(vapidPath, JSON.stringify(webpush.generateVAPIDKeys()), { mode: 0o600 });
const VAPID = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
webpush.setVapidDetails('mailto:admin@ffd.demo', VAPID.publicKey, VAPID.privateKey);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob: https://tile.openstreetmap.org; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=(), payment=(), usb=(), interest-cohort=()', 'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin', 'X-Permitted-Cross-Domain-Policies': 'none', 'Origin-Agent-Cluster': '?1',
  });
  if (req.path.startsWith('/api/')) res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  next();
});
// Health check (no auth, no data) for Render
app.get('/health', (req, res) => { try { db.prepare('SELECT 1').get(); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); } });
const BIG_BODY = /^\/api\/(my\/headshot|admin\/contractors\/\d+\/headshot|my\/uploads|my\/requirements\/\d+|admin\/contractors\/\d+\/(uploads|documents\/\d+))$/;
app.use((req, res, next) => express.json({ limit: BIG_BODY.test(req.path) ? '8mb' : '64kb', strict: true })(req, res, next));
// Rate limits (per real client IP): all API calls, plus a tighter budget for writes
app.use('/api', SEC.limit('api', 1200, 5 * 60000));
app.use('/api', (req, res, next) => (['GET', 'HEAD'].includes(req.method) ? next() : SEC.limit('write', 300, 5 * 60000)(req, res, next)));

// ---------------- helpers ----------------
const crypto = require('crypto');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const audit = (req, action, details = '') => db.prepare('INSERT INTO audit_log (user_id, action, details, ip) VALUES (?,?,?,?)')
  .run(req.user ? req.user.id : null, action, String(details).slice(0, 500), req.clientIp || (req.get ? SEC.clientIp(req) : '') || '');
const nf = (m = 'Not found') => Object.assign(new Error(m), { status: 404 });
const idParam = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw nf(); return n; };

function parseCookies(h = '') {
  return Object.fromEntries(h.split(';').map((p) => p.trim().split('=')).filter((a) => a[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
const COOKIE = (req) => (req.secure ? '__Host-ffd_sid' : 'ffd_sid'); // __Host- prefix = Secure, Path=/, no Domain (can't be planted by subdomains)
const getTok = (req) => { const c = parseCookies(req.headers.cookie); return c['__Host-ffd_sid'] || c.ffd_sid; };
// Always clear both cookie names: req.secure can differ from the request that set the cookie (proxy / WKWebView).
function clearCookies(res) {
  const flags = 'HttpOnly; Path=/; SameSite=Strict; Max-Age=0';
  res.append('Set-Cookie', `__Host-ffd_sid=; ${flags}; Secure`);
  res.append('Set-Cookie', `ffd_sid=; ${flags}`);
  res.append('Set-Cookie', `ffd_sid=; ${flags}; Secure`);
  return res;
}
function auth(req, res, next) {
  req.clientIp = SEC.clientIp(req);
  const tok = getTok(req);
  if (tok) {
    const s = db.prepare('SELECT s.*, u.email, u.username, u.role, u.contractor_id, u.must_change, u.must_setup, u.kind FROM sessions s JOIN users u ON u.id = s.user_id WHERE token_hash = ?').get(C.sha256(tok));
    if (s && s.expires_at > Date.now()) req.user = { id: s.user_id, email: s.email, username: s.username, role: s.role, contractor_id: s.contractor_id, csrf: s.csrf, must_change: !!s.must_change || !!s.must_setup, must_setup: !!s.must_setup, kind: s.kind };
  }
  next();
}
app.use(auth);
// CSRF: every state-changing request needs the per-session token in a header (cookie is also SameSite=Strict)
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD'].includes(req.method)) return next();
  // Logout must always be allowed to end the session: a missing/stale CSRF token, or a Capacitor/WKWebView
  // Origin like capacitor://localhost, must not leave the user signed in. Logout CSRF only signs the victim out.
  if (req.path === '/logout') return next();
  // Defense in depth: reject cross-site writes by Origin, then require the per-session CSRF token
  const origin = req.get('origin');
  if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Cross-site request blocked' });
  if (['/login', '/password/forgot', '/password/check', '/password/reset'].includes(req.path)) return next(); // no session yet; Origin check above still applies
  if (!req.user || !req.get('x-csrf-token') || req.get('x-csrf-token') !== req.user.csrf) return res.status(403).json({ error: 'Session expired — please sign in again' });
  next();
});
// A user with a temporary / force-reset password can only change it (or sign out) until they do.
app.use('/api', (req, res, next) => {
  if (!req.user || !req.user.must_change || ['/me', '/logout', '/config', req.user.must_setup ? '/account/setup' : '/password/change'].includes(req.path)) return next();
  res.status(403).json({ error: req.user.must_setup ? 'Set up your own username and password before continuing.' : 'You must choose a new password before continuing.', must_change: true, must_setup: req.user.must_setup });
});
// Owner admin account: every state-changing call made in an owner session is written to the audit log.
app.use('/api', (req, res, next) => {
  if (req.user && req.user.kind === 'owner' && !['GET', 'HEAD'].includes(req.method)) {
    db.prepare('INSERT INTO audit_log (user_id, action, details, ip) VALUES (?,?,?,?)').run(req.user.id, 'owner_action', `${req.method} ${req.path}`.slice(0, 500), req.clientIp || '');
  }
  next();
});
const need = (role) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  if (role && req.user.role !== role) return res.status(403).json({ error: 'Not allowed' });
  next();
};

const getReqs = (destId) => db.prepare(`SELECT rt.* FROM requirement_types rt JOIN destination_requirements dr ON dr.requirement_type_id = rt.id
  WHERE dr.destination_id = ? ORDER BY CASE rt.category WHEN 'passport' THEN 0 WHEN 'visa' THEN 1 WHEN 'id' THEN 2 WHEN 'immunization' THEN 3 ELSE 4 END, rt.name`).all(destId || 0);
const SCH = require('./schedule');
const fmtToday = () => require('./status').fmt(require('./status').today());
const titleName = (id) => (id ? (db.prepare('SELECT name FROM titles WHERE id = ?').get(id) || {}).name || '' : '');
function readiness(c) {
  return evaluate({ ...c, _on: SCH.onBlocks(c.id) }, getReqs(c.destination_id), db.prepare('SELECT * FROM documents WHERE contractor_id = ?').all(c.id),
    db.prepare('SELECT * FROM blockers WHERE contractor_id = ?').all(c.id));
}
const getContractor = (id) => { const c = db.prepare('SELECT * FROM contractors WHERE id = ?').get(id); if (!c) throw nf(); return c; };
const destName = (id) => (db.prepare('SELECT name FROM destinations WHERE id = ?').get(id || 0) || {}).name || '—';
const getProfile = (cid) => {
  const p = db.prepare('SELECT * FROM profiles WHERE contractor_id = ?').get(cid);
  const out = p ? { ...C.decJSON(p.data_enc), _updated_at: p.updated_at, _updated_by: p.updated_by } : V.profile({});
  const c = db.prepare('SELECT home_airport, alt_airport FROM contractors WHERE id = ?').get(cid) || {};
  out.travel = { home_airport: c.home_airport || '', alt_airport: c.alt_airport || '' }; // contractor columns are the source of truth
  return out;
};
const mask = (s) => (s ? `•••• ${String(s).slice(-4)}` : '');

function sendAlert(cids, kind, title, body, by) {
  const ins = db.prepare('INSERT INTO alerts (contractor_id, kind, title, body, sent_by) VALUES (?,?,?,?,?)');
  for (const cid of cids) {
    ins.run(cid, kind, title, body, by);
    const subs = db.prepare('SELECT ps.* FROM push_subs ps JOIN users u ON u.id = ps.user_id WHERE u.contractor_id = ?').all(cid);
    for (const s of subs) {
      webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, JSON.stringify({ title: `FFD: ${title}`, body, url: '/app.html' }))
        .catch((e) => { if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id); });
    }
  }
}

// --------------- auth ---------------
// Brute force (demo-friendly): max 20 failed logins per client IP per 5 min, max 10 per account+IP per 5 min, and a soft cap of
// 50 failures per account per hour from all IPs. Responses are identical for unknown users, wrong passwords and
// lockouts (no account enumeration), and a hash is always computed so timing doesn't leak either.
const DUMMY_HASH = C.hashPassword(C.token());
// Owner sign-ins use their own per-IP budget, so other people's failed attempts (or a busy shared office IP) can never block the owner.
const isOwnerId = (b) => { const id = String((b && (b.email ?? b.username)) || '').trim().toLowerCase(); return !!id && (id === OWNER.USERNAME || id === OWNER.EMAIL); };
const loginLimit = (req, res, next) => (isOwnerId(req.body) ? SEC.limit('login-owner', 30, 5 * 60000) : SEC.limit('login', 60, 15 * 60000))(req, res, next);
app.post('/api/login', loginLimit, wrap(async (req, res) => {
  const ip = req.clientIp;
  const email = V.str(req.body.email ?? req.body.username, 120, { required: true, name: 'Email or username' }).toLowerCase(); // email OR username
  const password = V.str(req.body.password, 200, { required: true, name: 'Password' });
  const W = 5 * 60000; // lockout counters live in memory only, so every deploy/restart clears them
  const u = db.prepare('SELECT * FROM users WHERE email = ? OR (username IS NOT NULL AND username = ?)').get(email, email);
  const isOwner = !!u && u.kind === 'owner';
  // The owner account is never locked out (it is protected by a long random server-side secret instead); everyone else is.
  const blocked = !isOwner && (SEC.peek(`lf-ip:${ip}`, W) >= 20 || SEC.peek(`lf-acct-ip:${email}:${ip}`, W) >= 10 || SEC.peek(`lf-acct:${email}`, 3600000) >= 50);
  let good = C.verifyPassword(password, u ? u.password_hash : DUMMY_HASH) && !!u;
  if (isOwner && !OWNER.enabled()) good = false; // owner secret not configured on the server -> owner login disabled
  // One-time temporary credentials: valid once, until they expire
  const tempDead = good && u.must_setup && (u.temp_used_at || !u.temp_expires_at || u.temp_expires_at < Date.now());
  if (tempDead) good = false;
  if (blocked || !good) {
    if (!good && !isOwner) { SEC.hit(`lf-ip:${ip}`, 1e9, W); SEC.hit(`lf-acct-ip:${email}:${ip}`, 1e9, W); SEC.hit(`lf-acct:${email}`, 1e9, 3600000); }
    audit({ clientIp: ip, user: u ? { id: u.id } : null }, blocked ? 'login_blocked' : tempDead ? 'temp_login_rejected' : isOwner ? 'owner_login_failed' : 'login_failed', email);
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 300)); // slow down guessing
    return res.status(401).json({ error: 'Email or password is incorrect, or too many attempts. Wait 5 minutes and try again.' });
  }
  SEC.reset(`lf-acct-ip:${email}:${ip}`);
  // Session fixation: any session presented with this request is destroyed; a brand-new random token is issued.
  const old = getTok(req); if (old) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(C.sha256(old));
  const now = Date.now(); const tok = C.token(); const csrf = C.token();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, expires_at) VALUES (?,?,?,?)').run(C.sha256(tok), u.id, csrf, now + SESSION_HOURS * 3600000);
  res.set('Set-Cookie', `${COOKIE(req)}=${tok}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${req.secure ? '; Secure' : ''}`);
  if (u.must_setup) { db.prepare('UPDATE users SET temp_used_at = ? WHERE id = ?').run(now, u.id); redactInvite(u.id, 'used'); }
  audit({ clientIp: ip, user: { id: u.id } }, isOwner ? 'owner_login' : u.must_setup ? 'temp_login' : 'login', email);
  res.json({ role: u.role, csrf, must_change: !!u.must_change || !!u.must_setup, must_setup: !!u.must_setup });
}));
app.post('/api/logout', (req, res) => {
  const tok = getTok(req);
  if (tok) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(C.sha256(tok));
  clearCookies(res);
  if (req.user) audit(req, 'logout', req.user.email);
  res.json({ ok: true });
});
// --------------- passwords: forgot / reset / change (+ admin overrides further down) ---------------
const MAIL = require('./mail');
const APP_URL = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 4300}`).replace(/\/$/, ''); // never built from the Host header
// Ticket approval queue (src/tickets.js): proposals refresh on boot, every 15 min, and whenever the queue / report is read.
TK.init({ readiness, sendAlert, appUrl: APP_URL });
if (SEEDED_NOW) TK.seedDemo(); else TK.propose(true);
setInterval(() => { try { TK.propose(true); } catch (e) { console.error('ticket proposals failed', e.message); } }, 15 * 60000).unref();
const RESET_MIN = 30;
const COMMON_PW = new Set(['password', 'password1', 'password123', 'qwerty123', 'letmein', 'welcome1', 'changeme', 'iloveyou', 'admin123', '123456789012', 'deployment']);
function pwProblem(pw, email) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Use at least 12 characters.';
  if (pw.length > 200) return 'Use at most 200 characters.';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) return 'Mix at least 3 of: lowercase, uppercase, numbers, symbols.';
  const low = pw.toLowerCase(); const local = String(email || '').split('@')[0].toLowerCase();
  if (COMMON_PW.has(low) || /^(.)\1+$/.test(pw) || (local.length >= 3 && low.includes(local)) || /ffd|fitfordeploy/.test(low)) return 'Too easy to guess — avoid common words, your name/email and "FFD".';
  return null;
}
const strong = (pw, email) => { const p = pwProblem(pw, email); if (p) throw new V.VErr(p); return pw; };
const clearLockouts = (email) => SEC.resetMatching(new RegExp(`^lf-acct(-ip)?:${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:|$)`));
function issueReset(u, by) {
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(u.id); // a new request invalidates any earlier link
  const tok = C.token(32);
  db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at, created_by) VALUES (?,?,?,?)').run(u.id, C.sha256(tok), Date.now() + RESET_MIN * 60000, by);
  return `${APP_URL}/reset.html#t=${tok}`;
}
const resetMail = (u, link, byAdmin) => MAIL.send(u.email, 'Reset your FFD password',
  `${byAdmin ? 'An FFD administrator started a password reset for your account.' : 'Someone (hopefully you) asked to reset the password for your FFD account.'}\n\n`
  + `Choose a new password here (link works once, for ${RESET_MIN} minutes):\n${link}\n\nIf you didn't ask for this, ignore this email — your password stays the same.\n\n— FFD · Fit For Deployment`, 'reset');
const changedMail = (u, how) => MAIL.send(u.email, 'Your FFD password was changed',
  `The password for your FFD account (${u.email}) was changed ${how} on ${new Date().toUTCString()}.\nAll devices were signed out.\n\n`
  + 'If this wasn\'t you, contact your FFD administrator right away.\n\n— FFD · Fit For Deployment', 'changed');
function afterPasswordChange(u, req, how, keepSession) {
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(u.id);
  if (keepSession) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(u.id, C.sha256(getTok(req) || ''));
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  clearLockouts(u.email.toLowerCase());
  changedMail(u, how);
  if (u.contractor_id) sendAlert([u.contractor_id], 'info', 'Your password was changed', `Your FFD password was changed ${how}. If this wasn't you, contact your FFD administrator.`, 'system');
}
const SAME = { ok: true, message: `If that email has an FFD account, a reset link is on its way. It works once and expires in ${RESET_MIN} minutes.` };
app.post('/api/password/forgot', SEC.limit('pwf-ip', 5, 15 * 60000), wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 120);
  const t0 = Date.now();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && SEC.hit(`pwf-em:${email}`, 3, 3600000).ok) { // per-email cap is silent: same answer either way
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (u && u.kind !== 'owner') { resetMail(u, issueReset(u, 'self'), false); audit({ clientIp: req.clientIp, user: { id: u.id } }, 'password_reset_requested', email); }
  }
  await new Promise((r) => setTimeout(r, Math.max(0, 450 - (Date.now() - t0)) + Math.random() * 150)); // equal timing for known/unknown emails
  res.set('Cache-Control', 'no-store').json(SAME);
}));
const findReset = (tok) => {
  if (typeof tok !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(tok)) return null;
  const r = db.prepare('SELECT pr.*, u.email FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE token_hash = ?').get(C.sha256(tok));
  return r && !r.used_at && r.expires_at > Date.now() ? r : null;
};
app.post('/api/password/check', SEC.limit('pwr-ip', 20, 15 * 60000), (req, res) => { // reset page asks "is this link still good?"
  const r = findReset(req.body.token); res.set('Cache-Control', 'no-store').json({ valid: !!r, email: r ? r.email.replace(/^(.).*?(@.*)$/, '$1•••$2') : null });
});
app.post('/api/password/reset', SEC.limit('pwr-ip', 10, 15 * 60000), (req, res) => {
  const r = findReset(req.body.token);
  if (!r) return res.status(400).json({ error: 'This reset link is invalid, already used or expired. Request a new one.' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id);
  strong(req.body.password, u.email);
  if (C.verifyPassword(req.body.password, u.password_hash)) throw new V.VErr('Choose a password you have not used for this account.');
  db.prepare("UPDATE users SET password_hash = ?, must_change = 0, pw_changed_at = datetime('now'), failed_logins = 0, locked_until = NULL WHERE id = ?").run(C.hashPassword(req.body.password), u.id);
  db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE id = ?").run(r.id);
  afterPasswordChange(u, req, 'with an emailed reset link', false);
  audit({ clientIp: req.clientIp, user: { id: u.id } }, 'password_reset_completed', u.email);
  clearCookies(res).json({ ok: true });
});
app.post('/api/password/change', need(), SEC.limit('pwc', 10, 15 * 60000), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (u.kind === 'owner') return res.status(400).json({ error: 'The owner admin password is managed on the server (Render env var OWNER_ADMIN_PASSWORD).' });
  if (!C.verifyPassword(String(req.body.current || ''), u.password_hash)) { audit(req, 'password_change_failed', u.email); return res.status(400).json({ error: 'Current password is not correct.' }); }
  strong(req.body.password, u.email);
  if (req.body.password === req.body.current) throw new V.VErr('The new password must be different from the current one.');
  db.prepare("UPDATE users SET password_hash = ?, must_change = 0, pw_changed_at = datetime('now') WHERE id = ?").run(C.hashPassword(req.body.password), u.id);
  afterPasswordChange(u, req, u.must_change ? 'after a required password change' : 'from the signed-in account', true);
  audit(req, u.must_change ? 'password_changed_required' : 'password_changed', u.email);
  res.json({ ok: true, role: u.role });
});
app.get('/api/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  res.json({ email: req.user.email, username: req.user.username || null, role: req.user.role, owner: req.user.kind === 'owner', csrf: req.user.csrf, vapid: VAPID.publicKey, must_change: req.user.must_change, must_setup: req.user.must_setup, demo: DEMO_MODE });
});
// Public app bootstrap (no auth, no secrets). The iOS app and the sign-in page call this on launch: it reports whether this
// server is the demo environment and, in demo mode, makes sure the demo data set is present (self-heals an empty or
// outdated database; a no-op otherwise, so repeated launches never duplicate anything).
let demoHealing = false;
app.get('/api/config', SEC.limit('config', 120, 5 * 60000), (req, res) => {
  let healed = false;
  if (DEMO_MODE && !demoHealing && demoNeedsSeed()) {
    demoHealing = true;
    try { resetDemo('auto-setup on app launch (demo data missing or outdated)'); syncPasswords(); healed = true; } finally { demoHealing = false; }
  }
  res.set('Cache-Control', 'no-store').json({ app: 'FFD', demo: DEMO_MODE, seed_version: DEMO_MODE ? SEED_VERSION : undefined, healed,
    signup: false, auth: 'server-issued', min_ios_build: Number(process.env.MIN_IOS_BUILD || 1) });
});
// First sign-in with one-time temporary credentials: the person must choose their own username + password before anything else.
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
app.post('/api/account/setup', need(), SEC.limit('setup', 10, 15 * 60000), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!u.must_setup) return res.status(400).json({ error: 'Your account is already set up.' });
  const username = String(req.body.username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw new V.VErr('Username: 3–32 characters, letters, numbers, dot, dash or underscore (start with a letter or number).');
  if (/^tmp-/.test(username) || username === OWNER.USERNAME || /^(admin|root|owner|support|system)$/.test(username)) throw new V.VErr('Choose a different username.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(username, u.id)) throw new V.VErr('That username is taken — choose another.');
  strong(req.body.password, u.email);
  if (C.verifyPassword(req.body.password, u.password_hash)) throw new V.VErr('Choose a new password, not the temporary one.');
  db.prepare("UPDATE users SET username = ?, password_hash = ?, must_change = 0, must_setup = 0, temp_expires_at = NULL, temp_used_at = NULL, pw_changed_at = datetime('now') WHERE id = ?")
    .run(username, C.hashPassword(req.body.password), u.id);
  afterPasswordChange(u, req, 'when you set up your account', true);
  audit(req, 'account_setup_completed', `${u.email} → username ${username}`);
  res.json({ ok: true, role: u.role, username });
});
function redactInvite(userId, why) { MAIL.redact(`invite:${userId}`, why); }
// Expired, unused temporary credentials are removed from the Outbox
setInterval(() => { for (const u of db.prepare('SELECT id FROM users WHERE must_setup = 1 AND temp_used_at IS NULL AND temp_expires_at < ?').all(Date.now())) redactInvite(u.id, 'expired'); }, 5 * 60000).unref();
// Demo scenario list (admin only; never includes passwords)
app.get('/api/demo-info', need('admin'), (req, res) => {
  if (!DEMO_MODE) return res.json({ demo: false });
  const cs = db.prepare('SELECT c.name, c.notes, u.email FROM contractors c JOIN users u ON u.contractor_id = c.id ORDER BY c.employee_no').all();
  res.json({ demo: true, contractors: cs });
});

// --------------- contractor ---------------
const me = (req) => getContractor(req.user.contractor_id);
app.get('/api/my/status', need('contractor'), (req, res) => {
  const c = me(req);
  const flights = db.prepare('SELECT * FROM flights WHERE contractor_id = ? ORDER BY depart_at').all(c.id);
  const alerts = db.prepare('SELECT * FROM alerts WHERE contractor_id = ? ORDER BY created_at DESC, id DESC LIMIT 50').all(c.id);
  res.json({ contractor: { id: c.id, name: c.name, employee_no: c.employee_no, title: titleName(c.title_id), destination: destName(c.destination_id) },
    readiness: readiness(c), flights, alerts, unread_alerts: alerts.filter((a) => !a.read_at).length,
    new_flights: flights.filter((f) => !f.seen_at).length, itineraries: TK.forContractor(c.id) });
});
app.post('/api/my/flights/seen', need('contractor'), (req, res) => {
  db.prepare("UPDATE flights SET seen_at = datetime('now') WHERE contractor_id = ? AND seen_at IS NULL").run(req.user.contractor_id);
  res.json({ ok: true });
});
app.post('/api/my/alerts/read', need('contractor'), (req, res) => {
  db.prepare("UPDATE alerts SET read_at = datetime('now') WHERE contractor_id = ? AND read_at IS NULL").run(req.user.contractor_id);
  res.json({ ok: true });
});
app.get('/api/my/profile', need('contractor'), (req, res) => res.json({ profile: getProfile(req.user.contractor_id), uploads: listUploads(req.user.contractor_id),
  title_id: me(req).title_id, titles: activeTitles() }));
// My Schedule: upcoming blocks, travel days and the flights that go with each rotation
function mySchedule(c) {
  const t = fmtToday();
  const flights = db.prepare('SELECT * FROM flights WHERE contractor_id = ? ORDER BY depart_at').all(c.id);
  const near = (date) => flights.filter((f) => Math.abs(Date.parse(f.depart_at.slice(0, 10)) - Date.parse(date)) <= 2 * 86400000);
  const blocks = SCH.blocks(c.id).filter((b) => b.end >= SCH.plus(t, -7)).map((b) => ({ ...b, site: b.destination_id ? destName(b.destination_id) : '',
    travel_out: b.kind === 'on' ? b.start : null, travel_home: b.kind === 'on' ? b.end : null,
    flights_out: b.kind === 'on' ? near(b.start).map((f) => f.id) : [], flights_home: b.kind === 'on' ? near(b.end).map((f) => f.id) : [] }));
  return { today: t, blocks, flights, pattern: { on: c.rotation_on, off: c.rotation_off }, itineraries: TK.forContractor(c.id) };
}
app.get('/api/my/schedule', need('contractor'), (req, res) => res.json(mySchedule(me(req))));
app.get('/api/my/schedule.ics', need('contractor'), (req, res) => {
  const c = me(req); const sc = mySchedule(c);
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="ffd-schedule.ics"' }).send(SCH.ics(c.name, sc.blocks, sc.flights));
});
app.put('/api/my/profile', need('contractor'), (req, res) => {
  const p = V.profile(req.body.profile);
  const ec = p.emergency_contacts[0];
  if (!ec || !ec.name || !ec.phone) throw new V.VErr('Primary emergency contact name and mobile phone are required');
  saveProfile(req.user.contractor_id, p, 'contractor');
  if (req.body.title_id !== undefined) {
    const tid = titleParam(req.body.title_id); const old = me(req).title_id;
    if (tid !== old) { db.prepare('UPDATE contractors SET title_id = ? WHERE id = ?').run(tid, req.user.contractor_id); audit(req, 'title_change_self', `${titleName(old) || '—'} → ${titleName(tid) || '—'}`); }
  }
  const synced = syncProfileToDocs(req.user.contractor_id, p);
  audit(req, 'profile_update_self', `contractor ${req.user.contractor_id}; synced: ${synced.join(', ')}`);
  res.json({ ok: true, synced, readiness: readiness(me(req)) });
});
// Contractor submits/updates one requirement (e.g. yellow fever card) — self-reported until admin verifies.
app.post('/api/my/requirements/:typeId', need('contractor'), SEC.limit('upload', 30, 10 * 60000, (r) => `u${r.user.id}`), (req, res) => {
  const c = me(req); const typeId = idParam(req.params.typeId);
  const rt = getReqs(c.destination_id).find((r) => r.id === typeId); if (!rt) throw nf('Requirement not required for your site');
  const issued = V.date(req.body.issued, { name: 'Issued / shot date' });
  const expires = V.date(req.body.expires, { name: 'Expiration date', required: !!rt.has_expiry && !rt.is_check });
  const ref = V.str(req.body.number, 40, { name: 'Document number' });
  let uploadId = null;
  if (req.body.file) uploadId = storeUpload(c.id, { label: rt.name, ...req.body.file }, 'contractor');
  if (rt.is_check) {
    // Contractors can submit a background check but only the office can mark it cleared.
    const cur = db.prepare('SELECT * FROM documents WHERE contractor_id = ? AND requirement_type_id = ?').get(c.id, typeId);
    upsertDoc(c.id, typeId, { ref_last4: '', issued, expires: defaultExpiry(rt, issued, expires), status: 'valid', verified: 0, source: 'contractor', upload_id: uploadId,
      check_status: cur && cur.check_status === 'in_progress' ? 'in_progress' : 'submitted', provider: V.str(req.body.provider, 80, { name: 'Provider' }),
      reference: V.str(req.body.reference || req.body.number, 60, { name: 'Reference #' }), notes: 'Submitted by contractor in app — awaiting office review' });
  } else upsertDoc(c.id, typeId, { ref_last4: ref.slice(-4), issued, expires, status: 'valid', verified: 0, source: 'contractor', upload_id: uploadId, notes: 'Submitted by contractor in app' });
  audit(req, 'requirement_submitted', `${c.name}: ${rt.name}`);
  res.json({ ok: true, readiness: readiness(c) });
});
app.get('/api/my/uploads', need('contractor'), (req, res) => res.json({ uploads: listUploads(req.user.contractor_id) }));
app.post('/api/my/uploads', need('contractor'), SEC.limit('upload', 30, 10 * 60000, (r) => `u${r.user.id}`), (req, res) => {
  const id = storeUpload(req.user.contractor_id, req.body, 'contractor'); audit(req, 'upload', `id ${id}`); res.json({ ok: true, id });
});
app.post('/api/my/push', need('contractor'), SEC.limit('push', 10, 60 * 60000, (r) => `u${r.user.id}`), (req, res) => {
  const s = req.body.subscription || {};
  const endpoint = V.str(s.endpoint, 1000, { required: true, name: 'endpoint', pattern: /^https:\/\// });
  const keys = { p256dh: V.str(s.keys && s.keys.p256dh, 200, { required: true, name: 'p256dh' }), auth: V.str(s.keys && s.keys.auth, 100, { required: true, name: 'auth' }) };
  db.prepare('INSERT INTO push_subs (user_id, endpoint, keys) VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys').run(req.user.id, endpoint, JSON.stringify(keys));
  res.json({ ok: true });
});

// --------------- uploads (shared, authorization-checked) ---------------
const MAGIC = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'application/pdf': [0x25, 0x50, 0x44, 0x46], 'image/webp': [0x52, 0x49, 0x46, 0x46] };
function storeUpload(cid, body, by) {
  const label = V.str(body.label, 80, { required: true, name: 'Label' });
  const mime = V.str(body.mime, 40, { required: true, name: 'File type', oneOf: Object.keys(MAGIC) });
  const b64 = V.str(body.data, 7_500_000, { required: true, name: 'File' });
  const buf = Buffer.from(b64.replace(/^data:[^,]+,/, ''), 'base64');
  if (buf.length > 5 * 1024 * 1024) throw new V.VErr('File too large (max 5 MB)');
  if (!MAGIC[mime].every((b, i) => buf[i] === b)) throw new V.VErr('File content does not match its type');
  const file = `${C.token()}.bin`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), C.encrypt(buf), { mode: 0o600 });
  return Number(db.prepare('INSERT INTO uploads (contractor_id, label, mime, size, file, uploaded_by) VALUES (?,?,?,?,?,?)').run(cid, label, mime, buf.length, file, by).lastInsertRowid);
}
const listUploads = (cid) => db.prepare('SELECT id, label, mime, size, uploaded_by, created_at FROM uploads WHERE contractor_id = ? ORDER BY id DESC').all(cid);
app.get('/api/uploads/:id', need(), (req, res) => {
  const u = db.prepare('SELECT * FROM uploads WHERE id = ?').get(idParam(req.params.id));
  if (!u || (req.user.role !== 'admin' && u.contractor_id !== req.user.contractor_id)) throw nf();
  audit(req, 'upload_view', `upload ${u.id} (contractor ${u.contractor_id})`);
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[u.mime];
  res.set({ 'Content-Type': u.mime, 'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename="document-${u.id}.${ext}"`,
    'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff' });
  res.send(C.decrypt(fs.readFileSync(path.join(UPLOAD_DIR, u.file))));
});

// --------------- headshot + ID badge ---------------
// Headshot: client crops to a square JPEG (256–1024 px); we re-check type, magic bytes, size and square dimensions, store it encrypted, and mark it pending.
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1]; const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}
function storeHeadshot(c, body, by) {
  const b64 = V.str(body.data, 2_000_000, { required: true, name: 'Photo' });
  const buf = Buffer.from(b64.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
  if (buf.length > 1024 * 1024) throw new V.VErr('Photo too large (max 1 MB after cropping)');
  if (!MAGIC['image/jpeg'].every((b, i) => buf[i] === b)) throw new V.VErr('Headshot must be a JPEG image');
  const dim = jpegSize(buf);
  if (!dim || dim.w !== dim.h || dim.w < 256 || dim.w > 1024) throw new V.VErr('Headshot must be a square photo between 256 and 1024 px');
  const file = `${C.token()}.bin`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), C.encrypt(buf), { mode: 0o600 });
  const id = Number(db.prepare('INSERT INTO uploads (contractor_id, label, mime, size, file, uploaded_by) VALUES (?,?,?,?,?,?)').run(c.id, 'Headshot', 'image/jpeg', buf.length, file, by).lastInsertRowid);
  const status = by === 'admin' && body.approve ? 'approved' : 'pending';
  db.prepare("UPDATE contractors SET headshot_upload_id = ?, headshot_status = ?, headshot_note = '', headshot_at = datetime('now') WHERE id = ?").run(id, status, c.id);
  return status;
}
const initials = (n) => n.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase().replace(/[^A-Z]/g, '');
function avatarSvg(name) { // neutral generated placeholder: silhouette + initials, no real photo
  const ini = initials(name) || '?';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#3b4a22"/><circle cx="128" cy="100" r="50" fill="#56683a"/><path d="M38 256c8-56 46-86 90-86s82 30 90 86z" fill="#56683a"/><text x="128" y="118" font-family="Arial,Helvetica,sans-serif" font-size="46" font-weight="700" fill="#e8eadf" text-anchor="middle">${ini}</text></svg>`;
}
// ?approved=1 -> only an APPROVED photo (badge); otherwise admin sees pending too, contractor sees their own latest.
app.get('/api/headshot/:cid', need(), (req, res) => {
  const cid = idParam(req.params.cid);
  if (req.user.role !== 'admin' && req.user.contractor_id !== cid) throw nf();
  const c = getContractor(cid);
  const onlyApproved = req.query.approved === '1';
  res.set({ 'Cache-Control': 'private, max-age=60', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
  const u = c.headshot_upload_id && (!onlyApproved || c.headshot_status === 'approved') && c.headshot_status !== 'rejected' ? db.prepare('SELECT * FROM uploads WHERE id = ? AND contractor_id = ?').get(c.headshot_upload_id, c.id) : null;
  if (!u) return res.type('image/svg+xml').send(avatarSvg(c.name));
  res.type('image/jpeg').send(C.decrypt(fs.readFileSync(path.join(UPLOAD_DIR, u.file))));
});
function badge(c) {
  const r = readiness(c); const t = fmtToday();
  // Valid through: end of the current/next scheduled rotation, capped by the earliest expiring requirement; RED = not valid.
  const exp = r.items.map((i) => i.document && i.document.expires).filter(Boolean).sort()[0];
  let valid = r.rotation.end; if (exp && exp < valid) valid = exp;
  const deployed = r.rotation.start <= t && r.rotation.end >= t;
  return { contractor_id: c.id, name: (() => { const p = getProfile(c.id).personal || {}; return [p.legal_first, p.legal_middle, p.legal_last].filter(Boolean).join(' ') || c.name; })(),
    title: titleName(c.title_id) || 'Contractor', employee_no: c.employee_no, status: r.status, site: destName(c.destination_id), site_label: deployed ? 'Current site' : 'Assigned site',
    home_airport: c.home_airport, valid_through: r.status === 'red' ? null : valid, issued: t,
    headshot_status: c.headshot_upload_id ? c.headshot_status : 'placeholder', headshot_note: c.headshot_note || '' };
}
app.get('/api/my/badge', need('contractor'), (req, res) => res.json(badge(me(req))));
app.post('/api/my/headshot', need('contractor'), SEC.limit('headshot', 10, 60 * 60000, (r) => `u${r.user.id}`), (req, res) => {
  const c = me(req); storeHeadshot(c, req.body, 'contractor');
  audit(req, 'headshot_upload', c.name);
  res.json({ ok: true, status: 'pending' });
});
function upsertDoc(cid, typeId, d) {
  db.prepare(`INSERT INTO documents (contractor_id, requirement_type_id, ref_last4, issued, expires, status, notes, verified, source, upload_id, check_status, provider, reference, updated_at)
    VALUES (@cid,@typeId,@ref_last4,@issued,@expires,@status,@notes,@verified,@source,@upload_id,@check_status,@provider,@reference,datetime('now'))
    ON CONFLICT(contractor_id, requirement_type_id) DO UPDATE SET ref_last4=excluded.ref_last4, issued=excluded.issued, expires=excluded.expires,
    status=excluded.status, notes=excluded.notes, verified=excluded.verified, source=excluded.source, upload_id=COALESCE(excluded.upload_id, documents.upload_id),
    check_status=excluded.check_status, provider=excluded.provider, reference=excluded.reference, updated_at=excluded.updated_at`)
    .run({ cid, typeId, ref_last4: '', issued: null, expires: null, status: 'valid', notes: '', verified: 1, source: 'admin', upload_id: null, check_status: null, provider: '', reference: '', ...d });
}
const CHECK_STATUSES = ['not_started', 'submitted', 'in_progress', 'cleared', 'failed'];
// Expiry for check-type requirements defaults to completion date + the type's validity (e.g. 365 days)
function defaultExpiry(rt, issued, expires) {
  if (expires || !rt.validity_days || !issued) return expires;
  return new Date(Date.parse(issued + 'T00:00:00Z') + rt.validity_days * 86400000).toISOString().slice(0, 10);
}
function checkUploadOwnership(cid, p) {
  const ids = [];
  const walk = (o, k) => { if (o && typeof o === 'object') Object.entries(o).forEach(([kk, v]) => walk(v, kk)); else if (/upload$/.test(k || '') && o) ids.push(o); };
  walk(p);
  for (const id of ids) if (!db.prepare('SELECT 1 FROM uploads WHERE id = ? AND contractor_id = ?').get(id, cid)) throw new V.VErr('Attached file not found');
}
function saveProfile(cid, p, by) {
  checkUploadOwnership(cid, p);
  if (p.travel) db.prepare('UPDATE contractors SET home_airport = ?, alt_airport = ? WHERE id = ?').run(p.travel.home_airport || '', p.travel.alt_airport || '', cid);
  db.prepare(`INSERT INTO profiles (contractor_id, data_enc, updated_by, updated_at) VALUES (?,?,?,datetime('now'))
    ON CONFLICT(contractor_id) DO UPDATE SET data_enc=excluded.data_enc, updated_by=excluded.updated_by, updated_at=excluded.updated_at`).run(cid, C.encJSON(p), by);
}
// Intake form → requirement records. Only fills gaps or extends expiry; never downgrades an admin-verified record.
function syncProfileToDocs(cid, p) {
  const c = getContractor(cid); const synced = [];
  const docs = new Map(db.prepare('SELECT * FROM documents WHERE contractor_id = ?').all(cid).map((d) => [d.requirement_type_id, d]));
  for (const rt of getReqs(c.destination_id)) {
    if (rt.is_check) continue; // background checks are never self-cleared from the intake form
    let entry = null;
    const kw = (rt.keyword || '').toLowerCase();
    if (rt.category === 'passport' && p.passport.number) entry = { number: p.passport.number, issued: p.passport.issued, expires: p.passport.expires, upload_id: p.passport.photo_upload };
    else if (rt.category === 'id' && p.gov_id.number) entry = { number: p.gov_id.number, issued: null, expires: p.gov_id.expires, upload_id: p.gov_id.front_upload };
    else if (rt.category === 'visa') { const v = p.visas.find((x) => `${x.country} ${x.type}`.toLowerCase().includes(kw)); if (v) entry = { number: v.number, issued: v.issued, expires: v.expires, upload_id: v.upload }; }
    else if (rt.category === 'immunization') { const v = p.immunizations.find((x) => x.vaccine.toLowerCase().includes(kw)); if (v) entry = { number: '', issued: (v.dates.match(/\d{4}-\d{2}-\d{2}/g) || []).pop() || null, expires: v.expires }; }
    else if (rt.category === 'clearance' && kw === 'medical' && p.physical && p.physical.expires) entry = { number: '', issued: p.physical.last_exam, expires: p.physical.expires, upload_id: p.physical.upload };
    else if (rt.category === 'clearance') { const v = p.clearances.find((x) => x.type.toLowerCase().includes(kw)); if (v) entry = { number: '', issued: v.granted, expires: v.expires }; }
    if (!entry || (rt.has_expiry && !entry.expires)) continue;
    const cur = docs.get(rt.id);
    const better = !cur || cur.status !== 'valid' || (rt.has_expiry && (!cur.expires || entry.expires > cur.expires));
    if (!better) continue;
    upsertDoc(cid, rt.id, { ref_last4: String(entry.number || '').slice(-4), issued: entry.issued, expires: rt.has_expiry ? entry.expires : null,
      status: 'valid', verified: 0, source: 'contractor', upload_id: entry.upload_id || null, notes: 'From contractor intake form' });
    synced.push(rt.name);
  }
  return synced;
}

// --------------- deployed check-in & location (opt-in) ---------------
const setting = (k, d) => { const v = db.meta.get(k); return v === undefined ? d : v; };
const trackingCfg = () => ({ enabled: setting('tracking_enabled', DEMO_MODE ? '1' : '0') === '1', overdue_hours: Number(setting('tracking_overdue_hours', '12')),
  retention_days: Number(setting('tracking_retention_days', '30')), auto_minutes: 15 });
function isDeployed(c) { const r = readiness(c).rotation; const t = fmtToday(); return r.start <= t && r.end >= t; } // includes the travel-home day
function purgeCheckins() { db.prepare("DELETE FROM checkins WHERE created_at < datetime('now', ?)").run(`-${trackingCfg().retention_days} days`); }
purgeCheckins(); setInterval(purgeCheckins, 3600000).unref();
const lastCheckin = (cid) => db.prepare("SELECT * FROM checkins WHERE contractor_id = ? AND kind != 'sos' ORDER BY created_at DESC, id DESC LIMIT 1").get(cid);
const decLoc = (row) => (row && row.loc_enc ? C.decJSON(row.loc_enc) : null);
function readLoc(b) {
  if (b.lat === undefined || b.lat === null || b.lat === '') return null;
  const lat = Number(b.lat), lng = Number(b.lng), acc = Number(b.accuracy || 0);
  if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) throw new V.VErr('Invalid location');
  return { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5, acc: Math.min(Math.round(acc), 100000) };
}
app.get('/api/my/tracking', need('contractor'), (req, res) => {
  const c = me(req); const cfg = trackingCfg(); const last = lastCheckin(c.id);
  res.json({ enabled: cfg.enabled, deployed: isDeployed(c), consent: !!c.tracking_consent, consent_at: c.tracking_consent_at, auto_minutes: cfg.auto_minutes,
    retention_days: cfg.retention_days, last_checkin: last ? last.created_at : null });
});
app.put('/api/my/tracking/consent', need('contractor'), (req, res) => {
  const on = req.body.consent === true;
  db.prepare("UPDATE contractors SET tracking_consent = ?, tracking_consent_at = CASE WHEN ? THEN datetime('now') ELSE tracking_consent_at END WHERE id = ?").run(on ? 1 : 0, on ? 1 : 0, req.user.contractor_id);
  audit(req, on ? 'tracking_consent_on' : 'tracking_consent_off', `contractor ${req.user.contractor_id}`); res.json({ ok: true });
});
app.post('/api/my/checkin', need('contractor'), SEC.limit('checkin', 12, 10 * 60000, (r) => `u${r.user.id}`), (req, res) => {
  const c = me(req); const cfg = trackingCfg();
  if (!cfg.enabled) throw Object.assign(new Error('Check-in is turned off'), { status: 409 });
  if (!isDeployed(c)) throw Object.assign(new Error('Check-in is only active while you are deployed'), { status: 409 });
  if (!c.tracking_consent) throw Object.assign(new Error('Turn on location sharing first'), { status: 409 });
  const kind = req.body.kind === 'auto' ? 'auto' : 'checkin'; const loc = readLoc(req.body);
  db.prepare('INSERT INTO checkins (contractor_id, kind, loc_enc) VALUES (?,?,?)').run(c.id, kind, loc ? C.encJSON(loc) : null);
  if (kind === 'checkin') audit(req, 'checkin', c.name);
  res.json({ ok: true });
});
// SOS always works while deployed (even without location consent); location attached if the phone provides it.
app.post('/api/my/sos', need('contractor'), SEC.limit('sos', 3, 10 * 60000, (r) => `u${r.user.id}`), (req, res) => {
  const c = me(req); const loc = readLoc(req.body || {});
  const note = V.str(req.body.message, 300, { name: 'Message' });
  const ck = Number(db.prepare("INSERT INTO checkins (contractor_id, kind, loc_enc) VALUES (?, 'sos', ?)").run(c.id, loc ? C.encJSON(loc) : null).lastInsertRowid);
  db.prepare("INSERT INTO admin_alerts (contractor_id, kind, title, body, checkin_id) VALUES (?, 'sos', ?, ?, ?)").run(c.id, `SOS from ${c.name}`,
    `${destName(c.destination_id)}${loc ? ` · ${loc.lat}, ${loc.lng} (±${loc.acc} m)` : ' · location unavailable'}${note ? ` · "${note}"` : ''}`, ck);
  audit(req, 'sos', `${c.name}${loc ? '' : ' (no location)'}`);
  res.json({ ok: true });
});

// --------------- admin ---------------
const admin = express.Router();
admin.use(need('admin'));
const onNow = (cid, day = fmtToday()) => db.prepare("SELECT * FROM schedule_blocks WHERE contractor_id = ? AND kind = 'on' AND start <= ? AND end >= ?").get(cid, day, day);
admin.get('/contractors', (req, res) => {
  const list = db.prepare('SELECT * FROM contractors ORDER BY name').all().map((c) => {
    const r = readiness(c); const p = getProfile(c.id);
    return { id: c.id, name: c.name, employee_no: c.employee_no, phone: c.phone, destination: destName(c.destination_id), destination_id: c.destination_id,
      deploy_date: r.rotation.start, next_deploy: r.rotation.next_start, days_to_deploy: r.rotation.days_to_deploy, status: r.status, overridden: r.overridden,
      issues: r.items.filter((i) => i.status !== 'green').map((i) => ({ name: i.name, status: i.status })).concat(r.blockers.map((b) => ({ name: b.description, status: 'red' }))),
      fix_by: r.fix_by, passport_masked: mask(p.passport && p.passport.number), dob_masked: p.personal.dob ? `••••-••-${p.personal.dob.slice(-2)}` : '',
      unverified: r.items.filter((i) => i.document && !i.document.verified).length, scenario: c.notes, home_airport: c.home_airport, alt_airport: c.alt_airport, title_id: c.title_id, title: titleName(c.title_id), swing: !!c.swing, on_now: !!onNow(c.id), headshot_status: c.headshot_upload_id ? c.headshot_status : null };
  });
  res.json({ contractors: list });
});
admin.get('/contractors/:id', (req, res) => {
  const c = getContractor(idParam(req.params.id));
  const acct = db.prepare('SELECT email FROM users WHERE contractor_id = ?').get(c.id);
  res.json({ contractor: { ...c, title: titleName(c.title_id) }, account_email: acct ? acct.email : null, readiness: readiness(c), schedule: SCH.blocks(c.id), titles: activeTitles(), profile: getProfile(c.id), uploads: listUploads(c.id),
    flights: db.prepare('SELECT * FROM flights WHERE contractor_id = ? ORDER BY depart_at').all(c.id),
    alerts: db.prepare('SELECT * FROM alerts WHERE contractor_id = ? ORDER BY id DESC LIMIT 30').all(c.id),
    blockers: db.prepare('SELECT * FROM blockers WHERE contractor_id = ? ORDER BY id DESC').all(c.id) });
});
const activeTitles = () => db.prepare('SELECT * FROM titles WHERE active = 1 ORDER BY sort, name').all();
function titleParam(v) {
  if (v === undefined || v === null || v === '') return null;
  const id = idParam(v); if (!db.prepare('SELECT 1 FROM titles WHERE id = ? AND active = 1').get(id)) throw new V.VErr('Pick a title from the list'); return id;
}
function contractorFields(b) {
  const destination_id = b.destination_id ? idParam(b.destination_id) : null;
  if (destination_id && !db.prepare('SELECT 1 FROM destinations WHERE id = ?').get(destination_id)) throw new V.VErr('Unknown destination');
  return { name: V.str(b.name, 120, { required: true, name: 'Name' }), employee_no: V.str(b.employee_no, 40, { required: true, name: 'Employee #' }),
    phone: V.str(b.phone, 40, { name: 'Phone' }), email: V.str(b.email, 120, { name: 'Email', pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ }),
    home_airport: V.str(b.home_airport, 3, { name: 'Home airport', pattern: /^[A-Za-z]{3}$/ }).toUpperCase(),
    alt_airport: V.str(b.alt_airport, 3, { name: 'Alternate airport', pattern: /^[A-Za-z]{3}$/ }).toUpperCase(),
    destination_id, deploy_date: V.date(b.deploy_date, { name: 'Deploy date' }), next_deploy_date: V.date(b.next_deploy_date, { name: 'Next deploy date' }),
    rotation_on: V.int(b.rotation_on ?? 60, 1, 365, 'Days on'), rotation_off: V.int(b.rotation_off ?? 30, 0, 365, 'Days off'), notes: V.str(b.notes, 1000, { name: 'Notes' }), title_id: titleParam(b.title_id) };
}
admin.post('/contractors', (req, res) => {
  const f = contractorFields(req.body);
  const id = Number(db.prepare(`INSERT INTO contractors (name, employee_no, phone, email, home_airport, alt_airport, destination_id, deploy_date, next_deploy_date, rotation_on, rotation_off, notes, title_id)
    VALUES (@name,@employee_no,@phone,@email,@home_airport,@alt_airport,@destination_id,@deploy_date,@next_deploy_date,@rotation_on,@rotation_off,@notes,@title_id)`).run(f).lastInsertRowid);
  if (f.deploy_date) SCH.generate(id, f.deploy_date, f.rotation_on, f.rotation_off, f.destination_id, 3);
  audit(req, 'contractor_create', f.name); res.json({ ok: true, id });
});
admin.put('/contractors/:id', (req, res) => {
  const c = getContractor(idParam(req.params.id)); const f = contractorFields(req.body);
  db.prepare(`UPDATE contractors SET name=@name, employee_no=@employee_no, phone=@phone, email=@email, home_airport=@home_airport, alt_airport=@alt_airport, destination_id=@destination_id,
    deploy_date=@deploy_date, next_deploy_date=@next_deploy_date, rotation_on=@rotation_on, rotation_off=@rotation_off, notes=@notes, title_id=@title_id WHERE id=@id`).run({ ...f, id: c.id });
  // Rotation pattern / start / site changed -> re-lay the schedule from the new start and tell the contractor
  if (f.deploy_date && (f.deploy_date !== c.deploy_date || f.rotation_on !== c.rotation_on || f.rotation_off !== c.rotation_off || f.destination_id !== c.destination_id)) {
    SCH.generate(c.id, f.deploy_date, f.rotation_on, f.rotation_off, f.destination_id, 3);
    sendAlert([c.id], 'info', 'Your schedule changed', `Rotation now starts ${f.deploy_date} (${f.rotation_on} on / ${f.rotation_off} off). Check My Schedule.`, req.user.email);
    audit(req, 'schedule_regen', `${f.name} from ${f.deploy_date} ${f.rotation_on}/${f.rotation_off}`);
  }
  if (f.title_id !== c.title_id) audit(req, 'title_change', `${f.name}: ${titleName(c.title_id) || '—'} → ${titleName(f.title_id) || '—'}`);
  audit(req, 'contractor_update', f.name); res.json({ ok: true });
});
admin.delete('/contractors/:id', (req, res) => {
  const c = getContractor(idParam(req.params.id));
  db.prepare('DELETE FROM users WHERE contractor_id = ?').run(c.id); db.prepare('DELETE FROM contractors WHERE id = ?').run(c.id);
  audit(req, 'contractor_delete', c.name); res.json({ ok: true });
});
admin.put('/contractors/:id/account', (req, res) => {
  const c = getContractor(idParam(req.params.id));
  const email = V.str(req.body.email, 120, { required: true, name: 'Login email', pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ });
  const pw = V.str(req.body.password, 200, { required: true, name: 'Temporary password' });
  if (pw.length < 10) throw new V.VErr('Password must be at least 10 characters');
  const u = db.prepare('SELECT id FROM users WHERE contractor_id = ?').get(c.id);
  if (u) { db.prepare("UPDATE users SET email = ?, password_hash = ?, kind = 'invited', must_setup = 0 WHERE id = ?").run(email, C.hashPassword(pw), u.id); db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); }
  else db.prepare("INSERT INTO users (email, password_hash, role, contractor_id, kind) VALUES (?,?,'contractor',?,'invited')").run(email, C.hashPassword(pw), c.id);
  audit(req, 'account_set', c.name); res.json({ ok: true });
});
const acctFor = (cid) => { const u = db.prepare('SELECT * FROM users WHERE contractor_id = ?').get(cid); if (!u) throw new V.VErr('This contractor has no app login yet — set one first.'); return u; };
const lockState = (email) => { const e = email.toLowerCase(); let worst = 0;
  for (const k of [`lf-acct:${e}`]) worst = Math.max(worst, SEC.peek(k, 3600000));
  return { failures_last_hour: worst, locked: worst >= 50 || SEC.peekMatching(new RegExp(`^lf-acct-ip:${e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`), 5 * 60000) >= 10 }; };
admin.get('/contractors/:id/account', (req, res) => {
  const c = getContractor(idParam(req.params.id)); const u = db.prepare('SELECT * FROM users WHERE contractor_id = ?').get(c.id);
  if (!u) return res.json({ account: null });
  const sess = db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND expires_at > ?').get(u.id, Date.now()).n;
  const last = db.prepare("SELECT at FROM audit_log WHERE user_id = ? AND action = 'login' ORDER BY id DESC LIMIT 1").get(u.id);
  const link = db.prepare('SELECT expires_at, created_by FROM password_resets WHERE user_id = ? AND used_at IS NULL AND expires_at > ?').get(u.id, Date.now());
  res.json({ account: { email: u.email, username: u.username, kind: u.kind, must_setup: !!u.must_setup, temp_pending: !!(u.must_setup && !u.temp_used_at && u.temp_expires_at > Date.now()), temp_expires_at: u.temp_expires_at, must_change: !!u.must_change, pw_changed_at: u.pw_changed_at, sessions: sess, last_login: last ? last.at : null, reset_link_pending: !!link, ...lockState(u.email) } });
});
const readablePw = () => { const W = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; const b = crypto.randomBytes(14);
  const core = [...b].map((x) => W[x % W.length]).join(''); return `${core.slice(0, 4)}-${core.slice(4, 8)}-${core.slice(8, 12)}${'!#%+'[b[12] % 4]}${2 + (b[13] % 8)}`; };
admin.post('/contractors/:id/password/temp', (req, res) => {
  const c = getContractor(idParam(req.params.id)); const u = acctFor(c.id);
  const generated = !req.body.password; const pw = generated ? readablePw() : strong(String(req.body.password), u.email);
  db.prepare("UPDATE users SET password_hash = ?, must_change = 1, pw_changed_at = datetime('now'), failed_logins = 0, locked_until = NULL WHERE id = ?").run(C.hashPassword(pw), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(u.id); clearLockouts(u.email.toLowerCase());
  changedMail(u, 'by an FFD administrator (temporary password — you must pick a new one at next sign-in)');
  audit(req, 'temp_password_set', `${c.name} (${generated ? 'generated' : 'typed by admin'}; sessions ended; must change at next login)`);
  res.set('Cache-Control', 'no-store').json({ ok: true, password: pw, generated, email: u.email }); // shown once, never stored in plain text
});
admin.post('/contractors/:id/password/reset-link', (req, res) => {
  const c = getContractor(idParam(req.params.id)); const u = acctFor(c.id); const force = !!req.body.force;
  if (force) { db.prepare('UPDATE users SET must_change = 1 WHERE id = ?').run(u.id); db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); }
  resetMail(u, issueReset(u, 'admin'), true);
  audit(req, force ? 'password_force_reset' : 'password_reset_link_sent', `${c.name}${force ? ' (sessions ended; must change at next login)' : ''}`);
  res.json({ ok: true, delivered: MAIL.provider() ? 'email' : 'outbox' });
});
admin.post('/contractors/:id/unlock', (req, res) => {
  const c = getContractor(idParam(req.params.id)); const u = acctFor(c.id);
  clearLockouts(u.email.toLowerCase()); db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(u.id);
  const n = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id).changes;
  audit(req, 'account_unlocked', `${c.name} (lockout cleared; ${n} session(s) ended)`); res.json({ ok: true, sessions_ended: n });
});
// Onboard a person with ONE-TIME temporary credentials, delivered only over the mail channel (Outbox in demo mode — stored
// encrypted and redacted once used or expired). Nothing secret is returned to the admin's browser. The temp username +
// password work once, within TEMP_HOURS; the first sign-in must set a permanent username + password.
const TEMP_HOURS = Math.min(72, Math.max(1, Number(process.env.TEMP_CREDENTIAL_HOURS || 24)));
admin.post('/contractors/:id/invite', SEC.limit('invite', 30, 15 * 60000, (r) => `u${r.user.id}`), wrap(async (req, res) => {
  const c = getContractor(idParam(req.params.id));
  const email = V.str(req.body.email || c.email, 120, { required: true, name: 'Email to send the login to', pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ }).toLowerCase();
  let u = db.prepare('SELECT * FROM users WHERE contractor_id = ?').get(c.id);
  const other = db.prepare('SELECT id, kind FROM users WHERE email = ?').get(email);
  if (other && (!u || other.id !== u.id)) throw new V.VErr('That email already belongs to another FFD login.');
  const tmpUser = `tmp-${crypto.randomBytes(5).toString('hex')}`; const tmpPw = readablePw();
  const exp = Date.now() + TEMP_HOURS * 3600000;
  if (u) {
    db.prepare("UPDATE users SET email = ?, username = ?, password_hash = ?, kind = 'invited', must_change = 1, must_setup = 1, temp_expires_at = ?, temp_used_at = NULL WHERE id = ?")
      .run(email, tmpUser, C.hashPassword(tmpPw), exp, u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(u.id);
    redactInvite(u.id, 'replaced by a newer invite');
  } else {
    const r = db.prepare("INSERT INTO users (email, username, password_hash, role, contractor_id, kind, must_change, must_setup, temp_expires_at) VALUES (?,?,?,'contractor',?,'invited',1,1,?)")
      .run(email, tmpUser, C.hashPassword(tmpPw), c.id, exp);
    u = { id: Number(r.lastInsertRowid) };
  }
  clearLockouts(email);
  await MAIL.send(email, 'Your FFD sign-in (one-time temporary login)',
    `Hi ${c.name.split(' ')[0]},\n\nAn FFD administrator set up your access. Sign in once with this temporary login, then choose your own username and password:\n\n`
    + `  Username: ${tmpUser}\n  Temporary password: ${tmpPw}\n\nIt works ONE time and expires ${new Date(exp).toUTCString()}.\n`
    + `Sign in at ${APP_URL} or in the FFD iPhone app.\n\nIf you weren't expecting this, ignore it and tell your FFD administrator.\n\n— FFD · Fit For Deployment`,
    'invite', { sensitive: true, ref: `invite:${u.id}` });
  audit(req, 'temp_credentials_issued', `${c.name} → ${email} (one-time, expires in ${TEMP_HOURS}h)`);
  res.json({ ok: true, delivered: MAIL.provider() ? 'email' : 'outbox', to: email.replace(/^(.).*?(@.*)$/, '$1•••$2'), expires_at: exp });
}));
admin.get('/outbox', (req, res) => {
  if (!DEMO_MODE && process.env.MAIL_OUTBOX !== '1') return res.json({ enabled: false, messages: [] });
  res.set('Cache-Control', 'no-store').json({ enabled: true, provider: MAIL.provider() || null, messages: db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 200').all().map(MAIL.view) });
});
admin.put('/contractors/:id/documents/:typeId', (req, res) => {
  const c = getContractor(idParam(req.params.id)); const typeId = idParam(req.params.typeId);
  const rt = db.prepare('SELECT * FROM requirement_types WHERE id = ?').get(typeId); if (!rt) throw nf();
  const issued = V.date(req.body.issued, { name: rt.is_check ? 'Completion date' : 'Issued' });
  let uploadId = null;
  if (req.body.file) uploadId = storeUpload(c.id, { label: rt.name, ...req.body.file }, 'admin');
  upsertDoc(c.id, typeId, { ref_last4: V.str(req.body.ref_last4, 4, { name: 'Last 4' }), issued,
    expires: rt.is_check ? defaultExpiry(rt, issued, V.date(req.body.expires, { name: 'Renewal date' })) : V.date(req.body.expires, { name: 'Expires' }),
    status: V.str(req.body.status || 'valid', 10, { name: 'Status', oneOf: ['valid', 'pending', 'rejected'] }),
    check_status: rt.is_check ? V.str(req.body.check_status || 'not_started', 12, { name: 'Check status', oneOf: CHECK_STATUSES }) : null,
    provider: V.str(req.body.provider, 80, { name: 'Provider' }), reference: V.str(req.body.reference, 60, { name: 'Reference #' }), upload_id: uploadId,
    notes: V.str(req.body.notes, 300, { name: 'Notes' }), verified: req.body.verified === false ? 0 : 1, source: 'admin' });
  audit(req, 'document_upsert', `${c.name} type ${typeId}`); res.json({ ok: true, readiness: readiness(c) });
});
admin.post('/contractors/:id/documents/:typeId/verify', (req, res) => {
  const c = getContractor(idParam(req.params.id));
  db.prepare('UPDATE documents SET verified = 1 WHERE contractor_id = ? AND requirement_type_id = ?').run(c.id, idParam(req.params.typeId));
  audit(req, 'document_verify', `${c.name} type ${req.params.typeId}`); res.json({ ok: true, readiness: readiness(c) });
});
admin.delete('/contractors/:id/documents/:typeId', (req, res) => {
  const c = getContractor(idParam(req.params.id));
  db.prepare('DELETE FROM documents WHERE contractor_id = ? AND requirement_type_id = ?').run(c.id, idParam(req.params.typeId));
  audit(req, 'document_delete', `${c.name} type ${req.params.typeId}`); res.json({ ok: true });
});
admin.put('/contractors/:id/override', (req, res) => {
  const c = getContractor(idParam(req.params.id));
  const status = V.str(req.body.status, 6, { name: 'Override', oneOf: ['red', 'yellow', 'green'] }) || null;
  const reason = V.str(req.body.reason, 300, { name: 'Reason', required: !!status });
  db.prepare('UPDATE contractors SET override_status = ?, override_reason = ? WHERE id = ?').run(status, status ? reason : null, c.id);
  audit(req, 'override', `${c.name}: ${status || 'cleared'} ${reason}`); res.json({ ok: true, readiness: readiness(getContractor(c.id)) });
});
admin.post('/contractors/:id/blockers', (req, res) => {
  const c = getContractor(idParam(req.params.id));
  db.prepare('INSERT INTO blockers (contractor_id, description) VALUES (?,?)').run(c.id, V.str(req.body.description, 300, { required: true, name: 'Blocker' }));
  audit(req, 'blocker_add', c.name); res.json({ ok: true });
});
admin.put('/blockers/:id', (req, res) => {
  db.prepare('UPDATE blockers SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, idParam(req.params.id));
  audit(req, 'blocker_toggle', req.params.id); res.json({ ok: true });
});
admin.get('/contractors/:id/profile', (req, res) => res.json({ profile: getProfile(getContractor(idParam(req.params.id)).id) }));
admin.put('/contractors/:id/profile', (req, res) => {
  const c = getContractor(idParam(req.params.id)); const p = V.profile(req.body.profile);
  saveProfile(c.id, p, 'admin'); audit(req, 'profile_update_admin', c.name); res.json({ ok: true });
});
admin.post('/contractors/:id/uploads', (req, res) => {
  const c = getContractor(idParam(req.params.id)); const id = storeUpload(c.id, req.body, 'admin'); audit(req, 'upload_admin', c.name); res.json({ ok: true, id });
});
function flightFields(b) {
  return { airline: V.str(b.airline, 80, { required: true, name: 'Airline' }), flight_no: V.str(b.flight_no, 20, { required: true, name: 'Flight #' }),
    from_airport: V.str(b.from_airport, 3, { required: true, name: 'From', pattern: /^[A-Za-z]{3}$/ }).toUpperCase(),
    to_airport: V.str(b.to_airport, 3, { required: true, name: 'To', pattern: /^[A-Za-z]{3}$/ }).toUpperCase(),
    depart_at: V.dt(b.depart_at, { required: true, name: 'Departure' }), arrive_at: V.dt(b.arrive_at, { name: 'Arrival' }),
    confirmation: V.str(b.confirmation, 20, { name: 'Confirmation #' }), seat: V.str(b.seat, 8, { name: 'Seat' }), notes: V.str(b.notes, 500, { name: 'Notes' }),
    direction: V.str(b.direction, 8, { name: 'Direction', oneOf: ['outbound', 'return'] }) || null };
}
const insFlight = (cid, f) => db.prepare(`INSERT INTO flights (contractor_id, airline, flight_no, from_airport, to_airport, depart_at, arrive_at, confirmation, seat, notes, direction)
  VALUES (@cid,@airline,@flight_no,@from_airport,@to_airport,@depart_at,@arrive_at,@confirmation,@seat,@notes,@direction)`).run({ direction: null, ...f, cid });
admin.post('/contractors/:id/flights', (req, res) => {
  const c = getContractor(idParam(req.params.id)); const f = flightFields(req.body);
  insFlight(c.id, f);
  if (req.body.notify !== false) sendAlert([c.id], 'flight', `New flight: ${f.flight_no} ${f.from_airport}→${f.to_airport}`, `Departs ${f.depart_at.replace('T', ' ')}${f.confirmation ? ` · Conf ${f.confirmation}` : ''}`, req.user.email);
  audit(req, 'flight_send', `${c.name} ${f.flight_no}`); res.json({ ok: true });
});
admin.put('/flights/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM flights WHERE id = ?').get(idParam(req.params.id)); if (!old) throw nf();
  const f = flightFields(req.body);
  db.prepare(`UPDATE flights SET airline=@airline, flight_no=@flight_no, from_airport=@from_airport, to_airport=@to_airport, depart_at=@depart_at, arrive_at=@arrive_at,
    confirmation=@confirmation, seat=@seat, notes=@notes, direction=COALESCE(@direction, direction), seen_at=NULL, updated_at=datetime('now') WHERE id=@id`).run({ ...f, id: old.id });
  const changes = ['flight_no', 'from_airport', 'to_airport', 'depart_at', 'arrive_at', 'seat', 'confirmation'].filter((k) => (old[k] || '') !== (f[k] || ''))
    .map((k) => `${k.replace('_at', '').replace('_', ' ')}: ${old[k] || '—'} → ${f[k] || '—'}`.replace(/T(\d\d:\d\d)/g, ' $1'));
  sendAlert([old.contractor_id], 'flight', `Flight changed: ${f.flight_no}`, changes.length ? changes.join('; ') : 'Details updated — check the Flights tab.', req.user.email);
  audit(req, 'flight_update', `${old.contractor_id} ${f.flight_no}`); res.json({ ok: true });
});
admin.delete('/flights/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM flights WHERE id = ?').get(idParam(req.params.id)); if (!f) throw nf();
  db.prepare('DELETE FROM flights WHERE id = ?').run(f.id);
  sendAlert([f.contractor_id], 'flight', `Flight cancelled: ${f.flight_no}`, `${f.from_airport}→${f.to_airport} on ${f.depart_at.replace('T', ' ')} was removed from your itinerary.`, req.user.email);
  audit(req, 'flight_delete', `${f.contractor_id} ${f.flight_no}`); res.json({ ok: true });
});
admin.post('/alerts', SEC.limit('alerts', 30, 10 * 60000), (req, res) => {
  let ids;
  if (req.body.to === 'all') ids = db.prepare('SELECT id FROM contractors').all().map((r) => r.id);
  else if (['red', 'yellow', 'green'].includes(req.body.to)) ids = db.prepare('SELECT * FROM contractors').all().filter((c) => readiness(c).status === req.body.to).map((c) => c.id);
  else {
    if (!Array.isArray(req.body.contractor_ids) || !req.body.contractor_ids.length) throw new V.VErr('Pick at least one contractor');
    ids = [...new Set(req.body.contractor_ids.map(idParam))].filter((id) => db.prepare('SELECT 1 FROM contractors WHERE id = ?').get(id));
  }
  const kind = V.str(req.body.kind || 'info', 10, { name: 'Type', oneOf: ['info', 'flight', 'urgent', 'readiness'] });
  const title = V.str(req.body.title, 120, { required: true, name: 'Title' }); const body = V.str(req.body.body, 1000, { name: 'Message' });
  sendAlert(ids, kind, title, body, req.user.email);
  audit(req, 'alert_send', `${ids.length} recipients: ${title}`); res.json({ ok: true, sent: ids.length });
});
admin.get('/destinations', (req, res) => {
  res.json({ destinations: db.prepare('SELECT * FROM destinations ORDER BY name').all().map((d) => ({ ...d, requirement_ids: getReqs(d.id).map((r) => r.id) })),
    requirement_types: db.prepare('SELECT * FROM requirement_types ORDER BY category, name').all() });
});
function saveDest(req, id) {
  const f = { name: V.str(req.body.name, 120, { required: true, name: 'Name' }), country: V.str(req.body.country, 80, { required: true, name: 'Country' }),
    region: V.str(req.body.region, 40, { name: 'Region' }), airport: V.str(req.body.airport, 3, { name: 'Airport', pattern: /^[A-Za-z]{3}$/ }).toUpperCase(), notes: V.str(req.body.notes, 300, { name: 'Notes' }) };
  if (id) db.prepare('UPDATE destinations SET name=@name, country=@country, region=@region, airport=@airport, notes=@notes WHERE id=@id').run({ ...f, id });
  else id = Number(db.prepare('INSERT INTO destinations (name, country, region, airport, notes) VALUES (@name,@country,@region,@airport,@notes)').run(f).lastInsertRowid);
  db.prepare('DELETE FROM destination_requirements WHERE destination_id = ?').run(id);
  for (const r of (Array.isArray(req.body.requirement_ids) ? req.body.requirement_ids : [])) {
    const rid = idParam(r); if (db.prepare('SELECT 1 FROM requirement_types WHERE id = ?').get(rid)) db.prepare('INSERT OR IGNORE INTO destination_requirements VALUES (?,?)').run(id, rid);
  }
  audit(req, 'destination_save', f.name); return id;
}
admin.post('/destinations', (req, res) => res.json({ ok: true, id: saveDest(req) }));
admin.put('/destinations/:id', (req, res) => res.json({ ok: true, id: saveDest(req, idParam(req.params.id)) }));
function saveRt(req, id) {
  const f = { name: V.str(req.body.name, 80, { required: true, name: 'Name' }),
    category: V.str(req.body.category, 20, { required: true, name: 'Category', oneOf: ['passport', 'visa', 'immunization', 'id', 'clearance', 'other'] }),
    has_expiry: req.body.has_expiry ? 1 : 0, min_validity_days: V.int(req.body.min_validity_days ?? 0, 0, 730, 'Validity buffer'),
    lead_days: V.int(req.body.lead_days ?? 30, 0, 365, 'Lead time'), is_check: req.body.is_check ? 1 : 0,
    validity_days: V.int(req.body.validity_days ?? 0, 0, 3650, 'Default validity'), instructions: V.str(req.body.instructions, 500, { name: 'Instructions' }), keyword: V.str(req.body.keyword, 40, { name: 'Keyword' }).toLowerCase() };
  if (id) db.prepare('UPDATE requirement_types SET name=@name, category=@category, has_expiry=@has_expiry, min_validity_days=@min_validity_days, lead_days=@lead_days, is_check=@is_check, validity_days=@validity_days, instructions=@instructions, keyword=@keyword WHERE id=@id').run({ ...f, id });
  else id = Number(db.prepare('INSERT INTO requirement_types (name, category, has_expiry, min_validity_days, lead_days, is_check, validity_days, instructions, keyword) VALUES (@name,@category,@has_expiry,@min_validity_days,@lead_days,@is_check,@validity_days,@instructions,@keyword)').run(f).lastInsertRowid);
  audit(req, 'requirement_type_save', f.name); return id;
}
admin.post('/requirement-types', (req, res) => res.json({ ok: true, id: saveRt(req) }));
admin.put('/requirement-types/:id', (req, res) => res.json({ ok: true, id: saveRt(req, idParam(req.params.id)) }));
admin.post('/assistant/plan', SEC.limit('assistant', 60, 5 * 60000), (req, res) => {
  const text = V.str(req.body.text, 500, { required: true, name: 'Request' });
  audit(req, 'assistant_plan', text); res.json(assistant.plan(text));
});
admin.post('/assistant/book', (req, res) => {
  const c = getContractor(idParam(req.body.contractor_id));
  const r = readiness(c);
  const destId = idParam(req.body.destination_id);
  // Re-check readiness server-side against the target destination; red blocks booking.
  const sim = assistant.plan(`${c.employee_no} ${db.prepare('SELECT name FROM destinations WHERE id = ?').get(destId)?.name || ''} ${req.body.depart_date || ''}`);
  if (!sim.ok) throw new V.VErr(sim.message);
  if (!sim.can_book) return res.status(409).json({ error: `Booking blocked: ${c.name} is RED for ${sim.destination.name}. ${sim.summary}` });
  const fare = sim.fares.find((f) => f.id === req.body.fare_id || (!req.body.fare_id && f.airline === req.body.airline));
  if (!fare) throw new V.VErr('Pick one of the offered fares');
  const conf = `RT${C.token().replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 5)}`;
  fare.legs.forEach((l, i) => insFlight(c.id, { airline: l.airline, flight_no: l.flight_no, from_airport: l.from_airport, to_airport: l.to_airport,
    depart_at: l.depart_at || (i ? fare.legs[i - 1].arrive_at || fare.depart_at : fare.depart_at), arrive_at: l.arrive_at || null, confirmation: conf, seat: '',
    notes: `Booked via FFD assistant · DEMO fare $${fare.price_usd}`, direction: 'outbound' }));
  if (sim.destination.id !== c.destination_id || sim.depart_date !== c.deploy_date) {
    db.prepare('UPDATE contractors SET destination_id = ?, deploy_date = ? WHERE id = ?').run(sim.destination.id, sim.depart_date, c.id);
    SCH.generate(c.id, sim.depart_date, c.rotation_on, c.rotation_off, sim.destination.id, 3); // schedule follows the booking
  }
  sendAlert([c.id], 'flight', `Travel booked: ${sim.destination.name}`, `${fare.airline} via ${fare.via}, departs ${fare.depart_at.replace('T', ' ')} · Conf ${conf}`, req.user.email);
  audit(req, 'assistant_book', `${c.name} → ${sim.destination.name} ${fare.airline} $${fare.price_usd} (prev status ${r.status})`);
  res.json({ ok: true, confirmation: conf });
});
admin.get('/audit', (req, res) => res.json({ log: db.prepare('SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 200').all() }));
admin.post('/demo/reset', (req, res) => {
  if (!DEMO_MODE) return res.status(403).json({ error: 'Demo mode is off' });
  const who = req.user.email;
  resetDemo(`manual reset by ${who}`); clearCookies(res); res.json({ ok: true });
});
// ---------------- Daily Deployment Report ----------------
const addD = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
function flightDirection(f, c) {
  if (f.direction) return f.direction;
  const home = [c.home_airport, c.alt_airport].filter(Boolean);
  if (home.includes(f.from_airport)) return 'outbound';
  if (home.includes(f.to_airport)) return 'return';
  return null;
}
function dailyReport(from, days) {
  const to = addD(from, days - 1); const rows = []; const nowMs = Date.now();
  for (const c of db.prepare('SELECT * FROM contractors ORDER BY name').all()) {
    const r = readiness(c); const flights = db.prepare('SELECT * FROM flights WHERE contractor_id = ? ORDER BY depart_at').all(c.id);
    // group flights into trips by confirmation (or by day when there is none), with a direction
    const trips = new Map();
    for (const f of flights) {
      const key = f.confirmation || `${f.id}`; const t = trips.get(key) || { legs: [], dir: null }; t.legs.push(f); t.dir = t.dir || flightDirection(f, c); trips.set(key, t);
    }
    const tripList = [...trips.values()].map((t) => ({ ...t, dir: t.dir || 'outbound', date: t.legs[0].depart_at.slice(0, 10) }));
    const events = [];
    // scheduled rotation changes from the crew schedule (outbound on ON-block start, return on ON-block end)
    for (const b of SCH.onBlocks(c.id)) for (const [date, dir] of [[b.start, 'outbound'], [b.end, 'return']]) {
      if (date < from || date > to) continue;
      const trip = tripList.find((t) => t.dir === dir && Math.abs(Date.parse(t.date) - Date.parse(date)) <= 2 * 86400000);
      events.push({ date: trip ? trip.date : date, scheduled: date, dir, trip, dest_id: b.destination_id });
    }
    // booked trips in range that aren't tied to a scheduled change
    for (const t of tripList) if (t.date >= from && t.date <= to && !events.some((e) => e.trip === t)) events.push({ date: t.date, scheduled: null, dir: t.dir, trip: t });
    if (!events.length) continue;
    const p = getProfile(c.id); const ec = (p.emergency_contacts || [])[0] || null;
    for (const e of events) {
      const dest = db.prepare('SELECT * FROM destinations WHERE id = ?').get(e.dest_id || c.destination_id || 0) || {};
      const legs = e.trip ? e.trip.legs : [];
      const flags = [];
      if (r.status !== 'green') flags.push({ code: `status_${r.status}`, label: `${r.status.toUpperCase()} status traveling` });
      if (!legs.length) flags.push({ code: 'no_flight', label: 'No flight booked for scheduled rotation change' });
      const changed = legs.filter((l) => l.updated_at && nowMs - Date.parse(l.updated_at.replace(' ', 'T') + 'Z') < 86400000);
      if (changed.length) flags.push({ code: 'changed_24h', label: `Flight change pushed in last 24h (${changed.map((l) => l.flight_no).join(', ')})` });
      rows.push({ date: e.date, scheduled_rotation_date: e.scheduled, direction: e.dir, contractor: { id: c.id, name: c.name, employee_no: c.employee_no, title: titleName(c.title_id) },
        status: r.status, destination: dest.name || '—', destination_airport: dest.airport || '', home_airport: c.home_airport || '', alt_airport: c.alt_airport || '',
        emergency_contact: ec ? { name: ec.name, relationship: ec.relationship, phone: ec.phone, alt_phone: ec.alt_phone, email: ec.email } : null,
        confirmation: legs[0] ? legs[0].confirmation : '', connections: legs.slice(0, -1).map((l) => l.to_airport),
        legs: legs.map((l) => ({ airline: l.airline, flight_no: l.flight_no, from: l.from_airport, to: l.to_airport, depart_local: l.depart_at, arrive_local: l.arrive_at, seat: l.seat, confirmation: l.confirmation, changed_at: l.updated_at })),
        flags });
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.direction.localeCompare(b.direction) || a.contractor.name.localeCompare(b.contractor.name));
  const summary = { departing: rows.filter((x) => x.direction === 'outbound').length, returning: rows.filter((x) => x.direction === 'return').length,
    flagged: rows.filter((x) => x.flags.length).length, red_traveling: rows.filter((x) => x.status === 'red').length, yellow_traveling: rows.filter((x) => x.status === 'yellow').length,
    no_flight: rows.filter((x) => x.flags.some((f) => f.code === 'no_flight')).length, changed_24h: rows.filter((x) => x.flags.some((f) => f.code === 'changed_24h')).length };
  TK.propose();
  const tq = TK.list('pending'); const ts = TK.summary();
  summary.tickets_to_approve = tq.length;
  const tickets_to_approve = { count: tq.length, headline: ts.text || 'No tickets waiting for approval', names: tq.map((t) => t.contractor.name),
    items: tq.map((t) => ({ id: t.id, contractor: t.contractor.name, employee_no: t.contractor.employee_no, days_out: t.days_out, depart_date: t.depart_date,
      destination: t.destination, route: [t.fare.origin, ...t.fare.legs.map((l) => l.to_airport)].join('-'), airline: t.fare.airline, cabin: t.fare.cabin_label,
      price_usd: t.fare.price_usd, readiness: t.readiness })) };
  return { from, to, days, generated_at: new Date().toISOString(), summary, tickets_to_approve, rows };
}
function reportParams(req) {
  const today = fmtToday();
  const from = V.date(req.query.date, { name: 'date' }) || today;
  const days = req.query.days === undefined ? 1 : V.int(req.query.days, 1, 31, 'days');
  return { from, days };
}
const reportDaily = (req, res) => { const { from, days } = reportParams(req); audit(req, 'report_view', `${from} +${days}d${req.user.via === 'token' ? ' (report token)' : ''}`); res.json(dailyReport(from, days)); };
admin.get('/reports/daily', reportDaily);
// Read-only report token (for the 6am digest): Bearer token whose SHA-256 is in env REPORT_TOKEN_SHA256.
// It is accepted ONLY on GET /api/admin/reports/daily; everything else still needs an admin session.
// Lives in the environment, not the DB, so the nightly demo reseed can't invalidate it.
app.get('/api/admin/reports/daily', SEC.limit('rtok', 120, 15 * 60000), (req, res, next) => {
  const h = req.get('authorization') || '';
  if (!/^Bearer /i.test(h)) return next();
  const want = (process.env.REPORT_TOKEN_SHA256 || '').trim().toLowerCase();
  const got = C.sha256(h.slice(7).trim());
  if (!/^[0-9a-f]{64}$/.test(want) || !crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex'))) {
    audit(req, 'report_token_rejected', ''); return res.status(401).json({ error: 'Invalid report token' });
  }
  req.user = { id: null, email: 'report-token', role: 'report', via: 'token' };
  wrap(async () => reportDaily(req, res))(req, res, next);
});
admin.get('/reports/daily.csv', (req, res) => {
  const { from, days } = reportParams(req); const rep = dailyReport(from, days);
  // CSV-injection safe: cells starting with = + - @ are prefixed with '
  const cell = (v) => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; return `"${t.replace(/"/g, '""')}"`; };
  const lines = [['Date', 'Direction', 'Contractor', 'Employee #', 'Title', 'Status', 'Destination', 'Home airport', 'Alt airport', 'Confirmation', 'Itinerary', 'Seats', 'Connections', 'Flags', 'Emergency contact', 'EC phone'].map(cell).join(',')];
  for (const x of rep.rows) lines.push([x.date, x.direction, x.contractor.name, x.contractor.employee_no, x.contractor.title, x.status, x.destination, x.home_airport, x.alt_airport, x.confirmation,
    x.legs.map((l) => `${l.airline} ${l.flight_no} ${l.from} ${l.depart_local.replace('T', ' ')} -> ${l.to} ${String(l.arrive_local || '').replace('T', ' ')}`).join(' | ') || 'NO FLIGHT BOOKED',
    x.legs.map((l) => l.seat).filter(Boolean).join(' / '), x.connections.join(' '), x.flags.map((f) => f.label).join('; '),
    x.emergency_contact ? `${x.emergency_contact.name} (${x.emergency_contact.relationship})` : '', x.emergency_contact ? x.emergency_contact.phone : ''].map(cell).join(','));
  audit(req, 'report_csv', `${from} +${days}d`);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="ffd-deployment-report-${from}-${days}d.csv"` }).send('\ufeff' + lines.join('\r\n'));
});
admin.get('/contractors/:id/badge', (req, res) => res.json(badge(getContractor(idParam(req.params.id)))));
admin.post('/contractors/:id/headshot', SEC.limit('headshot', 30, 60 * 60000), (req, res) => {
  const c = getContractor(idParam(req.params.id)); const st = storeHeadshot(c, { ...req.body, approve: true }, 'admin');
  audit(req, 'headshot_upload_admin', c.name); res.json({ ok: true, status: st });
});
admin.post('/contractors/:id/headshot/review', (req, res) => {
  const c = getContractor(idParam(req.params.id));
  if (!c.headshot_upload_id) throw new V.VErr('No headshot uploaded yet');
  const decision = V.str(req.body.decision, 10, { required: true, name: 'Decision', oneOf: ['approved', 'rejected'] });
  const note = V.str(req.body.note, 200, { name: 'Note' });
  db.prepare('UPDATE contractors SET headshot_status = ?, headshot_note = ? WHERE id = ?').run(decision, note, c.id);
  sendAlert([c.id], 'readiness', decision === 'approved' ? 'Headshot approved' : 'Headshot needs a retake', decision === 'approved' ? 'Your ID badge now shows your photo.' : `Please retake your headshot${note ? `: ${note}` : '.'}`, req.user.email);
  audit(req, `headshot_${decision}`, `${c.name}${note ? `: ${note}` : ''}`); res.json({ ok: true });
});
// ---------------- Crew schedule ----------------
admin.get('/schedule', (req, res) => {
  const t = fmtToday();
  const from = V.date(req.query.from, { name: 'from' }) || `${t.slice(0, 8)}01`;
  const days = req.query.days === undefined ? 92 : V.int(req.query.days, 7, 186, 'days');
  const to = SCH.plus(from, days - 1);
  const titleF = req.query.title ? idParam(req.query.title) : null;
  const siteF = req.query.site ? idParam(req.query.site) : null; const crewF = ['on', 'off', 'swing'].includes(req.query.crew) ? req.query.crew : '';
  const onIn = (cid) => db.prepare("SELECT 1 FROM schedule_blocks WHERE contractor_id = ? AND kind = 'on' AND start <= ? AND end >= ?").get(cid, to, from);
  const cs = db.prepare('SELECT * FROM contractors ORDER BY name').all().filter((c) => (!titleF || c.title_id === titleF) && (!siteF || c.destination_id === siteF)
    && (!crewF || (crewF === 'swing' ? c.swing : crewF === 'on' ? onIn(c.id) : !onIn(c.id))));
  const per = req.query.per === undefined ? 25 : V.int(req.query.per, 5, 500, 'per'); const pages = Math.max(1, Math.ceil(cs.length / per));
  const page = Math.min(pages - 1, req.query.page === undefined ? 0 : V.int(req.query.page, 0, 1000, 'page'));
  const contractors = cs.slice(page * per, page * per + per).map((c) => {
    const r = readiness(c);
    return { id: c.id, name: c.name, title: titleName(c.title_id), title_id: c.title_id, status: r.status, destination: destName(c.destination_id), rotation_on: c.rotation_on, rotation_off: c.rotation_off,
      next_start: r.rotation.next_start, fix_by: r.fix_by, swing: !!c.swing,
      blocks: db.prepare('SELECT * FROM schedule_blocks WHERE contractor_id = ? AND start <= ? AND end >= ? ORDER BY start').all(c.id, to, from) };
  });
  res.json({ from, to, days, today: t, total: cs.length, page, pages, per, contractors, destinations: db.prepare('SELECT id, name, min_headcount, max_headcount FROM destinations ORDER BY name').all(),
    coverage: SCH.coverage(from, days), conflicts: SCH.conflicts(from, to, cs, readiness), titles: activeTitles() });
});
function blockFields(b) {
  const kind = V.str(b.kind, 10, { required: true, name: 'Type', oneOf: SCH.KINDS });
  const start = V.date(b.start, { name: 'Start', required: true }); const end = V.date(b.end, { name: 'End', required: true });
  if (!start || !end) throw new V.VErr('Start and end dates are required');
  if (end < start) throw new V.VErr('End date is before start date');
  if ((Date.parse(end) - Date.parse(start)) / 86400000 > 366) throw new V.VErr('A block can be at most a year long');
  const destination_id = kind === 'on' ? (b.destination_id ? idParam(b.destination_id) : null) : null;
  if (kind === 'on' && !destination_id) throw new V.VErr('Pick the site for an ON rotation');
  if (destination_id && !db.prepare('SELECT 1 FROM destinations WHERE id = ?').get(destination_id)) throw new V.VErr('Unknown site');
  return { kind, start, end, destination_id, notes: V.str(b.notes, 300, { name: 'Notes' }) };
}
function checkOverlap(cid, f, selfId) {
  if (f.kind !== 'on') return;
  const clash = db.prepare("SELECT * FROM schedule_blocks WHERE contractor_id = ? AND kind = 'on' AND id != ? AND start <= ? AND end >= ?").get(cid, selfId || 0, f.end, f.start);
  if (clash) throw new V.VErr(`Overlaps another ON rotation (${clash.start} → ${clash.end})`);
}
const KIND_LABEL = { on: 'ON rotation', off: 'OFF', travel: 'Travel', training: 'Training', leave: 'Leave' };
function scheduleChanged(req, cid, verb, f, before) {
  SCH.sync(cid);
  const c = getContractor(cid);
  const what = `${KIND_LABEL[f.kind]}${f.destination_id ? ` at ${destName(f.destination_id)}` : ''} ${f.start} → ${f.end}`;
  audit(req, `schedule_${verb}`, `${c.name}: ${what}${before ? ` (was ${before.start} → ${before.end})` : ''}`);
  sendAlert([cid], 'info', `Schedule ${verb === 'delete' ? 'change' : 'update'}: ${KIND_LABEL[f.kind]}`,
    `${verb === 'delete' ? 'Removed' : verb === 'create' ? 'Added' : 'Now'}: ${what}. Open My Schedule for details.`, req.user.email);
}
admin.post('/schedule/blocks', (req, res) => {
  const c = getContractor(idParam(req.body.contractor_id)); const f = blockFields(req.body); checkOverlap(c.id, f);
  const id = Number(db.prepare('INSERT INTO schedule_blocks (contractor_id, kind, start, end, destination_id, notes) VALUES (?,?,?,?,?,?)').run(c.id, f.kind, f.start, f.end, f.destination_id, f.notes).lastInsertRowid);
  scheduleChanged(req, c.id, 'create', f); res.json({ ok: true, id });
});
admin.put('/schedule/blocks/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM schedule_blocks WHERE id = ?').get(idParam(req.params.id)); if (!b) throw nf();
  const f = blockFields({ ...b, ...req.body }); checkOverlap(b.contractor_id, f, b.id);
  db.prepare("UPDATE schedule_blocks SET kind=?, start=?, end=?, destination_id=?, notes=?, updated_at=datetime('now') WHERE id=?").run(f.kind, f.start, f.end, f.destination_id, f.notes, b.id);
  scheduleChanged(req, b.contractor_id, 'update', f, b); res.json({ ok: true });
});
admin.delete('/schedule/blocks/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM schedule_blocks WHERE id = ?').get(idParam(req.params.id)); if (!b) throw nf();
  db.prepare('DELETE FROM schedule_blocks WHERE id = ?').run(b.id);
  scheduleChanged(req, b.contractor_id, 'delete', b); res.json({ ok: true });
});
admin.post('/contractors/:id/schedule/generate', (req, res) => {
  const c = getContractor(idParam(req.params.id));
  const start = V.date(req.body.start, { name: 'Start', required: true }); if (!start) throw new V.VErr('Start date is required');
  const on = V.int(req.body.on ?? c.rotation_on, 1, 365, 'Days on'); const off = V.int(req.body.off ?? c.rotation_off, 0, 365, 'Days off');
  const cycles = V.int(req.body.cycles ?? 3, 1, 8, 'Cycles');
  const dest = req.body.destination_id ? idParam(req.body.destination_id) : c.destination_id;
  if (!dest || !db.prepare('SELECT 1 FROM destinations WHERE id = ?').get(dest)) throw new V.VErr('Pick the site');
  db.prepare('UPDATE contractors SET rotation_on = ?, rotation_off = ? WHERE id = ?').run(on, off, c.id);
  SCH.generate(c.id, start, on, off, dest, cycles);
  audit(req, 'schedule_generate', `${c.name}: ${cycles}× ${on} on / ${off} off from ${start} at ${destName(dest)}`);
  sendAlert([c.id], 'info', 'Your schedule changed', `New rotation plan: ${on} on / ${off} off starting ${start} at ${destName(dest)}. Open My Schedule.`, req.user.email);
  res.json({ ok: true });
});
admin.put('/destinations/:id/targets', (req, res) => {
  const d = db.prepare('SELECT * FROM destinations WHERE id = ?').get(idParam(req.params.id)); if (!d) throw nf();
  const min = V.int(req.body.min ?? 0, 0, 500, 'Minimum headcount');
  const max = req.body.max === '' || req.body.max === null || req.body.max === undefined ? null : V.int(req.body.max, 1, 500, 'Maximum headcount');
  if (max !== null && max < min) throw new V.VErr('Maximum is below minimum');
  db.prepare('UPDATE destinations SET min_headcount = ?, max_headcount = ? WHERE id = ?').run(min, max, d.id);
  audit(req, 'coverage_targets', `${d.name}: min ${min} max ${max ?? '—'}`); res.json({ ok: true });
});
// ---------------- Crew size, on-rotation targets, swing / fill-in ----------------
const crewSettings = () => ({ total_target: Number(db.meta.get('crew_total_target') || 80), on_target: Number(db.meta.get('crew_on_target') || 25) });
admin.put('/crew/settings', (req, res) => {
  const total = V.int(req.body.total_target, 1, 5000, 'Total crew headcount'); const on = V.int(req.body.on_target, 0, 5000, 'Target on rotation');
  if (on > total) throw new V.VErr('Target on rotation cannot exceed total headcount');
  db.meta.set('crew_total_target', String(total)); db.meta.set('crew_on_target', String(on));
  audit(req, 'crew_settings', `total ${total}, on rotation ${on}`); res.json({ ok: true, settings: crewSettings() });
});
admin.put('/contractors/:id/swing', (req, res) => {
  const c = getContractor(idParam(req.params.id)); const v = req.body.swing ? 1 : 0;
  db.prepare('UPDATE contractors SET swing = ? WHERE id = ?').run(v, c.id); audit(req, 'swing_flag', `${c.name}: ${v ? 'swing / fill-in' : 'regular rotation'}`); res.json({ ok: true, swing: !!v });
});
const busy = (cid, start, end) => db.prepare("SELECT * FROM schedule_blocks WHERE contractor_id = ? AND kind != 'off' AND start <= ? AND end >= ?").all(cid, end, start);
function firstGap(siteCov) { // first run of days below target in a coverage row
  let g = null;
  for (const d of siteCov.days) {
    if (d.state === 'gap') { if (!g) g = { start: d.date, end: d.date, short: 0 }; g.end = d.date; g.short = Math.max(g.short, siteCov.min - d.headcount); } else if (g) break;
  }
  return g;
}
function swingFit(c, siteId, start, end) {
  const r = evaluate({ ...c, destination_id: siteId, deploy_date: start, _on: [{ kind: 'on', start, end, destination_id: siteId }] }, getReqs(siteId),
    db.prepare('SELECT * FROM documents WHERE contractor_id = ?').all(c.id), db.prepare('SELECT * FROM blockers WHERE contractor_id = ?').all(c.id));
  const clash = busy(c.id, start, end);
  return { id: c.id, name: c.name, title: titleName(c.title_id), employee_no: c.employee_no, home_site: destName(c.destination_id), status: r.status,
    issues: r.items.filter((i) => i.status !== 'green').map((i) => ({ name: i.name, status: i.status })).concat(r.blockers.map((b) => ({ name: b.description, status: 'red' }))),
    available: !clash.length, busy: clash.map((b) => `${b.kind} ${b.start} → ${b.end}`), headshot: !!c.headshot_upload_id };
}
const rank = { green: 0, yellow: 1, red: 2 };
admin.get('/crew', (req, res) => {
  const day = req.query.date ? V.date(req.query.date, { name: 'Date' }) : fmtToday();
  const cov = SCH.coverage(day, 90); const all = db.prepare('SELECT * FROM contractors ORDER BY name').all();
  const sites = cov.map((sc) => { const t = sc.days[0]; const gap = firstGap(sc);
    return { id: sc.site_id, name: sc.site, target: sc.min, max: sc.max, on: t.headcount, who: t.who, short: Math.max(0, sc.min - t.headcount), gap_days_90: sc.gap_days, next_gap: gap }; });
  const swing = all.filter((c) => c.swing).map((c) => { const st = readiness(c).status; const on = db.prepare("SELECT * FROM schedule_blocks WHERE contractor_id = ? AND kind = 'on' AND end >= ? ORDER BY start LIMIT 1").get(c.id, day);
    return { id: c.id, name: c.name, title: titleName(c.title_id), status: st, home_site: destName(c.destination_id), assigned: on ? { site: destName(on.destination_id), start: on.start, end: on.end, now: on.start <= day } : null }; });
  res.json({ date: day, settings: crewSettings(), total: all.length, on_today: sites.reduce((a, x) => a + x.on, 0), swing_count: swing.length,
    swing_ready: swing.filter((x) => x.status === 'green' && !(x.assigned && x.assigned.now)).length, sites, swing });
});
admin.get('/crew/suggest', (req, res) => {
  const site = idParam(req.query.site); if (!db.prepare('SELECT 1 FROM destinations WHERE id = ?').get(site)) throw nf();
  const start = V.date(req.query.start, { required: true, name: 'Start' }); const end = V.date(req.query.end, { required: true, name: 'End' });
  if (end < start) throw new V.VErr('End is before start');
  const list = db.prepare('SELECT * FROM contractors WHERE swing = 1 ORDER BY name').all().map((c) => swingFit(c, site, start, end))
    .sort((a, b) => (b.available - a.available) || (rank[a.status] - rank[b.status]) || a.name.localeCompare(b.name));
  res.json({ site: destName(site), start, end, suggestions: list });
});
admin.post('/crew/assign-swing', (req, res) => {
  const c = getContractor(idParam(req.body.contractor_id)); const site = idParam(req.body.destination_id);
  if (!db.prepare('SELECT 1 FROM destinations WHERE id = ?').get(site)) throw nf();
  const start = V.date(req.body.start, { required: true, name: 'Start' }); const end = V.date(req.body.end, { required: true, name: 'End' });
  if (end < start) throw new V.VErr('End is before start'); if (SCH.plus(start, 120) < end) throw new V.VErr('A swing assignment can be at most 120 days');
  if (!c.swing) throw new V.VErr(`${c.name} is not in the swing / fill-in pool`);
  const fit = swingFit(c, site, start, end);
  if (!fit.available) throw new V.VErr(`${c.name} is already scheduled then (${fit.busy.join(', ')})`);
  if (fit.status === 'red') throw new V.VErr(`${c.name} is RED for ${destName(site)} (${fit.issues.filter((i) => i.status === 'red').map((i) => i.name).join(', ')}) — fix that first`);
  if (fit.status === 'yellow' && !req.body.allow_yellow) throw new V.VErr(`${c.name} is YELLOW for this assignment (${fit.issues.map((i) => i.name).join(', ')}). Confirm to assign anyway.`);
  db.exec('BEGIN');
  try {
    for (const b of db.prepare("SELECT * FROM schedule_blocks WHERE contractor_id = ? AND kind = 'off' AND start <= ? AND end >= ?").all(c.id, end, start)) { // carve the ON out of OFF time
      db.prepare('DELETE FROM schedule_blocks WHERE id = ?').run(b.id);
      const ins = db.prepare('INSERT INTO schedule_blocks (contractor_id, kind, start, end, notes) VALUES (?,?,?,?,?)');
      if (b.start < start) ins.run(c.id, 'off', b.start, SCH.plus(start, -1), b.notes);
      if (b.end > end) ins.run(c.id, 'off', SCH.plus(end, 1), b.end, b.notes);
    }
    db.prepare("INSERT INTO schedule_blocks (contractor_id, kind, start, end, destination_id, notes) VALUES (?, 'on', ?, ?, ?, ?)").run(c.id, start, end, site, 'Swing fill-in assignment');
    db.prepare('UPDATE contractors SET destination_id = ? WHERE id = ?').run(site, c.id);
    SCH.sync(c.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  audit(req, 'swing_assigned', `${c.name} → ${destName(site)} ${start} → ${end} (${fit.status})`);
  sendAlert([c.id], 'info', `Fill-in assignment: ${destName(site)}`, `You're scheduled ON at ${destName(site)} ${start} → ${end}. Check the Schedule tab; travel will be booked by the office.`, req.user.email);
  res.json({ ok: true, status: fit.status });
});
// ---------------- Titles ----------------
admin.get('/titles', (req, res) => res.json({ titles: db.prepare('SELECT t.*, (SELECT COUNT(*) FROM contractors c WHERE c.title_id = t.id) AS in_use FROM titles t ORDER BY sort, name').all() }));
admin.post('/titles', (req, res) => {
  const name = V.str(req.body.name, 80, { required: true, name: 'Title' });
  if (db.prepare('SELECT 1 FROM titles WHERE lower(name) = lower(?)').get(name)) throw new V.VErr('That title already exists');
  const sort = (db.prepare('SELECT MAX(sort) m FROM titles').get().m ?? -1) + 1;
  const id = Number(db.prepare('INSERT INTO titles (name, sort) VALUES (?,?)').run(name, sort).lastInsertRowid);
  audit(req, 'title_create', name); res.json({ ok: true, id });
});
admin.put('/titles/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM titles WHERE id = ?').get(idParam(req.params.id)); if (!t) throw nf();
  const name = req.body.name === undefined ? t.name : V.str(req.body.name, 80, { required: true, name: 'Title' });
  if (db.prepare('SELECT 1 FROM titles WHERE lower(name) = lower(?) AND id != ?').get(name, t.id)) throw new V.VErr('That title already exists');
  const active = req.body.active === undefined ? t.active : req.body.active ? 1 : 0;
  db.prepare('UPDATE titles SET name = ?, active = ? WHERE id = ?').run(name, active, t.id);
  audit(req, 'title_update', `${t.name}${name !== t.name ? ` → ${name}` : ''}${active !== t.active ? (active ? ' (reactivated)' : ' (deactivated)') : ''}`); res.json({ ok: true });
});
admin.delete('/titles/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM titles WHERE id = ?').get(idParam(req.params.id)); if (!t) throw nf();
  if (db.prepare('SELECT COUNT(*) n FROM contractors WHERE title_id = ?').get(t.id).n) throw new V.VErr('Title is in use — deactivate it instead');
  db.prepare('DELETE FROM titles WHERE id = ?').run(t.id); audit(req, 'title_delete', t.name); res.json({ ok: true });
});
admin.put('/titles-order', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.slice(0, 200).map(idParam) : [];
  const all = db.prepare('SELECT id FROM titles').all().map((r) => r.id);
  if (ids.length !== all.length || !all.every((i) => ids.includes(i))) throw new V.VErr('Send every title id once');
  db.exec('BEGIN'); try { ids.forEach((id, k) => db.prepare('UPDATE titles SET sort = ? WHERE id = ?').run(k, id)); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  audit(req, 'title_reorder', ids.join(',')); res.json({ ok: true });
});
admin.get('/settings', (req, res) => res.json({ tracking: trackingCfg() }));
admin.put('/settings', (req, res) => {
  const t = req.body.tracking || {};
  db.meta.set('tracking_enabled', t.enabled ? '1' : '0');
  db.meta.set('tracking_overdue_hours', V.int(t.overdue_hours ?? 12, 1, 168, 'Overdue window (hours)'));
  db.meta.set('tracking_retention_days', V.int(t.retention_days ?? 30, 1, 365, 'Retention (days)'));
  purgeCheckins(); audit(req, 'settings_update', JSON.stringify(trackingCfg())); res.json({ ok: true, tracking: trackingCfg() });
});
admin.get('/tracking', (req, res) => {
  const cfg = trackingCfg(); const now = Date.now();
  const rows = db.prepare('SELECT * FROM contractors ORDER BY name').all().filter(isDeployed).map((c) => {
    const last = lastCheckin(c.id); const loc = decLoc(last);
    const d = db.prepare('SELECT * FROM destinations WHERE id = ?').get(c.destination_id || 0) || {};
    const ageH = last ? (now - Date.parse(last.created_at.replace(' ', 'T') + 'Z')) / 3600000 : null;
    return { id: c.id, name: c.name, destination: d.name || '—', consent: !!c.tracking_consent, last_checkin: last ? last.created_at : null,
      hours_since: ageH === null ? null : Math.round(ageH * 10) / 10, overdue: c.tracking_consent ? (ageH === null || ageH > cfg.overdue_hours) : false, loc, status: readiness(c).status };
  });
  const sos = db.prepare('SELECT a.*, c.name FROM admin_alerts a LEFT JOIN contractors c ON c.id = a.contractor_id ORDER BY a.id DESC LIMIT 20').all().map((a) => ({ ...a, loc: decLoc(db.prepare('SELECT * FROM checkins WHERE id = ?').get(a.checkin_id || 0)) }));
  audit(req, 'tracking_view', `${rows.length} deployed contractors`);
  res.json({ settings: cfg, deployed: rows, sos });
});
admin.get('/sos/open', (req, res) => res.json({ open: db.prepare("SELECT a.id, a.title, a.body, a.created_at FROM admin_alerts a WHERE ack_at IS NULL ORDER BY id DESC").all() }));
admin.post('/sos/:id/ack', (req, res) => {
  db.prepare("UPDATE admin_alerts SET ack_at = datetime('now'), ack_by = ? WHERE id = ?").run(req.user.email, idParam(req.params.id));
  audit(req, 'sos_ack', req.params.id); res.json({ ok: true });
});
// ---------------- Tickets to approve (proposed itineraries; admin confirms -> booking) ----------------
const CABIN_KEYS = ['first', 'business', 'premium', 'economy'];
function travelSettings() {
  const p = assistant.policy();
  return { ...p, cabins: assistant.CABINS, booking_mode: 'mock',
    notes: { booking: 'Demo: booking is MOCKED — confirming creates a demo itinerary only; no ticket is issued. Real ticketing needs a travel management company (TMC) or a booking API (e.g. Duffel, Sabre, Amadeus) — to be connected later.',
      payment: 'Payment is handled outside this app: after the admin confirms, the assistant books the real ticket with the company card. FFD never stores card numbers or any payment data.' } };
}
admin.get('/travel/settings', (req, res) => res.json(travelSettings()));
admin.put('/travel/settings', (req, res) => {
  const b = req.body || {};
  const cabin = V.str(b.default_cabin, 12, { required: true, name: 'Default cabin', oneOf: CABIN_KEYS });
  const hours = V.int(b.longhaul_hours ?? 6, 2, 16, 'Long-haul threshold (hours)');
  const pref = V.str(b.preferred_airline, 4, { name: 'Preferred airline', oneOf: ['', ...assistant.AIRLINES.map((a) => a.code)] }) || '';
  db.meta.set('default_cabin', cabin); db.meta.set('longhaul_hours', hours); db.meta.set('preferred_airline', pref || 'none');
  audit(req, 'travel_settings_update', `cabin=${cabin} longhaul>${hours}h preferred=${pref || 'none'}`);
  res.json({ ok: true, settings: travelSettings() });
});
admin.get('/tickets', (req, res) => {
  const status = V.str(req.query.status, 10, { name: 'status', oneOf: ['pending', 'done', 'booked', 'confirmed', 'rejected'] }) || 'pending';
  TK.propose();
  res.json({ tickets: TK.list(status), counts: TK.counts(), summary: TK.summary(), settings: travelSettings() });
});
admin.get('/tickets/summary', (req, res) => res.json(TK.summary()));
admin.get('/tickets/:id/options', (req, res) => { const o = TK.getOptions(idParam(req.params.id)); if (!o) throw nf(); res.json(o); });
admin.put('/tickets/:id/fare', (req, res) => {
  const f = TK.choose(idParam(req.params.id), V.str(req.body.fare_id, 40, { required: true, name: 'Flight option' }), req.user.email);
  if (!f) throw new V.VErr('That ticket is no longer waiting for approval, or the option is not available');
  res.json({ ok: true, fare: f });
});
admin.post('/tickets/confirm', SEC.limit('tk-confirm', 60, 5 * 60000), (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (!ids.length || ids.length > 100) throw new V.VErr('Pick 1–100 tickets');
  const results = TK.confirm(ids.map((x) => idParam(x)), req.user.email, req.body.allow_red === true);
  audit(req, 'ticket_confirm_batch', `${results.filter((r) => r.ok).length} confirmed, ${results.filter((r) => !r.ok).length} skipped`);
  res.json({ ok: true, results });
});
admin.post('/tickets/:id/reject', (req, res) => {
  const ok = TK.reject(idParam(req.params.id), req.user.email, V.str(req.body.reason, 300, { name: 'Reason' }) || '');
  if (!ok) throw new V.VErr('That ticket is no longer waiting for approval'); res.json({ ok: true });
});
app.use('/api/admin', admin);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], dotfiles: 'deny', index: 'index.html', setHeaders: (res, p) => { if (p.endsWith('sw.js')) res.set('Cache-Control', 'no-cache'); } }));
app.use((req, res) => res.status(404).type('text/plain').send('Not found'));
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  let msg = err.message;
  if (err.type === 'entity.too.large') msg = 'Request too large';
  else if (err.type) msg = 'Invalid request body'; // body-parser errors: don't echo parser internals
  if (status >= 500) msg = 'Something went wrong';
  res.status(status).json({ error: msg });
});
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
process.on('uncaughtException', (e) => { console.error('uncaughtException — exiting so the platform restarts us', e); process.exit(1); });
const server = app.listen(PORT, () => console.log(`FFD running on http://localhost:${PORT} (demo mode ${DEMO_MODE ? 'on' : 'off'})`));
server.headersTimeout = 20000; server.requestTimeout = 30000; server.keepAliveTimeout = 65000;

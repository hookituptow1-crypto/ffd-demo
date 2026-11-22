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
const { seed, ADMIN, CONTRACTOR_PW } = require('./seed');

const PORT = Number(process.env.PORT || 4300);
const DEMO_MODE = process.env.DEMO_MODE !== '0';
const SESSION_HOURS = 12;
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!db.prepare('SELECT COUNT(*) n FROM users').get().n) seed();

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
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(self), geolocation=(), microphone=()', 'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '8mb' }));

// ---------------- helpers ----------------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const audit = (req, action, details = '') => db.prepare('INSERT INTO audit_log (user_id, action, details, ip) VALUES (?,?,?,?)')
  .run(req.user ? req.user.id : null, action, String(details).slice(0, 500), req.ip || '');
const nf = (m = 'Not found') => Object.assign(new Error(m), { status: 404 });
const idParam = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw nf(); return n; };

function parseCookies(h = '') {
  return Object.fromEntries(h.split(';').map((p) => p.trim().split('=')).filter((a) => a[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function auth(req, res, next) {
  const tok = parseCookies(req.headers.cookie).ffd_sid;
  if (tok) {
    const s = db.prepare('SELECT s.*, u.email, u.role, u.contractor_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE token_hash = ?').get(C.sha256(tok));
    if (s && s.expires_at > Date.now()) req.user = { id: s.user_id, email: s.email, role: s.role, contractor_id: s.contractor_id, csrf: s.csrf };
  }
  next();
}
app.use(auth);
// CSRF: every state-changing request needs the per-session token in a header (cookie is also SameSite=Strict)
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD'].includes(req.method) || req.path === '/login') return next();
  if (!req.user || req.get('x-csrf-token') !== req.user.csrf) return res.status(403).json({ error: 'Session expired — please sign in again' });
  next();
});
const need = (role) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  if (role && req.user.role !== role) return res.status(403).json({ error: 'Not allowed' });
  next();
};

const getReqs = (destId) => db.prepare(`SELECT rt.* FROM requirement_types rt JOIN destination_requirements dr ON dr.requirement_type_id = rt.id
  WHERE dr.destination_id = ? ORDER BY CASE rt.category WHEN 'passport' THEN 0 WHEN 'visa' THEN 1 WHEN 'id' THEN 2 WHEN 'immunization' THEN 3 ELSE 4 END, rt.name`).all(destId || 0);
function readiness(c) {
  return evaluate(c, getReqs(c.destination_id), db.prepare('SELECT * FROM documents WHERE contractor_id = ?').all(c.id),
    db.prepare('SELECT * FROM blockers WHERE contractor_id = ?').all(c.id));
}
const getContractor = (id) => { const c = db.prepare('SELECT * FROM contractors WHERE id = ?').get(id); if (!c) throw nf(); return c; };
const destName = (id) => (db.prepare('SELECT name FROM destinations WHERE id = ?').get(id || 0) || {}).name || '—';
const getProfile = (cid) => { const p = db.prepare('SELECT * FROM profiles WHERE contractor_id = ?').get(cid); return p ? { ...C.decJSON(p.data_enc), _updated_at: p.updated_at, _updated_by: p.updated_by } : V.profile({}); };
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
const attempts = new Map(); // ip -> [timestamps]
app.post('/api/login', wrap(async (req, res) => {
  const ip = req.ip || 'x'; const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60000);
  if (list.length >= 20) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  list.push(now); attempts.set(ip, list);
  const email = V.str(req.body.email, 120, { required: true, name: 'Email' });
  const password = V.str(req.body.password, 200, { required: true, name: 'Password' });
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const fail = () => res.status(401).json({ error: 'Email or password is incorrect' });
  if (!u) { C.hashPassword(password); return fail(); } // equalize timing
  if (u.locked_until && new Date(u.locked_until) > new Date()) return res.status(423).json({ error: 'Account temporarily locked after failed attempts. Try again later.' });
  if (!C.verifyPassword(password, u.password_hash)) {
    const n = u.failed_logins + 1;
    db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(n >= 8 ? 0 : n, n >= 8 ? new Date(now + 15 * 60000).toISOString() : null, u.id);
    audit({ ip, user: { id: u.id } }, 'login_failed', email);
    return fail();
  }
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(u.id);
  const tok = C.token(); const csrf = C.token();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, expires_at) VALUES (?,?,?,?)').run(C.sha256(tok), u.id, csrf, now + SESSION_HOURS * 3600000);
  res.set('Set-Cookie', `ffd_sid=${tok}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${req.secure ? '; Secure' : ''}`);
  audit({ ip, user: { id: u.id } }, 'login', email);
  res.json({ role: u.role, csrf });
}));
app.post('/api/logout', need(), (req, res) => {
  const tok = parseCookies(req.headers.cookie).ffd_sid;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(C.sha256(tok || ''));
  res.set('Set-Cookie', 'ffd_sid=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  res.json({ email: req.user.email, role: req.user.role, csrf: req.user.csrf, vapid: VAPID.publicKey });
});
app.get('/api/demo-info', (req, res) => {
  if (!DEMO_MODE) return res.json({ demo: false });
  const cs = db.prepare('SELECT c.name, c.notes, u.email FROM contractors c JOIN users u ON u.contractor_id = c.id ORDER BY c.employee_no').all();
  res.json({ demo: true, admin: ADMIN, contractor_password: CONTRACTOR_PW, contractors: cs.map((c) => ({ ...c, status: readiness(db.prepare('SELECT * FROM contractors WHERE name = ?').get(c.name)).status })) });
});

// --------------- contractor ---------------
const me = (req) => getContractor(req.user.contractor_id);
app.get('/api/my/status', need('contractor'), (req, res) => {
  const c = me(req);
  const flights = db.prepare('SELECT * FROM flights WHERE contractor_id = ? ORDER BY depart_at').all(c.id);
  const alerts = db.prepare('SELECT * FROM alerts WHERE contractor_id = ? ORDER BY created_at DESC, id DESC LIMIT 50').all(c.id);
  res.json({ contractor: { id: c.id, name: c.name, employee_no: c.employee_no, destination: destName(c.destination_id) },
    readiness: readiness(c), flights, alerts, unread_alerts: alerts.filter((a) => !a.read_at).length,
    new_flights: flights.filter((f) => !f.seen_at).length });
});
app.post('/api/my/flights/seen', need('contractor'), (req, res) => {
  db.prepare("UPDATE flights SET seen_at = datetime('now') WHERE contractor_id = ? AND seen_at IS NULL").run(req.user.contractor_id);
  res.json({ ok: true });
});
app.post('/api/my/alerts/read', need('contractor'), (req, res) => {
  db.prepare("UPDATE alerts SET read_at = datetime('now') WHERE contractor_id = ? AND read_at IS NULL").run(req.user.contractor_id);
  res.json({ ok: true });
});
app.get('/api/my/profile', need('contractor'), (req, res) => res.json({ profile: getProfile(req.user.contractor_id), uploads: listUploads(req.user.contractor_id) }));
app.put('/api/my/profile', need('contractor'), (req, res) => {
  const p = V.profile(req.body.profile);
  saveProfile(req.user.contractor_id, p, 'contractor');
  const synced = syncProfileToDocs(req.user.contractor_id, p);
  audit(req, 'profile_update_self', `contractor ${req.user.contractor_id}; synced: ${synced.join(', ')}`);
  res.json({ ok: true, synced, readiness: readiness(me(req)) });
});
// Contractor submits/updates one requirement (e.g. yellow fever card) — self-reported until admin verifies.
app.post('/api/my/requirements/:typeId', need('contractor'), (req, res) => {
  const c = me(req); const typeId = idParam(req.params.typeId);
  const rt = getReqs(c.destination_id).find((r) => r.id === typeId); if (!rt) throw nf('Requirement not required for your site');
  const issued = V.date(req.body.issued, { name: 'Issued / shot date' });
  const expires = V.date(req.body.expires, { name: 'Expiration date', required: !!rt.has_expiry });
  const ref = V.str(req.body.number, 40, { name: 'Document number' });
  let uploadId = null;
  if (req.body.file) uploadId = storeUpload(c.id, { label: rt.name, ...req.body.file }, 'contractor');
  upsertDoc(c.id, typeId, { ref_last4: ref.slice(-4), issued, expires, status: 'valid', verified: 0, source: 'contractor', upload_id: uploadId, notes: 'Submitted by contractor in app' });
  audit(req, 'requirement_submitted', `${c.name}: ${rt.name}`);
  res.json({ ok: true, readiness: readiness(c) });
});
app.get('/api/my/uploads', need('contractor'), (req, res) => res.json({ uploads: listUploads(req.user.contractor_id) }));
app.post('/api/my/uploads', need('contractor'), (req, res) => {
  const id = storeUpload(req.user.contractor_id, req.body, 'contractor'); audit(req, 'upload', `id ${id}`); res.json({ ok: true, id });
});
app.post('/api/my/push', need('contractor'), (req, res) => {
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
  res.set({ 'Content-Type': u.mime, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' });
  res.send(C.decrypt(fs.readFileSync(path.join(UPLOAD_DIR, u.file))));
});

function upsertDoc(cid, typeId, d) {
  db.prepare(`INSERT INTO documents (contractor_id, requirement_type_id, ref_last4, issued, expires, status, notes, verified, source, upload_id, updated_at)
    VALUES (@cid,@typeId,@ref_last4,@issued,@expires,@status,@notes,@verified,@source,@upload_id,datetime('now'))
    ON CONFLICT(contractor_id, requirement_type_id) DO UPDATE SET ref_last4=excluded.ref_last4, issued=excluded.issued, expires=excluded.expires,
    status=excluded.status, notes=excluded.notes, verified=excluded.verified, source=excluded.source, upload_id=COALESCE(excluded.upload_id, documents.upload_id), updated_at=excluded.updated_at`)
    .run({ cid, typeId, ref_last4: '', issued: null, expires: null, status: 'valid', notes: '', verified: 1, source: 'admin', upload_id: null, ...d });
}
function saveProfile(cid, p, by) {
  db.prepare(`INSERT INTO profiles (contractor_id, data_enc, updated_by, updated_at) VALUES (?,?,?,datetime('now'))
    ON CONFLICT(contractor_id) DO UPDATE SET data_enc=excluded.data_enc, updated_by=excluded.updated_by, updated_at=excluded.updated_at`).run(cid, C.encJSON(p), by);
}
// Intake form → requirement records. Only fills gaps or extends expiry; never downgrades an admin-verified record.
function syncProfileToDocs(cid, p) {
  const c = getContractor(cid); const synced = [];
  const docs = new Map(db.prepare('SELECT * FROM documents WHERE contractor_id = ?').all(cid).map((d) => [d.requirement_type_id, d]));
  for (const rt of getReqs(c.destination_id)) {
    let entry = null;
    const kw = (rt.keyword || '').toLowerCase();
    if (rt.category === 'passport' && p.passport.number) entry = { number: p.passport.number, issued: p.passport.issued, expires: p.passport.expires };
    else if (rt.category === 'id' && p.gov_id.number) entry = { number: p.gov_id.number, issued: null, expires: p.gov_id.expires };
    else if (rt.category === 'visa') { const v = p.visas.find((x) => `${x.country} ${x.type}`.toLowerCase().includes(kw)); if (v) entry = { number: v.number, issued: v.issued, expires: v.expires }; }
    else if (rt.category === 'immunization') { const v = p.immunizations.find((x) => x.vaccine.toLowerCase().includes(kw)); if (v) entry = { number: '', issued: (v.dates.match(/\d{4}-\d{2}-\d{2}/g) || []).pop() || null, expires: v.expires }; }
    else if (rt.category === 'clearance') { const v = p.clearances.find((x) => x.type.toLowerCase().includes(kw)); if (v) entry = { number: '', issued: v.granted, expires: v.expires }; }
    if (!entry || (rt.has_expiry && !entry.expires)) continue;
    const cur = docs.get(rt.id);
    const better = !cur || cur.status !== 'valid' || (rt.has_expiry && (!cur.expires || entry.expires > cur.expires));
    if (!better) continue;
    upsertDoc(cid, rt.id, { ref_last4: String(entry.number || '').slice(-4), issued: entry.issued, expires: rt.has_expiry ? entry.expires : null,
      status: 'valid', verified: 0, source: 'contractor', notes: 'From contractor intake form' });
    synced.push(rt.name);
  }
  return synced;
}

// --------------- admin ---------------
const admin = express.Router();
admin.use(need('admin'));
admin.get('/contractors', (req, res) => {
  const list = db.prepare('SELECT * FROM contractors ORDER BY name').all().map((c) => {
    const r = readiness(c); const p = getProfile(c.id);
    return { id: c.id, name: c.name, employee_no: c.employee_no, phone: c.phone, destination: destName(c.destination_id), destination_id: c.destination_id,
      deploy_date: r.rotation.start, next_deploy: r.rotation.next_start, days_to_deploy: r.rotation.days_to_deploy, status: r.status, overridden: r.overridden,
      issues: r.items.filter((i) => i.status !== 'green').map((i) => ({ name: i.name, status: i.status })).concat(r.blockers.map((b) => ({ name: b.description, status: 'red' }))),
      fix_by: r.fix_by, passport_masked: mask(p.passport && p.passport.number), dob_masked: p.personal.dob ? `••••-••-${p.personal.dob.slice(-2)}` : '',
      unverified: r.items.filter((i) => i.document && !i.document.verified).length, scenario: c.notes };
  });
  res.json({ contractors: list });
});
admin.get('/contractors/:id', (req, res) => {
  const c = getContractor(idParam(req.params.id));
  const acct = db.prepare('SELECT email FROM users WHERE contractor_id = ?').get(c.id);
  res.json({ contractor: c, account_email: acct ? acct.email : null, readiness: readiness(c), profile: getProfile(c.id), uploads: listUploads(c.id),
    flights: db.prepare('SELECT * FROM flights WHERE contractor_id = ? ORDER BY depart_at').all(c.id),
    alerts: db.prepare('SELECT * FROM alerts WHERE contractor_id = ? ORDER BY id DESC LIMIT 30').all(c.id),
    blockers: db.prepare('SELECT * FROM blockers WHERE contractor_id = ? ORDER BY id DESC').all(c.id) });
});
function contractorFields(b) {
  const destination_id = b.destination_id ? idParam(b.destination_id) : null;
  if (destination_id && !db.prepare('SELECT 1 FROM destinations WHERE id = ?').get(destination_id)) throw new V.VErr('Unknown destination');
  return { name: V.str(b.name, 120, { required: true, name: 'Name' }), employee_no: V.str(b.employee_no, 40, { required: true, name: 'Employee #' }),
    phone: V.str(b.phone, 40, { name: 'Phone' }), email: V.str(b.email, 120, { name: 'Email', pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ }),
    home_airport: V.str(b.home_airport, 3, { name: 'Home airport', pattern: /^[A-Za-z]{3}$/ }).toUpperCase(),
    destination_id, deploy_date: V.date(b.deploy_date, { name: 'Deploy date' }), next_deploy_date: V.date(b.next_deploy_date, { name: 'Next deploy date' }),
    rotation_on: V.int(b.rotation_on ?? 60, 1, 365, 'Days on'), rotation_off: V.int(b.rotation_off ?? 30, 0, 365, 'Days off'), notes: V.str(b.notes, 1000, { name: 'Notes' }) };
}
admin.post('/contractors', (req, res) => {
  const f = contractorFields(req.body);
  const id = Number(db.prepare(`INSERT INTO contractors (name, employee_no, phone, email, home_airport, destination_id, deploy_date, next_deploy_date, rotation_on, rotation_off, notes)
    VALUES (@name,@employee_no,@phone,@email,@home_airport,@destination_id,@deploy_date,@next_deploy_date,@rotation_on,@rotation_off,@notes)`).run(f).lastInsertRowid);
  audit(req, 'contractor_create', f.name); res.json({ ok: true, id });
});
admin.put('/contractors/:id', (req, res) => {
  const c = getContractor(idParam(req.params.id)); const f = contractorFields(req.body);
  db.prepare(`UPDATE contractors SET name=@name, employee_no=@employee_no, phone=@phone, email=@email, home_airport=@home_airport, destination_id=@destination_id,
    deploy_date=@deploy_date, next_deploy_date=@next_deploy_date, rotation_on=@rotation_on, rotation_off=@rotation_off, notes=@notes WHERE id=@id`).run({ ...f, id: c.id });
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
  if (u) { db.prepare('UPDATE users SET email = ?, password_hash = ? WHERE id = ?').run(email, C.hashPassword(pw), u.id); db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); }
  else db.prepare("INSERT INTO users (email, password_hash, role, contractor_id) VALUES (?,?,'contractor',?)").run(email, C.hashPassword(pw), c.id);
  audit(req, 'account_set', c.name); res.json({ ok: true });
});
admin.put('/contractors/:id/documents/:typeId', (req, res) => {
  const c = getContractor(idParam(req.params.id)); const typeId = idParam(req.params.typeId);
  if (!db.prepare('SELECT 1 FROM requirement_types WHERE id = ?').get(typeId)) throw nf();
  upsertDoc(c.id, typeId, { ref_last4: V.str(req.body.ref_last4, 4, { name: 'Last 4' }), issued: V.date(req.body.issued, { name: 'Issued' }),
    expires: V.date(req.body.expires, { name: 'Expires' }), status: V.str(req.body.status || 'valid', 10, { name: 'Status', oneOf: ['valid', 'pending', 'rejected'] }),
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
    confirmation: V.str(b.confirmation, 20, { name: 'Confirmation #' }), seat: V.str(b.seat, 8, { name: 'Seat' }), notes: V.str(b.notes, 500, { name: 'Notes' }) };
}
const insFlight = (cid, f) => db.prepare(`INSERT INTO flights (contractor_id, airline, flight_no, from_airport, to_airport, depart_at, arrive_at, confirmation, seat, notes)
  VALUES (@cid,@airline,@flight_no,@from_airport,@to_airport,@depart_at,@arrive_at,@confirmation,@seat,@notes)`).run({ cid, ...f });
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
    confirmation=@confirmation, seat=@seat, notes=@notes, seen_at=NULL, updated_at=datetime('now') WHERE id=@id`).run({ ...f, id: old.id });
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
admin.post('/alerts', (req, res) => {
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
    lead_days: V.int(req.body.lead_days ?? 30, 0, 365, 'Lead time'), instructions: V.str(req.body.instructions, 500, { name: 'Instructions' }), keyword: V.str(req.body.keyword, 40, { name: 'Keyword' }).toLowerCase() };
  if (id) db.prepare('UPDATE requirement_types SET name=@name, category=@category, has_expiry=@has_expiry, min_validity_days=@min_validity_days, lead_days=@lead_days, instructions=@instructions, keyword=@keyword WHERE id=@id').run({ ...f, id });
  else id = Number(db.prepare('INSERT INTO requirement_types (name, category, has_expiry, min_validity_days, lead_days, instructions, keyword) VALUES (@name,@category,@has_expiry,@min_validity_days,@lead_days,@instructions,@keyword)').run(f).lastInsertRowid);
  audit(req, 'requirement_type_save', f.name); return id;
}
admin.post('/requirement-types', (req, res) => res.json({ ok: true, id: saveRt(req) }));
admin.put('/requirement-types/:id', (req, res) => res.json({ ok: true, id: saveRt(req, idParam(req.params.id)) }));
admin.post('/assistant/plan', (req, res) => {
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
  const fare = sim.fares.find((f) => f.airline === req.body.airline);
  if (!fare) throw new V.VErr('Pick one of the offered fares');
  const conf = `RT${C.token().replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 5)}`;
  fare.legs.forEach((l, i) => insFlight(c.id, { airline: l.airline, flight_no: l.flight_no, from_airport: l.from_airport, to_airport: l.to_airport,
    depart_at: l.depart_at || (i ? fare.legs[i - 1].arrive_at || fare.depart_at : fare.depart_at), arrive_at: l.arrive_at || null, confirmation: conf, seat: '',
    notes: `Booked via FFD assistant · DEMO fare $${fare.price_usd}` }));
  if (sim.destination.id !== c.destination_id || sim.depart_date !== c.deploy_date) db.prepare('UPDATE contractors SET destination_id = ?, deploy_date = ? WHERE id = ?').run(sim.destination.id, sim.depart_date, c.id);
  sendAlert([c.id], 'flight', `Travel booked: ${sim.destination.name}`, `${fare.airline} via ${fare.via}, departs ${fare.depart_at.replace('T', ' ')} · Conf ${conf}`, req.user.email);
  audit(req, 'assistant_book', `${c.name} → ${sim.destination.name} ${fare.airline} $${fare.price_usd} (prev status ${r.status})`);
  res.json({ ok: true, confirmation: conf });
});
admin.get('/audit', (req, res) => res.json({ log: db.prepare('SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 200').all() }));
admin.post('/demo/reset', (req, res) => {
  if (!DEMO_MODE) return res.status(403).json({ error: 'Demo mode is off' });
  for (const f of fs.readdirSync(UPLOAD_DIR)) fs.unlinkSync(path.join(UPLOAD_DIR, f));
  seed(); res.set('Set-Cookie', 'ffd_sid=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0'); res.json({ ok: true });
});
app.use('/api/admin', admin);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], setHeaders: (res, p) => { if (p.endsWith('sw.js')) res.set('Cache-Control', 'no-cache'); } }));
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Something went wrong' : err.message });
});
app.listen(PORT, () => console.log(`FFD running on http://localhost:${PORT} (demo mode ${DEMO_MODE ? 'on' : 'off'})`));

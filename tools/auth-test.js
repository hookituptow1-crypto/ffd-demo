'use strict';
// Server-issued accounts: no self sign-up, one-time temporary credentials + forced account setup, permanent owner admin
// (never locked out, survives Reset demo / reseed, audit-logged), demo auto-setup via /api/config. API level; never prints secrets.
// Usage: BASE=https://... node tools/auth-test.js   (reads private/creds.env; LOCAL_DB=path enables the DB-level checks)
const fs = require('fs'); const path = require('path');
const CREDS = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', 'private', 'creds.env'), 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
const BASE = process.env.BASE || 'http://localhost:4300'; const ORIGIN = new URL(BASE).origin;
const OWNER = [process.env.OWNER_USERNAME || 'owner', CREDS.OWNER_ADMIN_PASSWORD];
let pass = 0, fail = 0; const out = [];
const ok = (name, c, extra = '') => { (c ? pass++ : fail++); out.push(`${c ? 'PASS' : 'FAIL'}  ${name}${!c && extra ? ` — ${String(extra).slice(0, 160)}` : ''}`); };
const jar = () => ({ c: '', csrf: '' });
async function req(j, method, p, body, extra = {}) {
  const h = { 'Content-Type': 'application/json', Origin: ORIGIN, ...(j && j.c ? { Cookie: j.c } : {}), ...(j && j.csrf ? { 'x-csrf-token': j.csrf } : {}), ...extra };
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const sc = r.headers.get('set-cookie'); if (j && sc) { const m = sc.match(/((?:__Host-)?ffd_sid)=([^;]*)/); if (m) j.c = m[2] ? `${m[1]}=${m[2]}` : ''; }
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { s: r.status, json, text };
}
async function login(id, pw) { const j = jar(); const r = await req(j, 'POST', '/api/login', { email: id, password: pw }); if (r.json && r.json.csrf) j.csrf = r.json.csrf; j.r = r; return j; }
const STRONG = () => `Kq7!${Math.random().toString(36).slice(2, 10)}Zx9#`;
const DB = process.env.LOCAL_DB ? new (require('node:sqlite').DatabaseSync)(process.env.LOCAL_DB) : null;
async function latestInvite(admin, email) {
  const m = (await req(admin, 'GET', '/api/admin/outbox')).json.messages.find((x) => x.kind === 'invite' && x.to_email === email);
  if (!m) return null; const u = (m.body.match(/Username: (\S+)/) || [])[1]; const p = (m.body.match(/Temporary password: (\S+)/) || [])[1];
  return { id: m.id, user: u, pw: p, body: m.body };
}

(async () => {
  // --- bootstrap / no self sign-up ---
  const cfg = await req(null, 'GET', '/api/config');
  ok('GET /api/config works without sign-in and reports demo mode', cfg.s === 200 && cfg.json.demo === true && cfg.json.signup === false && cfg.json.auth === 'server-issued');
  ok('/api/config exposes no secrets', !/password|secret|key/i.test(JSON.stringify(Object.keys(cfg.json))) || !/:"[^"]{20,}"/.test(cfg.text));
  for (const p of ['/api/signup', '/api/register', '/api/users']) ok(`no self sign-up endpoint: POST ${p}`, [403, 404].includes((await req(null, 'POST', p, { email: 'x@y.z', password: 'Aa1!aaaaaaaaaa' })).s));
  ok('API is closed without credentials (/api/me 401)', (await req(null, 'GET', '/api/me')).s === 401);
  ok('admin API closed without credentials', (await req(null, 'GET', '/api/admin/contractors')).s === 401);

  // --- owner account ---
  let own = await login(OWNER[0], OWNER[1]);
  ok('owner signs in with username', own.r.s === 200 && own.r.json.role === 'admin' && !own.r.json.must_change, own.r.text);
  const me = (await req(own, 'GET', '/api/me')).json; ok('owner session flagged as owner', me && me.owner === true);
  ok('owner can also sign in with its email', (await login('owner@ffd.internal', OWNER[1])).r.s === 200);
  ok('wrong owner password is rejected', (await login(OWNER[0], `${OWNER[1]}x`)).r.s === 401);
  for (let i = 0; i < 22; i++) await login(OWNER[0], `wrong-${i}`);
  const own2 = await login(OWNER[0], OWNER[1]);
  ok('owner is NOT locked out after 22 failed attempts from the same IP', own2.r.s === 200, own2.r.text);
  ok('owner cannot change its password in-app (server-managed)', (await req(own2, 'POST', '/api/password/change', { current: OWNER[1], password: STRONG() })).s === 400);
  own = own2;
  // lockout still applies to everyone else (fresh client IP not available locally, so use an account that is not the owner)
  const victim = 'marcus@ffd.demo'; for (let i = 0; i < 11; i++) await login(victim, `bad-${i}`);
  ok('normal accounts still lock out (10 per account+IP)', (await login(victim, CREDS.CONTRACTOR_PASSWORD)).r.s === 401);
  // forgot-password never targets the owner
  const before = (await req(own, 'GET', '/api/admin/outbox')).json.messages.length;
  await req(null, 'POST', '/api/password/forgot', { email: 'owner@ffd.internal' });
  ok('forgot-password never issues a reset for the owner', (await req(own, 'GET', '/api/admin/outbox')).json.messages.length === before);

  // --- one-time temporary credentials ---
  // throwaway crew records (deleted at the end) so the demo personas are never touched
  const mk = async (n) => (await req(own, 'POST', '/api/admin/contractors', { name: `Trial Tester ${n}`, employee_no: `TRIAL-${n}-${Date.now().toString(36)}`, email: '', rotation_on: 60, rotation_off: 30 })).json;
  const ta = await mk('A'); const tb = await mk('B');
  ok('admin creates throwaway crew records', ta && ta.id && tb && tb.id, JSON.stringify(ta));
  const target = { id: ta.id, name: 'Trial Tester A' }; const t2target = { id: tb.id, name: 'Trial Tester B' };
  const email = `trial.${Date.now()}@example.com`;
  ok('invite needs CSRF token', (await req({ c: own.c }, 'POST', `/api/admin/contractors/${target.id}/invite`, { email })).s === 403);
  ok('invite needs admin', (await req(null, 'POST', `/api/admin/contractors/${target.id}/invite`, { email })).s >= 401);
  const iv = await req(own, 'POST', `/api/admin/contractors/${target.id}/invite`, { email });
  ok('admin issues one-time login (delivered to outbox)', iv.s === 200 && iv.json.delivered === 'outbox', iv.text);
  ok('invite response contains no credentials', !/tmp-|password/i.test(JSON.stringify(iv.json)));
  const inv = await latestInvite(own, email);
  ok('temp username + password delivered over the mail channel', !!(inv && inv.user && inv.pw && inv.user.startsWith('tmp-')));
  if (DB) {
    ok('outbox copy is encrypted at rest', /^enc:/.test(DB.prepare('SELECT body FROM outbox WHERE id = ?').get(inv.id).body));
    const u = DB.prepare('SELECT * FROM users WHERE email = ?').get(email);
    ok('temp password stored only as a hash', u && /^scrypt\$/.test(u.password_hash) && !JSON.stringify(u).includes(inv.pw));
  }
  const t1 = await login(inv.user, inv.pw);
  ok('temp credentials sign in once, flagged must_setup', t1.r.s === 200 && t1.r.json.must_setup === true, t1.r.text);
  ok('blocked from data until setup', (await req(t1, 'GET', '/api/my/profile')).s === 403);
  ok('password-only change is not enough (must use account setup)', (await req(t1, 'POST', '/api/password/change', { current: inv.pw, password: STRONG() })).s === 403);
  ok('outbox credentials redacted once used', /removed from the Outbox/.test((await req(own, 'GET', '/api/admin/outbox')).json.messages.find((m) => m.id === inv.id).body));
  ok('temp credentials are one-time (second sign-in rejected)', (await login(inv.user, inv.pw)).r.s === 401);
  ok('setup rejects weak password', (await req(t1, 'POST', '/api/account/setup', { username: 'trial.crew1', password: 'password123' })).s === 400);
  ok('setup rejects reserved username', (await req(t1, 'POST', '/api/account/setup', { username: 'owner', password: STRONG() })).s === 400);
  ok('setup rejects tmp- username', (await req(t1, 'POST', '/api/account/setup', { username: 'tmp-abc', password: STRONG() })).s === 400);
  ok('setup needs CSRF', (await req({ c: t1.c }, 'POST', '/api/account/setup', { username: 'x.y.z', password: STRONG() })).s === 403);
  const uname = `crew.${Date.now().toString(36)}`; const pw = STRONG();
  const su = await req(t1, 'POST', '/api/account/setup', { username: uname, password: pw });
  ok('first sign-in sets own permanent username + password', su.s === 200 && su.json.username === uname, su.text);
  ok('after setup, data is reachable', (await req(t1, 'GET', '/api/my/profile')).s === 200);
  ok('permanent username signs in', (await login(uname, pw)).r.s === 200);
  ok('permanent email signs in', (await login(email, pw)).r.s === 200);
  ok('temp username is gone', (await login(inv.user, pw)).r.s === 401);
  // expiry
  const email2 = `trial2.${Date.now()}@example.com`;
  await req(own, 'POST', `/api/admin/contractors/${t2target.id}/invite`, { email: email2 }); const inv2 = await latestInvite(own, email2);
  if (DB) {
    DB.prepare('UPDATE users SET temp_expires_at = ? WHERE email = ?').run(Date.now() - 1000, email2);
    ok('expired temp credentials are rejected', (await login(inv2.user, inv2.pw)).r.s === 401);
  } else ok('second invite delivered', !!(inv2 && inv2.pw));
  // re-invite replaces the earlier one
  await req(own, 'POST', `/api/admin/contractors/${t2target.id}/invite`, { email: email2 }); const inv3 = await latestInvite(own, email2);
  ok('re-invite invalidates the earlier temp login', inv2.pw !== inv3.pw && (await login(inv2.user, inv2.pw)).r.s === 401);

  // --- owner audit ---
  const audit = (await req(own, 'GET', '/api/admin/audit')).json.log;
  ok('owner sign-ins are audit-logged', audit.some((a) => a.action === 'owner_login'));
  ok('owner failed sign-ins are audit-logged', audit.some((a) => a.action === 'owner_login_failed'));
  ok('owner actions are audit-logged', audit.some((a) => a.action === 'owner_action' && /invite/.test(a.details)));
  ok('temp credential issue + setup audit-logged', audit.some((a) => a.action === 'temp_credentials_issued') && audit.some((a) => a.action === 'account_setup_completed'));

  // --- Reset demo / reseed keeps real accounts ---
  const rs = await req(own, 'POST', '/api/admin/demo/reset', {});
  ok('Reset demo runs (owner)', rs.s === 200, rs.text);
  const own3 = await login(OWNER[0], OWNER[1]); ok('owner survives Reset demo', own3.r.s === 200);
  const crew = await login(uname, pw); ok('invited user survives Reset demo', crew.r.s === 200);
  ok('invited user still linked to their crew record after reseed', (await req(crew, 'GET', '/api/my/profile')).s === 200);
  ok('pending temp login survives Reset demo', !!(await latestInvite(own3, email2)));
  ok('demo admin still works after reset', (await login('admin@ffd.demo', CREDS.ADMIN_PASSWORD)).r.s === 200);
  // cleanup: delete the throwaway crew + their logins (they were re-created by the reseed with new ids)
  const all = (await req(own3, 'GET', '/api/admin/contractors')).json; const rows = all.contractors || all.rows || all;
  for (const c of rows.filter((x) => /^Trial Tester/.test(x.name))) await req(own3, 'DELETE', `/api/admin/contractors/${c.id}`);
  ok('cleanup removed trial logins', (await login(uname, pw)).r.s === 401);
  const cfg2 = await req(null, 'GET', '/api/config'); ok('/api/config is idempotent (no re-seed when data present)', cfg2.json.healed === false);
  console.log(out.join('\n')); console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('ERROR', e.message); process.exitCode = 2; });

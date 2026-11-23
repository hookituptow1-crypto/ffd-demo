'use strict';
// Password flows end to end (API level): forgot/reset, single use, expiry/invalidation, strength, sessions killed,
// outbox, admin temp password + forced change, force reset, unlock, CSRF. Restores demo state at the end.
// Usage: BASE=https://... node tools/pw-test.js   (reads ADMIN_PASSWORD / CONTRACTOR_PASSWORD from env)
const BASE = process.env.BASE || 'http://localhost:4300';
const AP = process.env.ADMIN_PASSWORD; const CP = process.env.CONTRACTOR_PASSWORD;
let pass = 0, fail = 0; const out = [];
const ok = (name, c, extra = '') => { (c ? pass++ : fail++); out.push(`${c ? 'PASS' : 'FAIL'}  ${name}${!c && extra ? ` — ${extra}` : ''}`); };
class S { constructor() { this.c = {}; this.csrf = null; }
  async req(m, u, body, hdr = {}) {
    const r = await fetch(BASE + u, { method: m, redirect: 'manual', headers: { Origin: BASE, 'Content-Type': 'application/json', ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}), Cookie: Object.entries(this.c).map(([k, v]) => `${k}=${v}`).join('; '), ...hdr }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(';'); const [k, ...v] = kv.split('='); if (v.join('=')) this.c[k] = v.join('='); else delete this.c[k]; }
    let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j, h: r.headers };
  }
  async login(e, p) { const r = await this.req('POST', '/api/login', { email: e, password: p }); if (r.s === 200) this.csrf = r.j.csrf; return r; } }
const lastLink = async (adm, email) => { const o = (await adm.req('GET', '/api/admin/outbox')).j.messages || []; const m = o.find((x) => x.to_email === email && x.kind === 'reset'); const t = m && m.body.match(/#t=([A-Za-z0-9_-]+)/); return t ? t[1] : null; };
(async () => {
  const adm = new S(); ok('Admin signs in with restored demo password', (await adm.login('admin@ffd.demo', AP)).s === 200);
  const list = (await adm.req('GET', '/api/admin/contractors')).j.contractors; const john = list.find((c) => c.name === 'John Doe'); const ray = list.find((c) => c.name === 'Ray Castillo');
  const je = 'john@ffd.demo';
  // --- forgot: same answer for known/unknown, rate limited
  const anon = new S();
  const a1 = await anon.req('POST', '/api/password/forgot', { email: je }); const a2 = await anon.req('POST', '/api/password/forgot', { email: 'nobody-here@ffd.demo' });
  ok('Forgot: identical response for existing vs unknown email', a1.s === 200 && a2.s === 200 && JSON.stringify(a1.j) === JSON.stringify(a2.j));
  ok('Forgot: response is no-store', (a1.h.get('cache-control') || '').includes('no-store'));
  ok('Forgot: cross-site POST blocked', (await anon.req('POST', '/api/password/forgot', { email: je }, { Origin: 'https://evil.example' })).s === 403);
  const t1 = await lastLink(adm, je); ok('Demo outbox has the reset email with a one-time link (admin-only page)', !!t1);
  ok('Outbox not readable by anonymous users', (await anon.req('GET', '/api/admin/outbox')).s === 401);
  const cs = new S(); await cs.login(je, CP); ok('Outbox not readable by a contractor', (await cs.req('GET', '/api/admin/outbox')).s === 403);
  ok('Outbox stores no unknown-account email', !((await adm.req('GET', '/api/admin/outbox')).j.messages || []).some((m) => m.to_email === 'nobody-here@ffd.demo'));
  const anon2 = new S(); await anon2.req('POST', '/api/password/forgot', { email: je }); const t2 = await lastLink(adm, je);
  const c1 = await anon.req('POST', '/api/password/check', { token: t1 }); const c2 = await anon.req('POST', '/api/password/check', { token: t2 });
  ok('New request invalidates the earlier link', t2 && t2 !== t1 && c1.s === 200 && c1.j.valid === false && c2.j.valid === true);
  ok('Reset with garbage token rejected', (await anon.req('POST', '/api/password/reset', { token: 'x'.repeat(43), password: 'Str0ng!Passw0rd-x' })).s === 400);
  const weak = await anon.req('POST', '/api/password/reset', { token: t2, password: 'short1A!' });
  const weak2 = await anon.req('POST', '/api/password/reset', { token: t2, password: 'alllowercaseletters' });
  const weak3 = await anon.req('POST', '/api/password/reset', { token: t2, password: 'John-Rotation-2027' });
  ok('Reset enforces strength (length, mix, no email name)', weak.s === 400 && weak2.s === 400 && weak3.s === 400, `${weak.s} ${weak2.s} ${weak3.s}`);
  const NEWPW = `Ok-${Math.random().toString(36).slice(2, 8)}-Rot8!`;
  const done = await anon.req('POST', '/api/password/reset', { token: t2, password: NEWPW });
  ok('Reset with a valid link + strong password succeeds', done.s === 200, JSON.stringify(done.j));
  ok("Reset killed the contractor's existing sessions", (await cs.req('GET', '/api/my/status')).s === 401);
  ok('Reset link is single-use', (await anon.req('POST', '/api/password/reset', { token: t2, password: NEWPW + 'x' })).s === 400);
  ok('Old password no longer works; new one does', (await new S().login(je, CP)).s === 401 && (await new S().login(je, NEWPW)).s === 200);
  const ob = (await adm.req('GET', '/api/admin/outbox')).j.messages; ok('"Your password was changed" notice sent', ob.some((m) => m.to_email === je && m.kind === 'changed'));
  const au = (await adm.req('GET', '/api/admin/audit')).j.log; ok('Audit log: reset requested + completed', au.some((x) => x.action === 'password_reset_requested') && au.some((x) => x.action === 'password_reset_completed'));
  // --- admin: temp password (generated), forced change
  const rs = new S(); await rs.login('ray@ffd.demo', CP);
  ok('Temp password needs CSRF token', (await new S().req('POST', `/api/admin/contractors/${ray.id}/password/temp`, {}, { Cookie: Object.entries(adm.c).map(([k, v]) => `${k}=${v}`).join('; '), 'X-CSRF-Token': '' })).s === 403);
  ok('Contractor cannot use admin password override', (await rs.req('POST', `/api/admin/contractors/${ray.id}/password/temp`, {})).s === 403);
  const tp = await adm.req('POST', `/api/admin/contractors/${ray.id}/password/temp`, {});
  ok('Admin sets auto-generated temp password (returned once, no-store)', tp.s === 200 && tp.j.password && tp.j.password.length >= 12 && (tp.h.get('cache-control') || '').includes('no-store'));
  ok("Temp password ended the contractor's sessions", (await rs.req('GET', '/api/my/status')).s === 401);
  const rt = new S(); const rl = await rt.login('ray@ffd.demo', tp.j.password);
  ok('Temp password signs in but flags must_change', rl.s === 200 && rl.j.must_change === true);
  ok('Until changed, the app API is blocked (403 must_change)', (await rt.req('GET', '/api/my/status')).j.must_change === true);
  ok('Required change rejects a weak password', (await rt.req('POST', '/api/password/change', { current: tp.j.password, password: 'weakpass' })).s === 400);
  const RP = `Crew-${Math.random().toString(36).slice(2, 8)}-Ok9!`;
  ok('Required change with strong password works and unlocks the app', (await rt.req('POST', '/api/password/change', { current: tp.j.password, password: RP })).s === 200 && (await rt.req('GET', '/api/my/status')).s === 200);
  const typed = await adm.req('POST', `/api/admin/contractors/${ray.id}/password/temp`, { password: 'abc' }); ok('Admin-typed temp password must be strong', typed.s === 400);
  // --- force reset + unlock
  const fr = await adm.req('POST', `/api/admin/contractors/${ray.id}/password/reset-link`, { force: true });
  ok('Force password reset: link sent, sessions ended', fr.s === 200 && (await rt.req('GET', '/api/my/status')).s === 401);
  for (let i = 0; i < 10; i++) await new S().login('ray@ffd.demo', 'wrong-password-' + i);
  const ac = (await adm.req('GET', `/api/admin/contractors/${ray.id}/account`)).j.account;
  ok('Repeated failures lock the account (admin sees LOCKED)', ac.locked === true && ac.must_change === true);
  ok('Locked: even the right password is refused', (await new S().login('ray@ffd.demo', RP)).s === 401);
  const ul = await adm.req('POST', `/api/admin/contractors/${ray.id}/unlock`, {});
  ok('Admin unlock clears the lockout', ul.s === 200 && (await new S().login('ray@ffd.demo', RP)).s === 200);
  const au2 = (await adm.req('GET', '/api/admin/audit')).j.log.map((x) => x.action);
  ok('Audit log: temp password, forced change, force reset, unlock', ['temp_password_set', 'password_changed_required', 'password_force_reset', 'account_unlocked'].every((a) => au2.includes(a)));
  ok('Audit log never contains the temp password', !JSON.stringify((await adm.req('GET', '/api/admin/audit')).j.log).includes(tp.j.password));
  // restore demo (passwords back to the restored demo logins)
  if (!process.env.NORESET) { await adm.req('POST', '/api/admin/demo/reset', {}); const z = new S(); ok('After demo reset, restored demo logins work again', (await z.login(je, CP)).s === 200 && (await new S().login('admin@ffd.demo', AP)).s === 200); }
  console.log(out.join('\n')); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(out.join('\n')); console.error(e); process.exit(1); });

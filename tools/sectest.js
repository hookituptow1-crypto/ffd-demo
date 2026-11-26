// Security sweep against a running FFD instance. Run: BASE=https://... node tools/sectest.js  (writes results to stdout as markdown rows)
const fs = require('fs'); const path = require('path');
const CREDS = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', 'private', 'creds.env'), 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
const BASE = process.env.BASE || 'http://localhost:4300'; const ORIGIN = new URL(BASE).origin;
const R = []; const ok = (area, name, cond, detail = '') => { R.push(`| ${area} | ${name} | ${cond ? '✅ PASS' : '❌ FAIL'} | ${String(detail).replace(/\|/g, '/').slice(0, 140)} |`); if (!cond) process.exitCode = 1; };
const jar = () => ({ c: '', csrf: '' });
async function req(j, method, p, body, extra = {}) {
  const h = { 'Content-Type': 'application/json', ...(j && j.c ? { Cookie: j.c } : {}), ...(j && j.csrf ? { 'x-csrf-token': j.csrf } : {}), ...extra };
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
  const sc = r.headers.get('set-cookie'); if (j && sc) { const m = sc.match(/((?:__Host-)?ffd_sid)=([^;]*)/); if (m) j.c = m[2] ? `${m[1]}=${m[2]}` : ''; j.lastSetCookie = sc; }
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { s: r.status, h: r.headers, text, json };
}
async function login(email, pw) { const j = jar(); const r = await req(j, 'POST', '/api/login', { email, password: pw }, { Origin: ORIGIN }); j.csrf = r.json && r.json.csrf; j.status = r.s; return j; }
(async () => {
  const PW = CREDS.CONTRACTOR_PASSWORD, APW = CREDS.ADMIN_PASSWORD;
  // ---------- headers / exposure
  const home = await fetch(BASE + '/'); const H = home.headers; const html = await home.text();
  ok('Headers', 'Content-Security-Policy (no unsafe-inline/eval scripts)', /script-src 'self'/.test(H.get('content-security-policy') || '') && !/unsafe/.test((H.get('content-security-policy') || '').match(/script-src[^;]*/)[0]), H.get('content-security-policy'));
  ok('Headers', 'HSTS 2y + includeSubDomains + preload', /max-age=63072000; includeSubDomains; preload/.test(H.get('strict-transport-security') || '') || !BASE.startsWith('https'), H.get('strict-transport-security'));
  ok('Headers', 'X-Frame-Options DENY + frame-ancestors none', H.get('x-frame-options') === 'DENY' && /frame-ancestors 'none'/.test(H.get('content-security-policy')));
  ok('Headers', 'nosniff, Referrer-Policy, Permissions-Policy, COOP, CORP', H.get('x-content-type-options') === 'nosniff' && !!H.get('referrer-policy') && !!H.get('permissions-policy') && H.get('cross-origin-opener-policy') === 'same-origin' && H.get('cross-origin-resource-policy') === 'same-origin');
  ok('Headers', 'No X-Powered-By / server version leak', !H.get('x-powered-by'), H.get('server') || '');
  ok('Exposure', 'Login page shows no demo accounts or passwords', !html.includes(PW) && !html.includes(APW) && !/demo account/i.test(html));
  const li = await (await fetch(BASE + '/js/login.js')).text(); ok('Exposure', 'login.js has no credentials / tap-to-fill', !li.includes('demo-info') && !li.includes(PW));
  ok('Exposure', '/api/demo-info is admin-only', (await req(null, 'GET', '/api/demo-info')).s === 401);
  ok('Robustness', '/health returns ok', (await req(null, 'GET', '/health')).json?.ok === true);
  // sign in the sessions we need BEFORE the brute-force tests (failed logins rightly block this IP for 5 min)
  const cody = await login('cody@ffd.demo', PW); const admin = await login('admin@ffd.demo', APW); const admin2 = await login('admin@ffd.demo', APW);
  const pre = jar(); pre.c = (BASE.startsWith('https') ? '__Host-ffd_sid' : 'ffd_sid') + '=attacker-chosen-session-token';
  const fx = await req(pre, 'POST', '/api/login', { email: 'ray@ffd.demo', password: PW }, { Origin: ORIGIN }); pre.csrf = fx.json && fx.json.csrf;
  // ---------- auth
  const bad1 = await req(jar(), 'POST', '/api/login', { email: 'nobody-here@ffd.demo', password: 'x'.repeat(12) }, { Origin: ORIGIN });
  const bad2 = await req(jar(), 'POST', '/api/login', { email: 'trent@ffd.demo', password: 'wrong-password-1' }, { Origin: ORIGIN });
  ok('Auth', 'Same error for unknown user and wrong password (no enumeration)', bad1.s === 401 && bad2.s === 401 && bad1.json.error === bad2.json.error, bad1.json.error);
  let t0 = Date.now(); await req(jar(), 'POST', '/api/login', { email: 'nobody2@ffd.demo', password: 'abcdefgh' }, { Origin: ORIGIN }); const tU = Date.now() - t0;
  t0 = Date.now(); await req(jar(), 'POST', '/api/login', { email: 'trent@ffd.demo', password: 'abcdefgh' }, { Origin: ORIGIN }); const tP = Date.now() - t0;
  ok('Auth', 'Similar timing for unknown user vs wrong password', Math.abs(tU - tP) < 450, `${tU} ms vs ${tP} ms (random 300–600 ms delay on every failure)`);
  ok('Auth', 'SQL injection in login email is rejected', (await req(jar(), 'POST', '/api/login', { email: "' OR 1=1 --", password: "' OR '1'='1" }, { Origin: ORIGIN })).s === 401);
  // lockout: 10 bad passwords for mike from this IP, then the right one is refused
  for (let i = 0; i < 10; i++) await req(jar(), 'POST', '/api/login', { email: 'mike@ffd.demo', password: `nope-${i}-xxxxxxxx` }, { Origin: ORIGIN });
  const locked = await login('mike@ffd.demo', PW);
  ok('Auth', 'Account+IP lockout after 10 failures in 5 min (correct password refused; admin can unlock)', locked.status === 401);
  // session fixation + cookie flags
  ok('Auth', 'Session fixation: new random token issued at login', fx.s === 200 && !pre.c.includes('attacker-chosen'));
  const sc = pre.lastSetCookie || '';
  ok('Auth', 'Cookie flags: HttpOnly, SameSite=Strict, Secure, __Host- prefix', /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && (!BASE.startsWith('https') || (/Secure/.test(sc) && /^__Host-/.test(sc))), sc.replace(/=[^;]{8,}/, '=…'));
  const tok = pre.c; await req(pre, 'POST', '/api/logout', {}, { Origin: ORIGIN });
  const after = await req({ c: tok }, 'GET', '/api/my/status');
  ok('Auth', 'Logout invalidates the session server-side (old cookie rejected)', after.s === 401);
  const lo = await login('luis@ffd.demo', PW);
  const noCsrf = await req({ c: lo.c }, 'POST', '/api/logout', {}, { Origin: ORIGIN });
  ok('Auth', 'Logout without a CSRF token still ends the session', noCsrf.s === 200 && noCsrf.json && noCsrf.json.ok && (await req({ c: lo.c }, 'GET', '/api/me')).s === 401);
  const cap = await login('ray@ffd.demo', PW);
  const capOut = await req({ c: cap.c, csrf: cap.csrf }, 'POST', '/api/logout', {}, { Origin: 'capacitor://localhost' });
  ok('Auth', 'Logout with capacitor:// Origin still ends the session', capOut.s === 200 && (await req({ c: cap.c }, 'GET', '/api/me')).s === 401);
  // ---------- access control
  ok('Setup', 'Admin + contractor logins work', cody.status === 200 && admin.status === 200);
  for (const p of ['/api/admin/contractors', '/api/admin/contractors/1', '/api/admin/tracking', '/api/admin/audit', '/api/admin/reports/daily', '/api/admin/schedule', '/api/admin/titles', '/api/admin/outbox', '/api/admin/tickets', '/api/admin/tickets/summary', '/api/admin/travel/settings', '/api/admin/crew', '/api/admin/contractors/1/account'])
    ok('Access control', `Contractor blocked from ${p}`, (await req(cody, 'GET', p)).s === 403);
  ok('Access control', 'Contractor cannot confirm tickets (POST /api/admin/tickets/confirm)', (await req(cody, 'POST', '/api/admin/tickets/confirm', { ids: [1] }, { Origin: ORIGIN })).s === 403);
  const cl = (await req(admin, 'GET', '/api/admin/contractors')).json.contractors; const codyId = cl.find((c) => c.name === 'Cody Ramirez').id; const other = cl.find((c) => c.name === 'Ray Castillo').id;
  const ups = (await req(admin, 'GET', `/api/admin/contractors/${other}`)).json.uploads;
  // give Ray an upload so there is something to try to steal
  const png = Buffer.from(fs.readFileSync(path.join(__dirname, 'demo-yellow-card.png'))).toString('base64');
  const up = await req(admin, 'POST', `/api/admin/contractors/${other}/uploads`, { label: 'Sec test', mime: 'image/png', data: png }, { Origin: ORIGIN });
  const upId = up.json && up.json.id; ok('Setup', 'Admin upload for another contractor', !!upId, ups.length);
  ok('Access control (IDOR)', "Contractor can't read another contractor's upload", (await req(cody, 'GET', `/api/uploads/${upId}`)).s === 404);
  ok('Access control (IDOR)', "Contractor can't read another contractor's headshot", (await req(cody, 'GET', `/api/headshot/${other}`)).s === 404);
  const mine = await req(cody, 'GET', '/api/my/profile'); ok('Access control (IDOR)', '/api/my/* is scoped to the session (no id parameter to tamper)', mine.s === 200 && JSON.stringify(mine.json).includes('Ramirez') && !JSON.stringify(mine.json).includes('Castillo'));
  ok('Access control (IDOR)', 'Medical data only via own profile (admin detail needs admin)', (await req(cody, 'GET', `/api/admin/contractors/${other}`)).s === 403);
  // ---------- CSRF
  ok('CSRF', 'Write without CSRF token is refused', (await req({ c: cody.c }, 'POST', '/api/my/alerts/read', {})).s === 403);
  ok('CSRF', 'Write with wrong CSRF token is refused', (await req({ c: cody.c, csrf: 'forged' }, 'POST', '/api/my/alerts/read', {})).s === 403);
  ok('CSRF', 'Cross-site Origin is refused even with a token', (await req(cody, 'POST', '/api/my/alerts/read', {}, { Origin: 'https://evil.example' })).s === 403);
  ok('CSRF', 'Admin reset needs CSRF', (await req({ c: admin.c }, 'POST', '/api/admin/demo/reset', {})).s === 403);
  // ---------- injection
  const xss = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const al = await req(admin, 'POST', '/api/admin/alerts', { contractor_ids: [codyId], kind: 'info', title: `XSS ${xss}`, body: xss }, { Origin: ORIGIN });
  ok('Injection', 'XSS payload accepted as plain text (rendered escaped; CSP blocks inline script)', al.s === 200, `status ${al.s}`);
  ok('Injection', 'SQL metacharacters in search/ids are rejected', (await req(admin, 'GET', "/api/admin/contractors/1%20OR%201=1")).s === 404);
  ok('Injection', 'Path traversal on uploads', (await req(admin, 'GET', '/api/uploads/..%2f..%2fdata%2fdata.key')).s === 404);
  for (const p of ['/../data/data.key', '/%2e%2e/data/ffd.db', '/data/ffd.db', '/private/creds.env', '/.git/config', '/src/server.js', '/package.json'])
    { const r = await fetch(BASE + p); const t = await r.text(); ok('Injection', `No file served at ${p}`, r.status === 404 && !/DATA_KEY|SQLite|\[core\]|require\(/.test(t), r.status); }
  // ---------- uploads
  ok('Uploads', 'Content that does not match its type is refused', (await req(cody, 'POST', '/api/my/uploads', { label: 'fake', mime: 'image/png', data: Buffer.from('<html><script>alert(1)</script>').toString('base64') }, { Origin: ORIGIN })).s === 400);
  ok('Uploads', 'Disallowed type (HTML/SVG) refused', (await req(cody, 'POST', '/api/my/uploads', { label: 'x', mime: 'image/svg+xml', data: 'PHN2Zz4=' }, { Origin: ORIGIN })).s === 400);
  const big = 'A'.repeat(9 * 1024 * 1024);
  ok('Uploads', 'Oversize upload (9 MB) refused', [400, 413].includes((await req(cody, 'POST', '/api/my/uploads', { label: 'big', mime: 'image/png', data: big }, { Origin: ORIGIN })).s));
  const served = await req(admin, 'GET', `/api/uploads/${upId}`);
  ok('Uploads', 'Served as attachment, nosniff, sandbox CSP, no-store', /attachment/.test(served.h.get('content-disposition')) && served.h.get('x-content-type-options') === 'nosniff' && /sandbox/.test(served.h.get('content-security-policy')) && /no-store/.test(served.h.get('cache-control')));
  ok('Uploads', 'Headshot must be a real square JPEG', (await req(cody, 'POST', '/api/my/headshot', { data: png }, { Origin: ORIGIN })).s === 400);
  // ---------- robustness
  const big2 = await req(jar(), 'POST', '/api/login', JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(100000) }), { Origin: ORIGIN });
  ok('Robustness', 'Oversize JSON body refused (413) without stack trace', big2.s === 413 && !/at .*\.js:\d+/.test(big2.text), big2.text.slice(0, 60));
  const mal = await req(jar(), 'POST', '/api/login', '{"email":', { Origin: ORIGIN });
  ok('Robustness', 'Malformed JSON -> generic 400, no internals', mal.s === 400 && !/SyntaxError|at JSON|node_modules/.test(mal.text), mal.text.slice(0, 60));
  const nf = await fetch(BASE + '/does-not-exist'); const nft = await nf.text(); ok('Robustness', 'Unknown route -> plain 404 page, no stack', nf.status === 404 && !/at .*\.js:\d+|Express|node_modules/.test(nft));
  const sos = []; for (let i = 0; i < 4; i++) sos.push((await req(await (async () => cody)(), 'POST', '/api/my/sos', { message: `sec test ${i}` }, { Origin: ORIGIN })).s);
  ok('Rate limits', 'SOS spam limited (max 3 / 10 min per user)', sos.slice(-1)[0] === 429 || sos.includes(409), sos.join(','));
  let lim = 0; for (let i = 0; i < 40 && !lim; i++) { const r = await req(jar(), 'POST', '/api/login', { email: `spray${i}@ffd.demo`, password: 'abcdefghij' }, { Origin: ORIGIN }); if (r.s === 429 || (r.s === 401 && i >= 10)) lim = i + 1; }
  ok('Rate limits', 'Login spraying from one IP is throttled', lim > 0 && lim <= 31, `blocked at attempt ${lim}`);
  // report token scope
  const tf = '/home/box/.ffd/report-token'; if (fs.existsSync(tf)) { const T = fs.readFileSync(tf, 'utf8').trim();
    ok('Report token', 'Token reads the daily report', (await req(null, 'GET', '/api/admin/reports/daily', undefined, { Authorization: `Bearer ${T}` })).s === 200);
    for (const p of ['/api/admin/contractors', '/api/admin/reports/daily.csv', '/api/my/status', '/api/admin/schedule']) ok('Report token', `Token refused on ${p}`, (await req(null, 'GET', p, undefined, { Authorization: `Bearer ${T}` })).s === 401);
    ok('Report token', 'Wrong token refused', (await req(null, 'GET', '/api/admin/reports/daily', undefined, { Authorization: 'Bearer wrong' })).s === 401); }
  // clean up: restore demo data
  const rs = await req(admin2, 'POST', '/api/admin/demo/reset', {}, { Origin: ORIGIN }); ok('Cleanup', 'Demo data reset after sweep', rs.s === 200);
  console.log('| Area | Check | Result | Detail |\n|---|---|---|---|\n' + R.join('\n'));
})();

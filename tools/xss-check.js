// Stored-XSS render check: payloads in an alert, the intake sheet and the booking assistant prompt must render as text. Run: BASE=... node tools/xss-check.js
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const C = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', 'private', 'creds.env'), 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
const BASE = process.env.BASE || 'http://localhost:4300'; const X = '<img src=x onerror="window.__xss=1;alert(1)"><svg onload=alert(2)>';
const out = []; const ok = (n, c, d = '') => { out.push(`| Injection (render) | ${n} | ${c ? '✅ PASS' : '❌ FAIL'} | ${d} |`); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch(); let dialogs = 0;
  const sess = async (e, pw, vp) => { const ctx = await b.newContext({ viewport: vp }); const p = await ctx.newPage(); p.on('dialog', (d) => { dialogs++; d.dismiss(); });
    await p.goto(BASE + '/'); await p.fill('#email', e); await p.fill('#pw', pw); await p.click('form button'); await p.waitForSelector('.verdict, .tile', { timeout: 30000 }); return p; };
  const a = await sess('admin@ffd.demo', C.ADMIN_PASSWORD, { width: 1400, height: 900 });
  const cid = await a.evaluate(async () => (await api('GET', '/api/admin/contractors')).contractors.find((c) => c.name === 'Cody Ramirez').id);
  await a.evaluate(async ([cid, X]) => { await api('POST', '/api/admin/alerts', { contractor_ids: [cid], kind: 'info', title: `T ${X}`, body: X }); }, [cid, X]);
  await a.evaluate(async ([cid, X]) => { const d = await api('GET', `/api/admin/contractors/${cid}`); const p = d.profile; p.medical.allergies = X; p.personal.preferred_name = X; await api('PUT', `/api/admin/contractors/${cid}/profile`, { profile: p }); }, [cid, X]);
  await a.goto(BASE + '/admin.html#/assistant'); await a.waitForTimeout(800);
  await a.evaluate(async (X) => { try { await api('POST', '/api/admin/assistant/plan', { text: X }); } catch {} }, X);
  const inp = await a.$('#aq, textarea, input[type=text]'); if (inp) { await inp.fill(X); await a.keyboard.press('Enter'); await a.waitForTimeout(1200); }
  await a.goto(BASE + `/admin.html#/c/${cid}/profile`); await a.waitForTimeout(1500);
  await a.goto(BASE + `/admin.html#/c/${cid}/alerts`); await a.waitForTimeout(1000);
  const p = await sess('cody@ffd.demo', C.CONTRACTOR_PASSWORD, { width: 390, height: 844 }); await p.waitForTimeout(800);
  await p.click('[data-tab="alerts"]'); await p.waitForTimeout(800); const shown = (await p.textContent('#view')).includes('<img src=x');
  await p.click('[data-tab="profile"]'); await p.waitForTimeout(1200);
  const flag = await p.evaluate(() => window.__xss) || await a.evaluate(() => window.__xss);
  ok('Alert, intake fields and assistant prompt render as text (no script ran, no dialogs)', !flag && dialogs === 0 && shown, `payload visible as text: ${shown}; dialogs: ${dialogs}`);
  await a.evaluate(async () => { await api('POST', '/api/admin/demo/reset'); });
  await b.close(); console.log(out.join('\n'));
})();

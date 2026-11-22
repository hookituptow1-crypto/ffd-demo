// Live-site check. MODE=write adds a persistence marker; MODE=check verifies it survived a restart and removes it.
const { chromium } = require('playwright');
const CREDS = Object.fromEntries(require('fs').readFileSync(require('path').join(__dirname, '..', 'private', 'creds.env'), 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
const U = process.env.BASE || 'https://ffd-demo-tyop.onrender.com';
const MODE = process.env.MODE || 'write';
(async () => {
  const b = await chromium.launch(); const out = [];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }); const p = await ctx.newPage();
  await p.goto(U + '/', { timeout: 60000 }); await p.waitForSelector('.demo-acct', { timeout: 60000 }); await p.waitForTimeout(800);
  if (MODE === 'write') await p.screenshot({ path: 'screens/live-login.png' });
  await p.fill('#email', 'admin@ffd.demo'); await p.fill('#pw', CREDS.ADMIN_PASSWORD); await p.click('form button'); await p.waitForSelector('.tile .n', { timeout: 60000 });
  out.push('admin login OK: board shows ' + await p.textContent('.tile .n') + ' contractors');
  const res = await p.evaluate(async (mode) => {
    const list = (await api('GET', '/api/admin/contractors')).contractors; const c = list.find((x) => x.name === 'Dana Whitfield');
    const d = await api('GET', `/api/admin/contractors/${c.id}`); const m = d.blockers.find((x) => x.description === 'PERSISTENCE-CHECK');
    if (mode === 'write') { if (!m) await api('POST', `/api/admin/contractors/${c.id}/blockers`, { description: 'PERSISTENCE-CHECK' }); return 'marker written'; }
    if (m) { await api('PUT', `/api/admin/blockers/${m.id}`, { active: false }); return 'marker FOUND after restart (persisted) — cleared'; }
    return 'marker MISSING';
  }, MODE);
  out.push(res);
  if (MODE === 'write') await p.screenshot({ path: 'screens/live-admin.png' });
  const q = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
  await q.goto(U + '/'); await q.fill('#email', 'cody@ffd.demo'); await q.fill('#pw', CREDS.CONTRACTOR_PASSWORD); await q.click('form button'); await q.waitForSelector('.verdict', { timeout: 60000 });
  out.push('contractor login OK (cody): ' + await q.textContent('.verdict'));
  if (MODE === 'write') {
    await q.click('[data-tab="profile"]'); await q.waitForTimeout(1500);
    const txt = await q.textContent('#pf');
    out.push('intake sections: ' + ['Home / preferred airport', 'Contact info', 'Emergency contacts', 'Government ID', 'Passport', 'Visas', 'Physical / medical exam', 'Physical description', 'Confidential medical'].map((t) => `${t}:${txt.includes(t) ? 'ok' : 'MISSING'}`).join(', '));
    await q.click('summary:has-text("Home / preferred airport")'); out.push('Cody home airport: ' + await q.inputValue('[data-f="travel.home_airport"]'));
    await q.screenshot({ path: 'screens/live-intake.png' });
    await p.goto(U + '/admin.html#/map'); await p.waitForTimeout(4000);
    out.push('map: ' + (await p.$$('.leaflet-interactive')).length + ' pins, tiles loaded: ' + (await p.$$eval('img.leaflet-tile-loaded', (x) => x.length)) + ', overdue row: ' + (await p.textContent('tr:has-text("Mike Brennan")')).includes('Overdue'));
    await p.screenshot({ path: 'screens/live-map.png' });
    await p.goto(U + '/admin.html#/assistant'); await p.waitForTimeout(600);
    await p.fill('#ask', 'John Doe needs to go to Africa'); await p.click('#askB'); await p.waitForTimeout(2000);
    const t = await p.textContent('.bubble.bot:last-child');
    out.push('assistant John: ' + (t.includes('BLOCKED') || t.includes('Blocked') ? 'blocked (red)' : 'not blocked') + ', origin MEM: ' + t.includes('MEM (home)'));
    const ctx3 = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }); const r = await ctx3.newPage();
    await r.goto(U + '/'); await r.fill('#email', 'trent@ffd.demo'); await r.fill('#pw', CREDS.CONTRACTOR_PASSWORD); await r.click('form button'); await r.waitForSelector('.verdict', { timeout: 60000 });
    out.push('trent background check: ' + ((await r.textContent('#view')).includes('In progress') ? 'in progress (red)' : '??'));
  }
  console.log(out.join('\n')); await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });

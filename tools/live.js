// Live-site check. MODE=write adds a persistence marker; MODE=check verifies it survived a restart and removes it.
const { chromium } = require('playwright');
const U = process.env.BASE || 'https://ffd-demo-tyop.onrender.com';
const MODE = process.env.MODE || 'write';
(async () => {
  const b = await chromium.launch(); const out = [];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }); const p = await ctx.newPage();
  await p.goto(U + '/', { timeout: 60000 }); await p.waitForSelector('.demo-acct', { timeout: 60000 }); await p.waitForTimeout(800);
  if (MODE === 'write') await p.screenshot({ path: 'screens/live-login.png' });
  await p.fill('#email', 'admin@ffd.demo'); await p.fill('#pw', 'FFD!Admin2026'); await p.click('form button'); await p.waitForURL(/admin/); await p.waitForSelector('.tile .n');
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
  await q.goto(U + '/'); await q.fill('#email', 'cody@ffd.demo'); await q.fill('#pw', 'Deploy!2026'); await q.click('form button'); await q.waitForURL(/app/); await q.waitForSelector('.verdict');
  out.push('contractor login OK (cody): ' + await q.textContent('.verdict'));
  console.log(out.join('\n')); await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });

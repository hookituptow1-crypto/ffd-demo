const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:4300';
(async () => {
  const b = await chromium.launch();
  const errs = [];
  async function shot(email, pw, url, file, vp) {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2 });
    const p = await ctx.newPage(); p.on('console', (m) => m.type() === 'error' && errs.push(`${file}: ${m.text()}`)); p.on('pageerror', (e) => errs.push(`${file}: ${e.message}`));
    await p.goto(BASE + '/'); await p.fill('#email', email); await p.fill('#pw', pw); await p.click('form button');
    await p.waitForURL(/app|admin/); if (url) await p.goto(BASE + url); await p.waitForTimeout(1200);
    await p.screenshot({ path: `screens/${file}`, fullPage: false }); await ctx.close();
  }
  const phone = { width: 390, height: 844 };
  await shot('marcus@ffd.demo', 'Deploy!2026', null, 'preview-phone-green.png', phone);
  await shot('sam@ffd.demo', 'Deploy!2026', null, 'preview-phone-red.png', phone);
  await shot('admin@ffd.demo', 'FFD!Admin2026', null, 'preview-admin-dashboard.png', { width: 1440, height: 900 });
  console.log(errs.join('\n') || 'no console errors'); await b.close();
})();

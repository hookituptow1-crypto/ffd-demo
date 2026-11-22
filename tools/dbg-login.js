const { chromium } = require('playwright'); const fs = require('fs');
const C = Object.fromEntries(fs.readFileSync(__dirname + '/../private/creds.env', 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
(async () => { const b = await chromium.launch(); const p = await b.newPage(); p.on('console', (m) => console.log('console', m.type(), m.text())); p.on('response', (r) => { if (r.url().includes('/api/')) console.log(r.status(), r.url()); });
  await p.goto('https://ffd-demo-tyop.onrender.com/'); await p.fill('#email', 'admin@ffd.demo'); await p.fill('#pw', C.ADMIN_PASSWORD); await p.click('form button'); await p.waitForTimeout(5000); console.log(p.url()); console.log((await p.textContent('body')).slice(0, 300)); await b.close(); })();

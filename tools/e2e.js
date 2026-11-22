// End-to-end click-through of every demo flow, with screenshots. Run: node tools/e2e.js  (server must be running)
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:4300';
const PW = 'Deploy!2026', ADMIN = ['admin@ffd.demo', 'FFD!Admin2026'];
const phone = { width: 390, height: 844 }, desk = { width: 1440, height: 900 };
const results = []; const errs = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!cond) process.exitCode = 1; };

(async () => {
  const b = await chromium.launch();
  async function session(email, pw, vp) {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2 }); const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(`${email}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error' && !/401/.test(m.text())) errs.push(`${email}: ${m.text()}`); });
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE + '/'); await p.fill('#email', email); await p.fill('#pw', pw); await p.click('form button'); await p.waitForURL(/app|admin/);
    await p.waitForTimeout(900); return p;
  }
  const snap = (p, f, full = false) => p.screenshot({ path: `screens/${f}`, fullPage: full });
  const verdict = (p) => p.textContent('.verdict');

  // reset demo to a known state
  let a = await session(...ADMIN, desk);
  await a.evaluate(async () => { await api('POST', '/api/admin/demo/reset'); });
  await a.context().close();

  // login page
  { const ctx = await b.newContext({ viewport: phone, deviceScaleFactor: 2 }); const p = await ctx.newPage(); await p.goto(BASE + '/'); await p.waitForTimeout(800); await snap(p, '00-login-phone.png', true); await ctx.close(); }

  // --- Contractor states ---
  let p = await session('marcus@ffd.demo', PW, phone);
  ok('A green: Marcus shows CLEARED TO DEPLOY', (await verdict(p)).includes('CLEARED TO DEPLOY'));
  await snap(p, '01-phone-green.png'); await snap(p, '01-phone-green-full.png', true);
  ok('Marcus has NEW flight badge', (await p.textContent('#flN')) === '2');
  await p.click('[data-tab="flights"]'); await p.waitForTimeout(500); await snap(p, '02-phone-flights.png', true);
  ok('Flights tab lists QR 714', (await p.textContent('#view')).includes('QR 714'));
  await p.context().close();

  p = await session('cody@ffd.demo', PW, phone);
  ok('B yellow: Cody shows CLEARED THIS ROTATION with countdown', (await verdict(p)).includes('CLEARED THIS ROTATION') && await p.isVisible('.countdown'));
  await snap(p, '03-phone-yellow.png'); await snap(p, '03-phone-yellow-full.png', true);
  await p.context().close();

  p = await session('sam@ffd.demo', PW, phone);
  ok('C red: Sam shows NO-GO', (await verdict(p)).includes('NO-GO'));
  await snap(p, '04-phone-red.png'); await snap(p, '04-phone-red-full.png', true);
  await p.context().close();

  // --- Admin ---
  a = await session(...ADMIN, desk);
  await snap(a, '10-admin-dashboard.png');
  ok('Admin board shows 9 contractors', (await a.textContent('.tile .n')) === '9');
  ok('Board counts 2 green / 4 yellow / 3 red', (await a.textContent('.tile.green .n')) === '2' && (await a.textContent('.tile.yellow .n')) === '4' && (await a.textContent('.tile.red .n')) === '3');
  await a.click('.tile.red'); await a.waitForTimeout(400); ok('Red filter shows 3 rows', (await a.$$('#rows tr')).length === 3); await snap(a, '11-admin-filter-red.png');
  await a.goto(BASE + '/admin.html#/scenarios'); await a.waitForTimeout(800); await snap(a, '12-admin-demo-scenarios.png', true);

  // Flight send screen (Marcus)
  const ids = await a.evaluate(async () => Object.fromEntries((await api('GET', '/api/admin/contractors')).contractors.map((c) => [c.name, c.id])));
  await a.goto(BASE + `/admin.html#/c/${ids['Marcus Delgado']}/flights`); await a.waitForTimeout(700);
  await a.fill('#fAir', 'Qatar Airways'); await a.fill('#fNo', 'QR 451'); await a.fill('#fConf', 'QRDEMO9'); await a.fill('#fFrom', 'EBL'); await a.fill('#fTo', 'DOH');
  await a.fill('#fSeat', '12C'); await a.fill('#fDep', '2027-02-02T06:15'); await a.fill('#fArr', '2027-02-02T08:30'); await a.fill('#fNotes', 'Return leg — demo');
  await snap(a, '13-admin-flight-send.png');
  await a.click('#fSend'); await a.waitForTimeout(900);
  ok('Flight sent appears in admin itinerary', (await a.textContent('#sub')).includes('QR 451'));
  await snap(a, '14-admin-flight-sent.png');
  // Edit flight → auto alert
  const editBtns = await a.$$('[data-fe]'); await editBtns[0].click(); await a.waitForTimeout(400);
  await a.fill('.modal #fDep', (await a.inputValue('.modal #fDep')).slice(0, 11) + '21:10'); await a.click('#feS'); await a.waitForTimeout(800);

  // Readiness + profile tabs
  await a.goto(BASE + `/admin.html#/c/${ids['Cody Ramirez']}`); await a.waitForTimeout(700); await snap(a, '15-admin-contractor-readiness.png');
  await a.goto(BASE + `/admin.html#/c/${ids['Cody Ramirez']}/profile`); await a.waitForTimeout(700); await snap(a, '16-admin-contractor-profile.png');
  ok('Admin profile shows full passport number', (await a.inputValue('[data-f="passport.number"]')).startsWith('DEMO'));

  // Send alert to all red
  await a.goto(BASE + '/admin.html#/alerts'); await a.waitForTimeout(600);
  await a.selectOption('#alTo', 'red'); await a.selectOption('#alK', 'urgent'); await a.fill('#alT', 'Fix your blockers this week'); await a.fill('#alB', 'You are RED. Open the app to see what to fix.');
  await snap(a, '17-admin-send-alert.png'); await a.click('#alSend'); await a.waitForTimeout(600);
  ok('Alert to all RED sent', (await a.textContent('.toast')).includes('3 contractors'));

  // Assistant: John blocked, Tyler allowed
  await a.goto(BASE + '/admin.html#/assistant'); await a.waitForTimeout(500);
  await a.fill('#ask', 'John Doe needs to go to Africa'); await a.click('#askB'); await a.waitForTimeout(900);
  ok('Assistant BLOCKS red John Doe', (await a.$$('.bubble.bot button[disabled]')).length > 0 && (await a.textContent('.bubble.bot')).includes('Yellow Fever'));
  await snap(a, '20-assistant-red-blocked.png', true);
  await a.fill('#ask', 'Tyler Brandt needs to go to Africa'); await a.click('#askB'); await a.waitForTimeout(900);
  const tylerBtn = (await a.$$('.bubble.bot:last-child [data-book]'))[0];
  ok('Assistant offers bookable fares for green Tyler', !!tylerBtn);
  await snap(a, '21-assistant-green-fares.png', true);
  await tylerBtn.click(); await a.waitForTimeout(900);
  ok('Tyler booked', (await a.textContent('.bubble.bot:last-child')).includes('Booked'));
  await snap(a, '22-assistant-green-booked.png', true);
  // API-level: booking red is refused server-side even if UI bypassed
  const red = await a.evaluate(async (id) => { try { await api('POST', '/api/admin/assistant/book', { contractor_id: id, destination_id: 3, airline: 'Emirates' }); return 'allowed'; } catch (e) { return e.message; } }, ids['John Doe']);
  ok('Server refuses booking for RED contractor', red.includes('blocked'), red.slice(0, 60));

  // --- D: John fixes yellow fever live ---
  p = await session('john@ffd.demo', PW, phone);
  ok('John starts RED', (await verdict(p)).includes('NO-GO'));
  await snap(p, '30-john-red-before.png');
  await p.click('.req.red [data-fix]'); await p.waitForTimeout(300);
  await p.fill('#mNum', 'ICVP-DEMO-0042'); await p.fill('#mIss', '2026-11-20'); await p.setInputFiles('#mFile', 'tools/demo-yellow-card.png');
  await snap(p, '31-john-fix-yellow-fever.png');
  await p.click('#mSave'); await p.waitForTimeout(1200);
  ok('John flips to GREEN after upload', (await verdict(p)).includes('CLEARED TO DEPLOY'));
  await snap(p, '32-john-green-after.png');
  // Intake form
  await p.click('[data-tab="profile"]'); await p.waitForTimeout(700);
  await p.fill('[data-f="medical.allergies"]', 'Penicillin, bee stings').catch(() => {});
  await p.click('summary:has-text("Medical")'); await p.fill('[data-f="medical.allergies"]', 'Penicillin, bee stings');
  await p.click('#save'); await p.waitForTimeout(800);
  await p.click('[data-tab="profile"]'); await p.waitForTimeout(700); await p.click('summary:has-text("Passport")');
  await snap(p, '33-john-intake-form.png', true);
  await p.context().close();

  // Admin sees self-reported doc + John now bookable
  await a.goto(BASE + `/admin.html#/c/${ids['John Doe']}`); await a.waitForTimeout(700);
  ok('Admin sees self-reported badge + Verify', (await a.$$('[data-verify]')).length === 1);
  await snap(a, '34-admin-john-verify.png');
  await a.click('[data-verify]'); await a.waitForTimeout(600);
  await a.goto(BASE + '/admin.html#/assistant'); await a.waitForTimeout(400);
  await a.fill('#ask', 'John Doe needs to go to Africa'); await a.click('#askB'); await a.waitForTimeout(900);
  const johnBtn = (await a.$$('.bubble.bot:last-child [data-book]'))[0];
  ok('Assistant now ALLOWS John', !!johnBtn);
  await snap(a, '35-assistant-john-allowed.png', true);
  await johnBtn.click(); await a.waitForTimeout(900);

  p = await session('john@ffd.demo', PW, phone);
  ok('John has new flights + alert', (await p.textContent('#flN')) === '2' && Number(await p.textContent('#bellN')) >= 1);
  await p.click('[data-tab="flights"]'); await p.waitForTimeout(500);
  ok("John's booked trip departs from his home airport (MEM) or alternate (LIT)", /\b(MEM|LIT)\b/.test((await p.$$eval('.flight .route', (r) => r.map((x) => x.textContent).join(' ')))));
  await snap(p, '36b-john-flights-from-home.png', true); await p.click('[data-tab="status"]'); await p.waitForTimeout(300);
  await snap(p, '36-john-booked-alert.png');
  await p.click('[data-tab="alerts"]'); await p.waitForTimeout(500); await snap(p, '37-john-alerts.png', true);
  await p.context().close();

  p = await session('marcus@ffd.demo', PW, phone);
  await p.click('[data-tab="alerts"]'); await p.waitForTimeout(500);
  ok('Marcus got auto "Flight changed" alert', (await p.textContent('#view')).includes('Flight changed'));
  await snap(p, '38-marcus-flight-changed-alert.png', true);
  // Security: contractor cannot hit admin API, cannot read others' uploads, CSRF enforced
  const sec = await p.evaluate(async () => {
    const r1 = await fetch('/api/admin/contractors'); const r2 = await fetch('/api/uploads/1');
    const r3 = await fetch('/api/my/alerts/read', { method: 'POST' }); return [r1.status, r2.status, r3.status];
  });
  ok('Contractor blocked from admin API (403)', sec[0] === 403); ok("Contractor can't read another's upload (404)", sec[1] === 404); ok('CSRF token required (403)', sec[2] === 403);
  await p.context().close();

  // --- Background check ---
  p = await session('dana@ffd.demo', PW, phone);
  ok('Dana YELLOW from background check', (await verdict(p)).includes('CLEARED THIS ROTATION') && (await p.textContent('.countdown')).includes('Background Check'));
  await snap(p, '50-dana-yellow-background.png'); await p.context().close();
  p = await session('trent@ffd.demo', PW, phone);
  ok('Trent RED with background check in progress', (await verdict(p)).includes('NO-GO') && (await p.textContent('#view')).includes('In progress'));
  await snap(p, '51-trent-red-background.png', true); await p.context().close();
  await a.goto(BASE + `/admin.html#/c/${ids['Dana Whitfield']}`); await a.waitForTimeout(700);
  await a.click('tr:has-text("Background Check") [data-doc]'); await a.waitForTimeout(300);
  await snap(a, '52-admin-background-check-modal.png');
  await a.fill('#bC', new Date().toISOString().slice(0, 10)); await a.fill('#bE', ''); await a.selectOption('#bS', 'cleared');
  await a.setInputFiles('#bF', 'tools/demo-yellow-card.png'); await a.click('#bSave'); await a.waitForTimeout(800);
  ok('Admin renewal (completion + 365d default) turns Dana GREEN', (await a.textContent('.head')).includes('Green'));
  await snap(a, '53-admin-dana-green-after-renewal.png');

  // --- Home airport picker + assistant origin ---
  p = await session('tyler@ffd.demo', PW, phone);
  await p.click('[data-tab="profile"]'); await p.waitForTimeout(700); await p.click('summary:has-text("Home / preferred airport")');
  const home = p.locator('[data-f="travel.home_airport"]'); await home.click(); await home.fill('Memph'); await p.waitForTimeout(200);
  await snap(p, '54-tyler-airport-typeahead.png');
  await p.click('.ap-list [data-code="MEM"]');
  const alt = p.locator('[data-f="travel.alt_airport"]'); await alt.click(); await alt.fill('BNA'); await p.waitForTimeout(200); await p.click('.ap-list [data-code="BNA"]');
  await p.click('#save'); await p.waitForTimeout(900);
  await p.click('[data-tab="profile"]'); await p.waitForTimeout(700); await p.click('summary:has-text("Home / preferred airport")');
  ok('Tyler home airport saved as MEM — Memphis', (await p.inputValue('[data-f="travel.home_airport"]')).startsWith('MEM'));
  await snap(p, '55-tyler-airport-saved.png'); await p.context().close();
  await a.goto(BASE + `/admin.html#/c/${ids['Tyler Brandt']}`); await a.waitForTimeout(700);
  ok('Admin detail shows Tyler home airport', (await a.textContent('.main')).includes('Home MEM'));
  await a.goto(BASE + '/admin.html#/assistant'); await a.waitForTimeout(400);
  await a.fill('#ask', 'Tyler Brandt needs to go to Africa'); await a.click('#askB'); await a.waitForTimeout(900);
  const tb = await a.textContent('.bubble.bot:last-child');
  ok('Assistant searches from Tyler home MEM + alternate BNA', tb.includes('MEM (home)') && tb.includes('BNA (alternate)'));
  await snap(a, '56-assistant-tyler-from-mem.png', true);

  await a.goto(BASE + '/admin.html#/destinations'); await a.waitForTimeout(600); await snap(a, '40-admin-destinations.png');
  await a.goto(BASE + '/admin.html#/audit'); await a.waitForTimeout(600); await snap(a, '41-admin-audit-log.png');
  // leave demo clean for Leslie's partner
  await a.evaluate(async () => { await api('POST', '/api/admin/demo/reset'); });
  await b.close();
  console.log(results.join('\n')); console.log(errs.length ? 'CONSOLE ERRORS:\n' + errs.join('\n') : 'No console/page errors');
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1); });

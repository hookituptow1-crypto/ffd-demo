// End-to-end click-through of every demo flow, with screenshots. Run: node tools/e2e.js  (server must be running)
const { chromium } = require('playwright');
const CREDS = Object.fromEntries(require('fs').readFileSync(require('path').join(__dirname, '..', 'private', 'creds.env'), 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
const BASE = process.env.BASE || 'http://localhost:4300';
const PW = CREDS.CONTRACTOR_PASSWORD, ADMIN = ['admin@ffd.demo', CREDS.ADMIN_PASSWORD];
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
    await p.goto(BASE + '/'); await p.fill('#email', email); await p.fill('#pw', pw); await p.click('form button'); await p.waitForURL(/app|admin/).catch(() => {}); await p.waitForSelector('.verdict, .tile, .head', { timeout: 30000 });
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
  ok('Admin board shows 12 contractors', (await a.textContent('.tile .n')) === '12');
  ok('Board counts 5 green / 4 yellow / 3 red', (await a.textContent('.tile.green .n')) === '5' && (await a.textContent('.tile.yellow .n')) === '4' && (await a.textContent('.tile.red .n')) === '3');
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
  await p.locator('summary:has-text("Confidential medical")').first().click(); await p.fill('[data-f="medical.allergies"]', 'Penicillin, bee stings');
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

  // --- Intake: uploads, contact, emergency, physical description, confidential medical ---
  p = await session('cody@ffd.demo', PW, phone);
  await p.click('[data-tab="profile"]'); await p.waitForTimeout(700);
  ok('Confidential medical section labelled', (await p.textContent('#pf')).includes('Confidential medical'));
  await p.click('summary:has-text("Government ID")');
  await p.setInputFiles('input[data-up="gov_id.front_upload"]', 'tools/demo-yellow-card.png'); await p.waitForTimeout(900);
  await p.setInputFiles('input[data-up="gov_id.back_upload"]', 'tools/demo-yellow-card.png'); await p.waitForTimeout(900);
  await p.click('summary:has-text("Physical description")'); await p.selectOption('[data-f="description.eye_color"]', 'Hazel');
  await p.click('summary:has-text("Contact info")'); await p.fill('[data-f="personal.alt_phone"]', '(555) 0199-0000');
  await snap(p, '60-cody-intake-sections.png', true);
  await p.click('#save'); await p.waitForTimeout(900);
  await p.click('[data-tab="profile"]'); await p.waitForTimeout(700); await p.click('summary:has-text("Government ID")');
  ok('ID front/back uploads saved to profile', (await p.$$('summary:has-text("Government ID") ~ .body a[href^="/api/uploads/"]')).length === 2);
  await p.locator('summary:has-text("Confidential medical")').first().click();
  await snap(p, '61-cody-confidential-medical.png', true);
  await p.context().close();
  await a.goto(BASE + `/admin.html#/c/${ids['Cody Ramirez']}`); await a.waitForTimeout(700);
  ok('Admin detail shows emergency contacts', (await a.textContent('.main')).includes('Emergency contacts') && (await a.textContent('.main')).includes('Maria Ramirez'));
  await snap(a, '62-admin-emergency-contact.png');
  await a.goto(BASE + `/admin.html#/c/${ids['Cody Ramirez']}/profile`); await a.waitForTimeout(700);
  ok('Admin sees contractor edits (eye color Hazel, alt phone)', (await a.inputValue('[data-f="description.eye_color"]')) === 'Hazel' && (await a.inputValue('[data-f="personal.alt_phone"]')) === '(555) 0199-0000');
  await snap(a, '63-admin-full-intake.png', true);

  // --- Deployed check-in & location ---
  { const ctx = await b.newContext({ viewport: phone, deviceScaleFactor: 2, permissions: ['geolocation'], geolocation: { latitude: 36.2412, longitude: 43.9701, accuracy: 30 } });
    p = await ctx.newPage(); p.on('dialog', (d) => d.accept());
    await p.goto(BASE + '/'); await p.fill('#email', 'ray@ffd.demo'); await p.fill('#pw', PW); await p.click('form button'); await p.waitForSelector('#trk');
    ok('Deployed contractor sees check-in card', await p.isVisible('#trkIn'));
    await p.click('#trkIn'); await p.waitForTimeout(1200);
    ok('Check-in recorded', (await p.textContent('#trk')).includes('min ago'));
    await p.locator('#trk').scrollIntoViewIfNeeded(); await snap(p, '70-ray-checkin.png');
    await p.click('#sos'); await p.fill('#sosM', 'Demo SOS — vehicle breakdown'); await snap(p, '71-ray-sos-confirm.png'); await p.click('#sosGo'); await p.waitForTimeout(1000);
    await ctx.close(); }
  p = await session('marcus@ffd.demo', PW, phone);
  ok('Non-deployed contractor has no check-in card', !(await p.$('#trk'))); await p.context().close();
  await a.goto(BASE + '/admin.html#/map'); await a.waitForTimeout(2500);
  ok('Admin SOS banner shows', (await a.textContent('#sosBar')).includes('SOS from Ray Castillo'));
  ok('Map shows 4 deployed pins', (await a.$$('.leaflet-interactive')).length >= 4);
  ok('Mike Brennan flagged overdue', (await a.textContent('tr:has-text("Mike Brennan")')).includes('Overdue'));
  await snap(a, '72-admin-deployed-map.png', true);
  await a.click('[data-ack]'); await a.waitForTimeout(600);

  await a.goto(BASE + '/admin.html#/destinations'); await a.waitForTimeout(600); await snap(a, '40-admin-destinations.png');
  await a.goto(BASE + '/admin.html#/audit'); await a.waitForTimeout(600); await snap(a, '41-admin-audit-log.png');
  // leave demo clean for Leslie's partner
  await a.evaluate(async () => { await api('POST', '/api/admin/demo/reset'); });
  await b.close();
  console.log(results.join('\n')); console.log(errs.length ? 'CONSOLE ERRORS:\n' + errs.join('\n') : 'No console/page errors');
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1); });

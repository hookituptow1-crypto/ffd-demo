// Phone (iPhone 390x844) checks: compact admin view + contractor app readability. Run: BASE=... PRE=live- node tools/e2e-mobile.js
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const CREDS = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', 'private', 'creds.env'), 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
const BASE = process.env.BASE || 'http://localhost:4300'; const PRE = process.env.PRE || '';
const phone = { width: 390, height: 844 }, tablet = { width: 820, height: 1180 }, desk = { width: 1440, height: 900 };
const results = []; const errs = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!cond) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch();
  async function session(email, pw, vp, wait) {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2, isMobile: vp.width < 768, hasTouch: vp.width < 768 }); const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(`${email}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error' && !/401|favicon/.test(m.text())) errs.push(`${email}: ${m.text()}`); });
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE + '/'); await p.fill('#email', email); await p.fill('#pw', pw); await p.click('form button'); await p.waitForURL(/app|admin/).catch(() => {});
    await p.waitForSelector(wait, { timeout: 30000 }); await p.waitForTimeout(900); return p;
  }
  const snap = (p, f, full = false) => p.screenshot({ path: `screens/${PRE}${f}`, fullPage: full });
  const noHScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  // ---- Admin on a phone: compact by default
  const a = await session('admin@ffd.demo', CREDS.ADMIN_PASSWORD, phone, '.mcard');
  ok('Phone admin defaults to Compact view', await a.evaluate(() => document.body.classList.contains('compact')));
  ok('Side menu hidden, bottom tab bar shown', !(await a.isVisible('.side')) && await a.isVisible('#mTabs'));
  ok('Tab bar has Board / Schedule / Report / Map / More', (await a.textContent('#mTabs')).replace(/\s+/g, ' ').match(/Board.*Schedule.*Report.*Map.*More/) !== null);
  ok('Toggle at the top offers Full view', (await a.textContent('#viewToggle')).includes('Full view'));
  const chips = await a.textContent('.chips');
  ok('Count chips for red / yellow / green / traveling today', /no-go/.test(chips) && /fix/.test(chips) && /cleared/.test(chips) && /traveling today/.test(chips), chips.replace(/\s+/g, ' '));
  const first = await a.$$eval('.mcard', (l) => l.slice(0, 30).map((c) => c.className.split(' ')[1]));
  const ord = { red: 0, yellow: 1, green: 2 };
  ok('Cards sorted problems first (red, then yellow, then green)', first.every((s, i) => i === 0 || ord[first[i - 1]] <= ord[s]) && first[0] === 'red');
  ok('Cards have photo, name, title and status dot', (await a.$$('.mcard img.av')).length >= 25 && (await a.$$('.mcard .bigdot')).length >= 25 && (await a.textContent('.mcard .mc-sub')).length > 1);
  const fs1 = await a.$eval('.mc-name', (e) => parseFloat(getComputedStyle(e).fontSize));
  ok('Bigger type on cards (>= 17px names)', fs1 >= 17, `${fs1}px`);
  ok('No sideways scrolling on phone board', await noHScroll(a));
  await snap(a, '60-phone-admin-compact-board.png');
  await a.click('[data-chip="red"]'); await a.waitForTimeout(700);
  const reds = await a.$$eval('.mcard', (l) => l.map((c) => c.className));
  ok('Tapping the red chip filters to red only', reds.length > 0 && reds.every((c) => c.includes('red')), `${reds.length} cards`);
  await snap(a, '61-phone-admin-red-chip.png');
  await a.click('[data-chip="red"]'); await a.waitForTimeout(500);
  await a.click('[data-chip="travel"]'); await a.waitForTimeout(500);
  ok('Traveling-today chip filters', (await a.$$('.mcard')).length >= 1);
  await a.click('[data-chip="travel"]'); await a.waitForTimeout(500);
  ok('Show more pages through all 80', (await a.textContent('#mMore')).includes('left'));
  // profile
  await a.fill('#mq', 'Darnell'); await a.waitForTimeout(300); await a.click('.mcard'); await a.waitForSelector('.m-prof'); await a.waitForTimeout(1000);
  const secs = await a.$$eval('details.msec summary', (l) => l.map((s) => s.textContent));
  ok('Profile has collapsible Documents / Flights / Contacts / Medical / Schedule', ['Documents', 'Flights', 'Contacts', 'Medical', 'Schedule'].every((k) => secs.some((s) => s.includes(k))), secs.join(' | '));
  ok('Profile shows big photo and what to fix', (await a.$eval('.m-photo', (i) => i.naturalWidth)) >= 256 && (await a.textContent('.m-fix')).includes('Visa'));
  await snap(a, '62-phone-admin-profile.png');
  for (const s of await a.$$('details.msec:not([open]) summary')) await s.click();
  await a.waitForTimeout(300);
  ok('Sections expand (contacts + medical visible)', /Blood type/.test(await a.textContent('#main')) && (await a.$$('#main a[href^="tel:"]')).length >= 1);
  ok('No sideways scrolling on phone profile', await noHScroll(a));
  await snap(a, '63-phone-admin-profile-expanded.png', true);
  // schedule
  await a.click('[data-mtab="schedule"]'); await a.waitForSelector('.m-day, .card'); await a.waitForTimeout(1200);
  const st = await a.textContent('#main');
  ok('Schedule is a phone list (coverage vs target + day list)', /Coverage today/.test(st) && /Erbil/.test(st) && (await a.$$('.mrow')).length > 0 && !(await a.$('table')));
  ok('Schedule tab highlighted', await a.$eval('[data-mtab="schedule"]', (e) => e.classList.contains('on')));
  await snap(a, '64-phone-admin-schedule.png');
  // report
  await a.click('[data-mtab="report"]'); await a.waitForSelector('.mrep, .m-head'); await a.waitForTimeout(1200);
  ok('Report is a phone list of cards', (await a.$$('.mrep')).length > 0 && !(await a.$('table')), `${(await a.$$('.mrep')).length} rows`);
  ok('No sideways scrolling on phone report', await noHScroll(a));
  await snap(a, '65-phone-admin-report.png');
  // map
  await a.click('[data-mtab="map"]'); await a.waitForTimeout(2500);
  ok('Map tab opens the deployed map', !!(await a.$('.leaflet-container')));
  await snap(a, '66-phone-admin-map.png');
  // more
  await a.click('[data-mtab="more"]'); await a.waitForSelector('.mmore');
  const more = await a.textContent('.mmore');
  ok('More sheet has the other pages, reset and sign out', /Crew/.test(more) && /Outbox/.test(more) && /Audit/.test(more) && /Sign out/.test(more) && /Reset demo/.test(more));
  await snap(a, '67-phone-admin-more.png');
  await a.click('.mmore a[href="#/crew"]'); await a.waitForTimeout(1500);
  ok('More → Crew page opens in compact view', (await a.textContent('#main')).includes('Coverage') && await noHScroll(a));
  // toggle to Full, persists across reload
  await a.goto(BASE + '/admin.html#/'); await a.waitForSelector('.mcard'); await a.click('#viewToggle'); await a.waitForSelector('#rows'); await a.waitForTimeout(800);
  ok('Toggle switches to Full view (table board)', !(await a.evaluate(() => document.body.classList.contains('compact'))) && !!(await a.$('#rows tr')));
  await a.reload(); await a.waitForSelector('#rows, .mcard'); await a.waitForTimeout(800);
  ok('Full view remembered on this device after reload', !!(await a.$('#rows')) && (await a.textContent('#viewToggle')).includes('Compact'));
  await snap(a, '68-phone-admin-full-view.png');
  await a.click('#viewToggle'); await a.waitForSelector('.mcard'); await a.reload(); await a.waitForSelector('.mcard, #rows');
  ok('Compact remembered after switching back', !!(await a.$('.mcard')));
  await a.context().close();
  // ---- tablet + laptop unchanged
  for (const [nm, vp] of [['Tablet', tablet], ['Laptop', desk]]) {
    const t = await session('admin@ffd.demo', CREDS.ADMIN_PASSWORD, vp, '.tile');
    ok(`${nm} defaults to the full view (side menu + table)`, !(await t.evaluate(() => document.body.classList.contains('compact'))) && await t.isVisible('.side') && !!(await t.$('#rows tr')) && !(await t.isVisible('#mTabs')));
    if (nm === 'Laptop') await snap(t, '69-laptop-full-view-unchanged.png');
    await t.context().close();
  }
  // ---- contractor app readability on a phone
  for (const who of ['marcus', 'david', 'darnell']) {
    const c = await session(`${who}@ffd.demo`, CREDS.CONTRACTOR_PASSWORD, phone, '.verdict');
    const small = await c.evaluate(() => [...document.querySelectorAll('#main *')].filter((e) => e.childElementCount === 0 && e.textContent.trim() && e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 13).map((e) => e.textContent.trim().slice(0, 30)));
    ok(`Contractor (${who}) no sideways scroll at 390px`, await noHScroll(c));
    ok(`Contractor (${who}) no text under 13px`, small.length === 0, small.slice(0, 5).join(' | '));
    await snap(c, `70-phone-contractor-${who}.png`, true);
    await c.context().close();
  }
  // Sign out must land on the login page and stay there (no auto-redirect bounce)
  const cOut = await session('marcus@ffd.demo', CREDS.CONTRACTOR_PASSWORD, phone, '.verdict');
  await cOut.click('#logout');
  await cOut.waitForURL(/signedout=1|\/$/, { timeout: 15000 });
  await cOut.waitForTimeout(1200);
  const signedOut = await cOut.evaluate(() => ({ path: location.pathname + location.search, hasForm: !!document.querySelector('#f'), hasApp: !!document.querySelector('.verdict') }));
  ok('Contractor Sign out stays on the login page', signedOut.hasForm && !signedOut.hasApp && /signedout=1/.test(signedOut.path), JSON.stringify(signedOut));
  await snap(cOut, '71-phone-contractor-signed-out.png');
  await cOut.context().close();
  const aOut = await session('admin@ffd.demo', CREDS.ADMIN_PASSWORD, phone, '.mcard');
  await aOut.click('[data-mtab="more"]'); await aOut.waitForSelector('#mOut'); await aOut.click('#mOut');
  await aOut.waitForURL(/signedout=1|\/$/, { timeout: 15000 });
  await aOut.waitForTimeout(1200);
  const adminOut = await aOut.evaluate(() => ({ path: location.pathname + location.search, hasForm: !!document.querySelector('#f'), hasBoard: !!document.querySelector('.mcard') }));
  ok('Admin Sign out stays on the login page', adminOut.hasForm && !adminOut.hasBoard && /signedout=1/.test(adminOut.path), JSON.stringify(adminOut));
  await aOut.context().close();
  await b.close();
  console.log(results.join('\n')); console.log(errs.length ? 'JS errors:\n' + errs.join('\n') : 'No JS errors');
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
})().catch((e) => { console.error(e); process.exit(1); });

// Ticket approval queue: proposals, banner/badge (full + compact), swap, reject, bulk confirm -> booking -> booked, contractor
// itinerary (app + email), report section, travel policy (cabin + preferred airline), access control. Run: BASE=... PRE=live- node tools/e2e-tickets.js
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const CREDS = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', 'private', 'creds.env'), 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
const BASE = process.env.BASE || 'http://localhost:4300'; const PRE = process.env.PRE || '';
const phone = { width: 390, height: 844 }, desk = { width: 1440, height: 900 };
const results = []; const errs = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!cond) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch();
  async function session(email, pw, vp, wait) {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2, isMobile: vp.width < 768, hasTouch: vp.width < 768 }); const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(`${email}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error' && !/401|403|favicon/.test(m.text())) errs.push(`${email}: ${m.text()}`); });
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE + '/'); await p.fill('#email', email); await p.fill('#pw', pw); await p.click('form button'); await p.waitForURL(/app|admin/).catch(() => {});
    await p.waitForSelector(wait, { timeout: 30000 }); await p.waitForTimeout(900); return p;
  }
  const snap = (p, f, full = false) => p.screenshot({ path: `screens/${PRE}${f}`, fullPage: full });
  const ADMIN = ['admin@ffd.demo', CREDS.ADMIN_PASSWORD];
  let a = await session(...ADMIN, desk, '.tile');
  if (!process.env.NORESET) { await a.evaluate(async () => { await api('POST', '/api/admin/demo/reset'); }); await a.context().close(); a = await session(...ADMIN, desk, '.tile'); }
  await a.waitForSelector('.tk-bar', { timeout: 10000 }).catch(() => {});
  const bar = await a.textContent('#tkBar');
  ok('Full view: banner "You have N tickets to approve today — John Doe is 30 days out"', /You have \d+ tickets to approve today — John Doe is 30 days out/.test(bar), bar.trim().slice(0, 120));
  const badge = await a.textContent('.side .tkN');
  ok('Full view: nav badge shows the count', +badge >= 5, badge);
  // report section (API + page) — before approvals
  const rep = await a.evaluate(async () => api('GET', '/api/admin/reports/daily'));
  ok('Daily report API has tickets_to_approve with count + names (incl. John Doe)', rep.tickets_to_approve && rep.tickets_to_approve.count === +badge && rep.tickets_to_approve.names.includes('John Doe') && rep.summary.tickets_to_approve === +badge);
  await a.goto(BASE + '/admin.html#/report'); await a.waitForSelector('#tkRep'); await a.waitForTimeout(700);
  ok('Report page shows the Tickets to approve section', (await a.textContent('#tkRep')).includes('John Doe'));
  await a.$eval('#tkRep', (e) => e.scrollIntoView({ block: 'center' })); await a.waitForTimeout(300); await snap(a, '80-report-tickets-section.png');
  // queue (full view)
  await a.goto(BASE + '/admin.html#/tickets'); await a.waitForSelector('.tk'); await a.waitForTimeout(800);
  const cards = await a.$$eval('.tk', (l) => l.map((c) => c.textContent));
  ok('Queue lists every pending proposal', cards.length === +badge, `${cards.length} cards`);
  ok('John Doe proposed at exactly 30 days out', cards.some((t) => t.includes('John Doe') && t.includes('30 days out')));
  ok('Long-haul proposals default to First class on the company preferred airline', cards.every((t) => /First/.test(t) && /Company preferred/.test(t)));
  ok('Proposals fly from the home or alternate airport', cards.every((t) => /\((home|alternate airport)\)/.test(t)));
  ok('Status reads "Waiting for approval"', cards.every((t) => t.includes('Waiting for approval')));
  await snap(a, '81-admin-tickets-full-view.png');
  // ---- phone: compact admin
  const m = await session(...ADMIN, phone, '.mcard');
  await m.waitForSelector('.tk-bar', { timeout: 10000 }).catch(() => {});
  ok('Compact view: banner + 🎫 badge in the top bar', /tickets? to approve today/.test(await m.textContent('#tkBar')) && +(await m.textContent('#mTk .tkN')) >= 1);
  await snap(m, '89-phone-admin-compact-banner.png');
  await m.click('#mTk'); await m.waitForSelector('.tk'); await m.waitForTimeout(800);
  ok('Compact view: queue works at 390px (no sideways scroll)', await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await snap(m, '90-phone-admin-tickets-compact.png');
  await m.check('#tkAll'); await m.waitForTimeout(300); await snap(m, '91-phone-admin-bulk-select.png');
  await m.context().close();
  // swap
  const megan = await a.$eval('.tk:nth-of-type(2)', (c) => c.dataset.tk);
  await a.click(`[data-swap="${megan}"]`); await a.waitForSelector('.tk-opt');
  const opt = await a.$$eval('.tk-opt', (l) => l.map((x) => [x.querySelector('input').value, x.textContent]).find((x) => /Emirates/.test(x[1]) && /First/.test(x[1])));
  await a.check(`.tk-opt input[value="${opt[0]}"]`); await snap(a, '82-admin-swap-flight.png'); await a.click('#swGo'); await a.waitForTimeout(900);
  ok('Swap to an alternate flight (Emirates First)', (await a.textContent(`[data-tk="${megan}"]`)).includes('Emirates'));
  // reject one
  const rej = await a.$eval('.tk:nth-of-type(3)', (c) => c.dataset.tk); const rejName = await a.$eval(`[data-tk="${rej}"] .tk-name`, (e) => e.textContent);
  await a.click(`[data-rej="${rej}"]`); await a.fill('#rjR', 'Booking via client travel desk'); await a.click('#rjGo'); await a.waitForTimeout(900);
  ok('Reject removes it from the queue', !(await a.$(`[data-tk="${rej}"]`)), rejName);
  // bulk confirm (select all; RED skipped)
  await a.check('#tkAll'); await a.waitForTimeout(300);
  ok('Select all enables "Confirm selected"', !(await a.isDisabled('#tkBulk')) && +(await a.textContent('#tkSelN')) >= 3);
  await snap(a, '83-admin-bulk-select.png');
  const pendBefore = await a.evaluate(async () => (await api('GET', '/api/admin/tickets')).tickets);
  const reds = pendBefore.filter((t) => t.readiness === 'red').map((t) => t.contractor.name);
  await a.click('#tkBulk'); const toastTxt = await a.textContent('.toast:has-text("confirmed")');
  ok('Bulk confirm: non-RED confirmed, RED skipped', /confirmed → booking/.test(toastTxt) && reds.every((n) => toastTxt.includes(n)), toastTxt);
  await a.waitForTimeout(400);
  const statusNow = await a.textContent('#tkList');
  ok('Shows "Confirmed by admin → Booking" right after confirming', statusNow.includes('Confirmed by admin → Booking'));
  await snap(a, '84-admin-confirmed-booking.png');
  await a.waitForTimeout(4500); await a.goto(BASE + '/admin.html#/tickets'); await a.click('[data-tab="done"]'); await a.waitForTimeout(900);
  const done = await a.evaluate(async () => (await api('GET', '/api/admin/tickets?status=done')).tickets);
  const mine = done.filter((t) => pendBefore.some((p) => p.id === t.id));
  ok('Then "Booked" with a record locator, flights and cabin', mine.length >= 3 && mine.every((t) => t.status === 'booked' && /^[A-Z0-9]{6}$/.test(t.confirmation) && t.fare.legs.length === 2 && t.fare.cabin_label));
  await snap(a, '85-admin-booked.png');
  // outbox email
  await a.goto(BASE + '/admin.html#/outbox'); await a.waitForTimeout(1200);
  const ob = await a.evaluate(async () => (await api('GET', '/api/admin/outbox')).messages.filter((m) => m.kind === 'itinerary'));
  const em = ob.find((m) => m.subject.includes(mine[0].confirmation));
  ok('Itinerary email in the Outbox (conf, flights, cabin, seat/check-in link, mock note)', !!em && /Pick your seat \/ Check in: https:\/\//.test(em.body) && em.body.includes('MOCK BOOKING') && em.body.includes(mine[0].fare.cabin_label) && em.body.includes('handle your own seat'));
  await snap(a, '86-admin-outbox-itinerary-email.png');
  // audit
  const au = await a.evaluate(async () => (await api('GET', '/api/admin/audit')).log.map((x) => x.action));
  ok('Audit log has confirm / booked / swap / reject entries', ['ticket_confirm', 'ticket_booked', 'ticket_swap', 'ticket_reject'].every((k) => au.includes(k)));
  // RED override, single
  const john = (await a.evaluate(async () => (await api('GET', '/api/admin/tickets')).tickets)).find((t) => t.contractor.name === 'John Doe');
  await a.goto(BASE + '/admin.html#/tickets'); await a.waitForSelector('[data-tab="pending"]'); await a.click('[data-tab="pending"]'); await a.waitForSelector(`[data-ok="${john.id}"]`); await a.click(`[data-ok="${john.id}"]`); await a.waitForTimeout(4500);
  const j2 = (await a.evaluate(async () => (await api('GET', '/api/admin/tickets?status=done')).tickets)).find((t) => t.id === john.id);
  ok('Single confirm of a RED traveler needs an explicit override (audited)', j2 && j2.red_override && j2.status === 'booked');
  // policy: preferred airline + cabin -> assistant
  await a.evaluate(async () => api('PUT', '/api/admin/travel/settings', { default_cabin: 'first', longhaul_hours: 6, preferred_airline: 'EK' }));
  await a.goto(BASE + '/admin.html#/assistant'); await a.waitForSelector('#ask'); await a.fill('#ask', 'Tyler Brandt needs to go to Africa'); await a.click('#askB'); await a.waitForTimeout(1500);
  const firstFare = await a.$eval('.bubble.bot:last-child .fare', (e) => e.textContent);
  ok('Assistant defaults to the preferred airline in First (Emirates after switching)', /Emirates/.test(firstFare) && /First/.test(firstFare) && /Company preferred/.test(firstFare), firstFare.replace(/\s+/g, ' ').slice(0, 90));
  await snap(a, '87-admin-assistant-first-preferred.png');
  await a.evaluate(async () => api('PUT', '/api/admin/travel/settings', { default_cabin: 'first', longhaul_hours: 6, preferred_airline: 'QR' }));
  await a.goto(BASE + '/admin.html#/tickets'); await a.waitForSelector('#tkSet'); await a.click('#tkSet summary'); await a.waitForTimeout(300);
  const setTxt = await a.textContent('#tkSet');
  ok('Settings show cabin, preferred airline list, payment-outside-app + mock booking notes', /Company preferred airline/.test(setTxt) && /never stores card/.test(setTxt) && /travel management company/.test(setTxt));
  await a.$eval('#tkSet', (e) => e.scrollIntoView()); await snap(a, '88-admin-travel-policy-settings.png');
  // access control
  const sec = await a.evaluate(async () => { const r = await fetch('/api/admin/tickets/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ids":[1]}' }); return r.status; });
  ok('Confirm without CSRF token is refused', sec === 403, String(sec));
  // ---- contractor phone: notification + itinerary on My Schedule
  const who = mine.find((t) => t.readiness === 'green') || mine[0];
  const em2 = await a.evaluate(async (id) => (await api('GET', `/api/admin/contractors/${id}`)).account_email, who.contractor.id);
  const c = await session(em2, CREDS.CONTRACTOR_PASSWORD, phone, '.verdict');
  const st = await c.textContent('#view');
  ok('Contractor sees the in-app notification + trip teaser', st.includes('Itinerary booked') && st.includes(who.confirmation));
  await snap(c, '92-phone-contractor-itinerary-notification.png');
  await c.click('#itinGo'); await c.waitForSelector('#itin'); await c.waitForTimeout(600);
  const it = await c.textContent('#itin'); const href = await c.getAttribute('#itin a.btn', 'href');
  ok('My Schedule shows the itinerary (conf, flights, cabin) + real airline seat/check-in link', it.includes(who.confirmation) && it.includes(who.fare.legs[0].flight_no) && it.includes(who.fare.cabin_label) && /^https:\/\/www\.[a-z]+/.test(href) && /seat/.test(it), href);
  await snap(c, '93-phone-contractor-my-schedule-itinerary.png');
  const forb = await c.evaluate(async () => (await fetch('/api/admin/tickets')).status);
  ok('Contractor cannot open admin ticket routes', forb === 403 || forb === 401, String(forb));
  await c.context().close();
  if (!process.env.NORESET) await a.evaluate(async () => { await api('POST', '/api/admin/demo/reset'); });
  await b.close();
  console.log(results.join('\n')); console.log(errs.length ? 'JS errors:\n' + errs.join('\n') : 'No JS errors');
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
})().catch((e) => { console.error(e); process.exit(1); });

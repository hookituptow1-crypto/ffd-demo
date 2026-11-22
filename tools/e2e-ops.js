// Click-through of the ops features: daily report, crew schedule, titles, headshot + ID badge, My Schedule. Run: BASE=... node tools/e2e-ops.js
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const CREDS = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', 'private', 'creds.env'), 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
const BASE = process.env.BASE || 'http://localhost:4300'; const PRE = process.env.PRE || '';
const PW = CREDS.CONTRACTOR_PASSWORD, ADMIN = ['admin@ffd.demo', CREDS.ADMIN_PASSWORD];
const phone = { width: 390, height: 844 }, desk = { width: 1440, height: 900 };
const results = []; const errs = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!cond) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch();
  // neutral generated test headshot (silhouette, not a real person)
  const HS = path.join(__dirname, 'demo-headshot.png');
  if (!fs.existsSync(HS)) { const pg = await b.newPage({ viewport: { width: 600, height: 800 } }); await pg.setContent('<body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#cfd6c4"/><circle cx="300" cy="300" r="140" fill="#6b7a55"/><path d="M60 800c20-200 120-300 240-300s220 100 240 300z" fill="#6b7a55"/></svg></body>'); await pg.screenshot({ path: HS }); await pg.close(); }
  async function session(email, pw, vp) {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2, acceptDownloads: true }); const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(`${email}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error' && !/401|favicon/.test(m.text())) errs.push(`${email}: ${m.text()}`); });
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE + '/'); await p.fill('#email', email); await p.fill('#pw', pw); await p.click('form button'); await p.waitForURL(/app|admin/).catch(() => {}); await p.waitForSelector('.verdict, .tile', { timeout: 30000 });
    await p.waitForTimeout(800); return p;
  }
  const snap = (p, f, full = false) => p.screenshot({ path: `screens/${PRE}${f}`, fullPage: full });
  let a = await session(...ADMIN, desk);
  if (!process.env.NORESET) { await a.evaluate(async () => { await api('POST', '/api/admin/demo/reset'); }); await a.context().close(); a = await session(...ADMIN, desk); }

  // ---- Board: titles + avatars + title filter
  ok('Board shows titles', (await a.textContent('#rows')).includes('Crew Chief'));
  ok('Board shows headshot thumbnails', (await a.$$('#rows img.av')).length === 13);
  const photos = await a.evaluate(async () => { const l = (await api('GET', '/api/admin/contractors')).contractors; const out = [];
    for (const c of l) { const r = await fetch(`/api/headshot/${c.id}?approved=1`); out.push([c.name, r.headers.get('content-type'), c.headshot_status]); } return out; });
  ok('Every demo person has an approved JPEG headshot', photos.every((x) => x[1] === 'image/jpeg' && x[2] === 'approved'), photos.filter((x) => x[1] !== 'image/jpeg').map((x) => x[0]).join(', '));
  await a.click('#rows tr:has-text("David Tran")'); await a.waitForSelector('.pcard'); await a.waitForTimeout(1200);
  const pc = await a.textContent('.pcard');
  ok('Board click opens profile with photo at top (David)', (await a.$eval('.pphoto', (i) => i.naturalWidth)) >= 256 && pc.includes('Lead') && pc.includes('RT-1013') && pc.includes('SEA'));
  const dv = await a.evaluate(async () => { const l = (await api('GET', '/api/admin/contractors')).contractors; const id = l.find((c) => c.name === 'David Tran').id; return api('GET', `/api/admin/contractors/${id}`); });
  const P = dv.profile; const full = dv.readiness.status === 'green' && P.passport.number && P.visas.length && P.gov_id.number && P.immunizations.length && P.physical.last_exam && P.description.height_ft && P.emergency_contacts.length === 2 && P.personal.phone && P.personal.address.line1 && dv.flights.length >= 5 && dv.schedule.length >= 3 && dv.readiness.items.some((i) => i.is_check && i.status === 'green');
  ok('David is green and fully complete (docs, background check, description, contacts, flights, schedule)', !!full);
  await a.evaluate(() => window.scrollTo(0, 0)); await a.waitForTimeout(300); await snap(a, '29-admin-profile-david.png');
  await a.goto(BASE + '/admin.html#/'); await a.waitForSelector('#rows tr'); await a.waitForTimeout(600);
  await a.evaluate(() => window.scrollTo(0, 0)); await a.waitForTimeout(300); await snap(a, '28-admin-board-photos.png');
  await a.selectOption('#titleF', { label: 'A&P Mechanic' }); await a.waitForTimeout(300);
  ok('Title filter narrows board to A&P Mechanics (2)', (await a.$$('#rows tr[data-id]')).length === 2);
  await a.selectOption('#titleF', ''); await snap(a, '30-admin-board-titles.png');

  // ---- Daily report
  await a.goto(BASE + '/admin.html#/report'); await a.waitForSelector('.rtiles'); await a.waitForTimeout(800);
  const rt = await a.textContent('#main');
  ok('Report: today group has Brianna outbound + Luis return', /Today —[\s\S]*Brianna Holt[\s\S]*Luis Fontaine[\s\S]*Tomorrow/.test(rt));
  ok('Report: flag no flight (Wes)', rt.includes('No flight booked for scheduled rotation change'));
  ok('Report: flag RED traveling (Sam)', rt.includes('RED status traveling'));
  ok('Report: flag YELLOW traveling', rt.includes('YELLOW status traveling'));
  ok('Report: flag changed in last 24h (Marcus QR 450)', rt.includes('Flight change pushed in last 24h (QR 450)'));
  ok('Report: legs with PNR, seat and connections', rt.includes('PNR TKDEMO4') && rt.includes('via ATL, IST') && rt.includes('seat 27H'));
  const tiles = await a.$$eval('.rtiles .n', (e) => e.map((x) => +x.textContent));
  ok('Report summary counts', tiles[0] === 5 && tiles[1] === 2 && tiles[2] === 6, tiles.join(','));
  await snap(a, '31-admin-report.png', true);
  await a.click('.ec-btn'); await a.waitForSelector('.modal'); ok('EC quick view opens', (await a.textContent('.modal')).includes('📱')); await snap(a, '32-admin-report-ec.png'); await a.click('.modal [data-close]');
  const [dl] = await Promise.all([a.waitForEvent('download'), a.click('#rCsv')]); const csv = fs.readFileSync(await dl.path(), 'utf8');
  ok('CSV export downloads with rows', csv.split('\n').length >= 8 && csv.includes('Brianna Holt') && csv.includes('NO FLIGHT BOOKED'));
  await a.emulateMedia({ media: 'print' }); await snap(a, '33-admin-report-print.png', true); await a.emulateMedia({ media: 'screen' });
  await a.pdf?.({ path: `screens/${PRE}33-admin-report.pdf`, landscape: true, printBackground: false }).catch(() => {});
  // single-day picker
  const tmr = await a.evaluate(() => isoAdd(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date()), 2));
  await a.fill('#rDate', tmr); await a.dispatchEvent('#rDate', 'change'); await a.waitForTimeout(900);
  ok('Date picker shows a single day (Dana return)', (await a.textContent('#main')).includes('Dana Whitfield') && !(await a.textContent('#main')).includes('Brianna Holt'));
  // JSON endpoint admin-only
  const anon = await (await fetch(`${BASE}/api/admin/reports/daily`)).status; ok('Report JSON requires auth (anon 401)', anon === 401);

  // ---- Schedule
  await a.goto(BASE + '/admin.html#/schedule'); await a.waitForSelector('.gantt'); await a.waitForTimeout(800);
  ok('Schedule: one row per contractor', (await a.$$('.g-row[data-c]')).length === 13);
  ok('Schedule: titles on rows', (await a.textContent('.g-names')).includes('Site Manager'));
  ok('Schedule: training + leave blocks', (await a.$$('.g-blk.k-training')).length >= 3 && (await a.$$('.g-blk.k-leave')).length >= 1);
  ok('Schedule: coverage gap at Arifjan', (await a.textContent('#main')).match(/GAP\s*Camp Arifjan/) !== null);
  ok('Schedule: overstaffing at Erbil', (await a.textContent('#main')).match(/OVER\s*Erbil/) !== null);
  ok('Schedule: conflict Sam (RED overlaps rotation)', /Sam Kowalski[\s\S]{0,80}RED readiness overlaps/.test(await a.textContent('#main')));
  ok('Schedule: conflict blocks outlined', (await a.$$('.g-blk.conflict')).length >= 3);
  await snap(a, '34-admin-schedule.png', true);
  // drag Wes's ON block +3 days
  const wesRow = await a.$('.g-row[data-c] >> nth=11'); // alphabetical: Wes last
  const blk = await a.$$eval('.g-row[data-c]', (rows) => { const r = rows[rows.length - 1]; const b = [...r.querySelectorAll('.g-blk.k-on')].find((x) => x.title.includes('2026-11') || x.title.includes('→')); const bb = b.getBoundingClientRect(); return { x: bb.x + 20, y: bb.y + 15, id: b.dataset.b, t: b.title }; });
  await a.mouse.move(blk.x, blk.y); await a.mouse.down(); await a.mouse.move(blk.x + 25, blk.y, { steps: 5 }); await a.mouse.move(blk.x + 48, blk.y, { steps: 5 }); await a.mouse.up();
  await a.waitForTimeout(1500);
  const after = await a.evaluate(async (id) => { const d = await api('GET', '/api/admin/schedule'); return d.contractors.flatMap((c) => c.blocks).find((b) => b.id === +id); }, blk.id);
  ok('Drag moves a rotation (+3 days)', after && blk.t.includes(after.start) === false, `${blk.t} -> ${after && after.start}`);
  const aud = await a.evaluate(async () => (await api('GET', '/api/admin/audit')).log.slice(0, 5).map((l) => l.action).join(','));
  ok('Schedule change audit-logged', aud.includes('schedule_update'));
  // create a training block via click
  await a.evaluate(() => window.scrollTo(0, 0));
  // pattern modal
  await a.click('[data-gen] >> nth=0'); await a.waitForSelector('#gOn'); await snap(a, '35-admin-schedule-pattern.png'); await a.click('.modal [data-close]');
  wesRow;

  // ---- Titles settings
  await a.goto(BASE + '/admin.html#/titles'); await a.waitForSelector('#tNew');
  const TN = `QA Test ${Date.now() % 100000}`;
  await a.fill('#tNew', `${TN} (tmp)`); await a.click('#tAdd'); await a.waitForTimeout(600);
  ok('Add title', (await a.$$eval('.tname', (e) => e.map((x) => x.value))).includes(`${TN} (tmp)`));
  const lastRow = (await a.$$('tr[data-t]')).length - 1;
  await a.click(`[data-up="${lastRow}"]`); await a.waitForTimeout(600);
  ok('Reorder title', (await a.$$eval('.tname', (e) => e.map((x) => x.value)))[lastRow - 1] === `${TN} (tmp)`);
  const row = await a.$(`tr:has(input[value="${TN} (tmp)"])`); await (await row.$('.tname')).fill(TN); await (await row.$('[data-ren]')).click(); await a.waitForTimeout(600);
  ok('Rename title', (await a.$$eval('.tname', (e) => e.map((x) => x.value))).includes(TN));
  await (await (await a.$(`tr:has(input[value="${TN}"])`)).$('[data-act]')).click(); await a.waitForTimeout(600);
  ok('Deactivate title', (await (await a.$(`tr:has(input[value="${TN}"])`)).textContent()).includes('Inactive'));
  await snap(a, '36-admin-titles.png', true);

  // ---- Contractor: headshot, title, badge, My Schedule
  let p = await session('cody@ffd.demo', PW, phone);
  await p.waitForTimeout(1200); await snap(p, '37-phone-badge-home.png', true);
  ok('Phone home shows ID badge canvas', !!(await p.$('#bcv')));
  await p.click('[data-tab="profile"]'); await p.waitForSelector('#myTitle');
  ok('Intake title dropdown excludes inactive title', !(await p.textContent('#myTitle')).includes(TN));
  await p.selectOption('#myTitle', { label: 'Crew Chief' });
  await p.click('#hsBtn2'); await p.waitForSelector('#hsUp', { state: 'attached' });
  ok('Camera capture input uses capture=user', (await p.getAttribute('#hsCam', 'capture')) === 'user');
  await p.setInputFiles('#hsUp', HS); await p.waitForSelector('#hsCrop:not(.hidden)'); await p.fill('#hsZoom', '1.3'); await p.dispatchEvent('#hsZoom', 'input');
  await snap(p, '38-phone-headshot-crop.png'); await p.click('#hsUse'); await p.waitForTimeout(1200);
  await p.waitForTimeout(800); await p.click('[data-tab="profile"]'); await p.waitForTimeout(1200); await p.selectOption('#myTitle', { label: 'Crew Chief' });
  await p.click('#save'); await p.waitForTimeout(1200);
  const bd = await p.evaluate(async () => api('GET', '/api/my/badge'));
  ok('Headshot pending approval after upload', bd.headshot_status === 'pending'); ok('Contractor changed own title', bd.title === 'Crew Chief');
  const bad = await p.evaluate(async () => { try { await api('POST', '/api/my/headshot', { data: 'data:image/jpeg;base64,' + btoa('not a jpeg') }); return 'accepted'; } catch (e) { return e.message; } });
  ok('Server rejects a non-JPEG headshot', /JPEG/.test(bad), bad);
  const other = await p.evaluate(async () => (await fetch('/api/headshot/1')).status); ok('Contractor cannot read another headshot (IDOR)', other === 404);
  await p.click('[data-tab="schedule"]'); await p.waitForSelector('.sched'); await p.waitForTimeout(400);
  const st = await p.textContent('#view'); ok('My Schedule shows rotation + linked flights', st.includes('ON rotation') && st.includes('TK 32'));
  await snap(p, '39-phone-my-schedule.png', true);
  const ics = await p.evaluate(async () => (await fetch('/api/my/schedule.ics')).text()); ok('.ics download is a calendar with events + flights', ics.startsWith('BEGIN:VCALENDAR') && ics.includes('SUMMARY:ON rotation') && ics.includes('TK 1092'));
  await p.context().close();

  // admin approves
  await a.goto(BASE + '/admin.html#/'); await a.waitForSelector('#rows tr'); await a.waitForTimeout(500);
  ok('Board flags photo to approve', (await a.textContent('#rows')).includes('photo to approve'));
  const cody = await a.evaluate(async () => (await api('GET', '/api/admin/contractors')).contractors.find((c) => c.name === 'Cody Ramirez').id);
  await a.goto(BASE + `/admin.html#/c/${cody}/badge`); await a.waitForSelector('#hsOk'); await a.waitForTimeout(800); await snap(a, '40-admin-badge-pending.png');
  await a.click('#hsOk'); await a.waitForTimeout(1500); await a.waitForSelector('#bcv');
  ok('Admin approved headshot', (await a.textContent('#sub')).includes('Approved'));
  ok('Detail shows title', (await a.textContent('.head')).includes('Crew Chief'));
  const [png] = await Promise.all([a.waitForEvent('download'), a.click('#bPng')]); ok('Badge PNG download', (await png.suggestedFilename()).endsWith('.png'));
  const [pdf] = await Promise.all([a.waitForEvent('download'), a.click('#bPdf')]); const pbuf = fs.readFileSync(await pdf.path());
  ok('Badge PDF download is a PDF', pbuf.slice(0, 5).toString() === '%PDF-'); fs.copyFileSync(await pdf.path(), `screens/${PRE}41-badge-cody.pdf`);
  await snap(a, '41-admin-badge-approved.png');
  await a.locator('#bcv').screenshot({ path: `screens/${PRE}42-badge-cody.png` });
  p = await session('sam@ffd.demo', PW, phone); await p.waitForTimeout(1200); await p.locator('#badgeCard').screenshot({ path: `screens/${PRE}43-badge-red-sam.png` }); await p.context().close();
  p = await session('cody@ffd.demo', PW, phone); await p.waitForTimeout(1200); await p.locator('#badgeCard').screenshot({ path: `screens/${PRE}44-badge-cody-phone.png` });
  const alerts = await p.evaluate(async () => (await api('GET', '/api/my/status')).alerts.map((x) => x.title).join(' | ')); ok('Contractor got headshot-approved alert', alerts.includes('Headshot approved'));
  await p.context().close();
  // schedule alert to Wes after drag
  p = await session('wes@ffd.demo', PW, phone); const wa = await p.evaluate(async () => (await api('GET', '/api/my/status')).alerts.map((x) => x.title).join(' | ')); ok('Wes alerted about the schedule move', wa.includes('Schedule update')); await p.context().close();

  // remove the temporary title (titles survive resets)
  await a.goto(BASE + '/admin.html#/titles'); await a.waitForSelector('#tNew'); await (await (await a.$(`tr:has(input[value="${TN}"])`)).$('[data-del]')).click(); await a.waitForTimeout(600);
  ok('Delete unused title', !(await a.$$eval('.tname', (e) => e.map((x) => x.value))).includes(TN));
  // clean up test title edits? keep Quality Lead inactive is fine; reset demo data to restore clean state
  if (!process.env.NORESET) await a.evaluate(async () => { await api('POST', '/api/admin/demo/reset'); });
  await b.close();
  console.log(results.join('\n')); console.log(errs.length ? `\nConsole errors:\n${errs.join('\n')}` : '\nNo console errors');
})();

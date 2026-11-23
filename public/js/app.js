'use strict';
let S = null; let tab = 'status'; let T = null; let autoTimer = null;
const VERDICT = {
  green: ['✓', 'CLEARED TO DEPLOY', 'All requirements are good through your next rotation.'],
  yellow: ['!', 'CLEARED THIS ROTATION', 'You can deploy this time — but something must be fixed before your next rotation or you can’t go.'],
  red: ['✕', 'NO-GO — DO NOT TRAVEL', 'Something is blocking deployment. Fix the items below and contact the deployment office.'],
};
const CAT_IC = { passport: '🛂', visa: '📄', immunization: '💉', id: '🪪', clearance: '🩺', other: '📌' };

async function load() { [S, T] = await Promise.all([api('GET', '/api/my/status'), api('GET', '/api/my/tracking')]); badges(); render(); startAuto(); }
// ---- deployed check-in & location (opt-in, foreground only: a web app can't share location in the background) ----
function getPos() {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }), () => res(null), { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });
}
function startAuto() {
  clearInterval(autoTimer);
  if (!(T && T.enabled && T.deployed && T.consent)) return;
  autoTimer = setInterval(async () => { if (document.visibilityState !== 'visible') return; const pos = await getPos(); if (pos) api('POST', '/api/my/checkin', { ...pos, kind: 'auto' }).catch(() => {}); }, T.auto_minutes * 60000);
}
function trackingCard() {
  if (!T || !T.enabled || !T.deployed) return '';
  const ago = T.last_checkin ? Math.round((Date.now() - Date.parse(T.last_checkin.replace(' ', 'T') + 'Z')) / 60000) : null;
  const agoTxt = ago === null ? 'never' : ago < 60 ? `${ago} min ago` : `${Math.round(ago / 6) / 10} h ago`;
  return `<div class="card mt" id="trk"><div class="row"><h2>📍 Deployed check-in</h2><label class="switch right"><input type="checkbox" id="trkC" ${T.consent ? 'checked' : ''}><span></span></label></div>
    <p class="small mut">${T.consent ? `Location sharing is <b>on</b> while you're deployed. Last check-in: <b>${agoTxt}</b>. While the app is open it also shares every ${T.auto_minutes} min.` : 'Opt in to share your location with the deployment office while you are deployed.'}</p>
    <div class="row mt"><button class="btn pri grow" id="trkIn" ${T.consent ? '' : 'disabled'}>✅ Check in now</button><button class="btn danger grow" id="sos">🆘 SOS</button></div></div>`;
}
function consentModal(done) {
  modal(`<div class="row"><h2>📍 Location sharing</h2><button class="btn sm right" data-close>✕</button></div>
    <p>While you are <b>deployed</b>, the deployment office can see your location when you check in, and every ${T.auto_minutes} minutes while this app is open.</p>
    <ul class="small"><li>Only active during your rotation. Off when you're home.</li><li>Only the deployment office admin can see it. Every view is logged.</li>
    <li>Locations are encrypted and deleted after ${T.retention_days} days.</li><li>It does <b>not</b> track you in the background when the app is closed.</li><li>You can turn it off at any time. SOS works either way.</li></ul>
    <div class="row mt"><button class="btn grow" data-close>Not now</button><button class="btn pri grow" id="cYes">I agree, turn on</button></div>`, (m, close) => {
    $('#cYes', m).addEventListener('click', () => guard(async () => { await api('PUT', '/api/my/tracking/consent', { consent: true }); close(); toast('Location sharing on'); done(); }));
  });
}
function badges() {
  const set = (id, n) => { const b = $(id); b.textContent = n; b.classList.toggle('hidden', !n); };
  set('#bellN', S.unread_alerts); set('#alN', S.unread_alerts); set('#flN', S.new_flights);
}
let HS_V = Date.now();
async function uploadHeadshot(data) { await api('POST', '/api/my/headshot', { data }); HS_V = Date.now(); toast('📸 Headshot sent — waiting for office approval'); render(); }
// Approved itinerary (from the office's ticket approval queue). Seat + check-in are done by the traveler on the airline's site.
function itinCard(it, id = '') {
  return `<div class="card itin ${it.status}" ${id ? `id="${id}"` : ''}><div class="row"><b class="grow">✈️ Your itinerary — ${esc(it.destination)}</b><span class="pill ${it.status === 'booked' ? 'green' : 'blue'}">${esc(it.status_label)}</span></div>
    <div class="small mut">Demo · mock booking — no real ticket issued</div>
    <div class="itin-conf"><span class="small mut">Confirmation</span><b class="mono">${esc(it.confirmation || 'booking…')}</b><span class="pill gold">${esc(it.cabin)}</span></div>
    ${it.legs.map((l) => `<div class="itin-leg"><b>${esc(l.flight_no)}</b> ${esc(l.from)} → ${esc(l.to)}<div class="small">${fdt(l.depart_at)} → ${fdt(l.arrive_at)} <span class="mut">local</span></div></div>`).join('')}
    ${it.manage_url ? `<a class="btn pri block mt" href="${esc(it.manage_url)}" target="_blank" rel="noopener noreferrer">💺 Pick your seat / Check in</a>` : ''}
    <p class="small mt">You choose your own seat and get your boarding pass from ${esc(it.airline)} — use confirmation <b>${esc(it.confirmation || '')}</b> and your last name.</p></div>`;
}
async function renderSchedule() {
  const d = await api('GET', '/api/my/schedule'); const KL = { on: 'ON rotation', off: 'OFF — home', travel: 'Travel day', training: 'Training', leave: 'Leave' }; const IC = { on: '🛠️', off: '🏠', travel: '✈️', training: '🎓', leave: '🌴' };
  const fl = Object.fromEntries(d.flights.map((f) => [f.id, f]));
  const fh = (ids) => ids.map((id) => fl[id]).map((f) => `<div class="small">✈️ <b>${esc(f.airline)} ${esc(f.flight_no)}</b> ${esc(f.from_airport)} → ${esc(f.to_airport)} · ${fdt(f.depart_at)} · Conf ${esc(f.confirmation || '—')}</div>`).join('');
  const up = d.blocks.filter((b) => b.end >= d.today);
  $('#view').innerHTML = `<div class="section"><div class="row"><h2>🗓️ My schedule</h2><a class="btn sm right" href="/api/my/schedule.ics" download>📅 Add to calendar (.ics)</a></div>
    ${(d.itineraries || []).map((it, i) => itinCard(it, i ? '' : 'itin')).join('')}
    <p class="small mut">Pattern ${d.pattern.on} on / ${d.pattern.off} off. Changes from the office show up here and in your alerts.</p>
    ${up.map((b) => `<div class="card mt sched ${b.kind}"><div class="row"><span>${IC[b.kind]}</span><b>${KL[b.kind]}</b>${b.start <= d.today ? '<span class="pill green">Now</span>' : ''}<span class="right small mut">${Math.round((Date.parse(b.end) - Date.parse(b.start)) / 86400000) + 1} days</span></div>
      <div class="val mt">${fdate(b.start)} → ${fdate(b.end)}</div>${b.site ? `<div class="small mut">📍 ${esc(b.site)}</div>` : ''}${b.notes ? `<div class="small">${esc(b.notes)}</div>` : ''}
      ${b.kind === 'on' ? `<div class="mt"><div class="small"><b>Travel out:</b> ${fdate(b.travel_out)}</div>${fh(b.flights_out) || '<div class="small mut">No flights booked yet</div>'}
        <div class="small mt"><b>Travel home:</b> ${fdate(b.travel_home)}</div>${fh(b.flights_home) || '<div class="small mut">No flights booked yet</div>'}</div>` : ''}</div>`).join('') || '<p class="mut">Nothing scheduled yet.</p>'}</div>`;
}
function render() {
  $$('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  ({ status: renderStatus, flights: renderFlights, alerts: renderAlerts, profile: renderProfile, schedule: renderSchedule })[tab]();
  window.scrollTo(0, 0);
}
function renderStatus() {
  const r = S.readiness; const [ic, verdict, sub] = VERDICT[r.status];
  const latest = S.alerts.find((a) => !a.read_at);
  const issues = r.items.filter((i) => i.status !== 'green');
  const dtd = r.rotation.days_to_deploy;
  $('#view').innerHTML = `<div class="section">
    ${latest ? `<div class="alert-banner ${latest.kind === 'urgent' ? 'urgent' : ''}" id="banner"><span>${latest.kind === 'flight' ? '✈️' : latest.kind === 'urgent' ? '🚨' : '📣'}</span><div class="grow"><b>${esc(latest.title)}</b><div class="small mut">${esc(latest.body)}</div></div><span class="pill blue">New</span></div>` : ''}
    ${(S.itineraries || []).length ? (() => { const it = S.itineraries[0]; return `<button class="itin-teaser" id="itinGo"><span>🎫</span><span class="grow"><b>Your trip to ${esc(it.destination.split(',')[0])} is ${it.status === 'booked' ? 'booked' : 'being booked'}</b><span class="small">${esc(it.cabin)} · ${esc(it.legs.map((l) => l.flight_no).join(' + ') || it.airline)} · ${fdate(it.depart_date)}${it.confirmation ? ` · Conf ${esc(it.confirmation)}` : ''}</span></span><span class="small">My Schedule ›</span></button>`; })() : ''}
    <div class="hello mb">Welcome back<b>${esc(S.contractor.name)}</b></div>
    <div class="light ${r.status}" id="light">
      <div class="orb">${ic}</div>
      <div class="verdict">${verdict}</div>
      <div class="sub">${esc(sub)}</div>
      ${r.overridden ? `<div class="sub mt"><b>Note from deployment office:</b> ${esc(r.override_reason)}</div>` : ''}
      ${r.blockers.map((b) => `<div class="sub mt">⛔ ${esc(b.description)}</div>`).join('')}
      ${r.status === 'yellow' && r.fix_by ? `<div class="countdown"><div class="num">${Math.max(0, r.days_left)}<small>DAYS LEFT</small></div><div><b>Fix by ${fdate(r.fix_by)}</b><div class="small mut">${issues.filter((i) => i.status === 'yellow').map((i) => esc(i.name)).join(', ')} must be renewed before your ${fdate(r.rotation.next_start)} rotation.</div></div></div>` : ''}
    </div>
    <div class="rot mt">
      <div class="card"><div class="lbl">${dtd > 0 ? `Deploys in ${dtd} days` : dtd > -r.rotation.on ? 'On rotation now' : 'This rotation'}</div><div class="val">${fdate(r.rotation.start)}</div><div class="small mut">Home ${fdate(r.rotation.end)}</div></div>
      <div class="card"><div class="lbl">Next rotation</div><div class="val">${fdate(r.rotation.next_start)}</div><div class="small mut">${r.rotation.on} on / ${r.rotation.off} off</div></div>
    </div>
    <div class="card mt" id="badgeCard"><div class="row"><h2>🪪 My ID badge</h2><button class="btn sm right" id="hsBtn">📸 Headshot</button></div>
      <canvas id="bcv" class="badge-cv mt"></canvas><div class="row mt" data-style="justify-content:center"><button class="btn sm" id="bPng">⬇️ PNG</button><button class="btn sm" id="bPdf">⬇️ PDF</button><button class="btn sm" data-go="schedule">🗓️ My schedule</button></div>
      <p class="small mut center" id="bNote"></p></div>
    ${trackingCard()}
    <div class="card mt"><div class="row"><h2>Requirements</h2><span class="right small mut">📍 ${esc(S.contractor.destination)}</span></div>
      <div class="mt">${r.items.map((i) => `<div class="req ${i.status}"><span class="dot ${i.status}"></span><div class="grow">
        <div class="name">${CAT_IC[i.category] || ''} ${esc(i.name)}</div><div class="msg">${esc(i.message)}</div>
        ${i.status !== 'green' && i.instructions ? `<div class="small mt">${esc(i.instructions)}</div>` : ''}
        ${i.document && i.document.expires ? `<div class="small mut">Expires ${fdate(i.document.expires)}</div>` : ''}</div>
        <button class="btn sm ${i.status === 'green' ? '' : 'pri'}" data-fix="${i.requirement_type_id}">${i.status === 'green' ? 'Update' : 'Fix now'}</button></div>`).join('')}</div></div>
    ${S.flights.length ? `<div class="card mt" id="nextFlight"><div class="row"><h3>✈️ Next flight</h3>${S.new_flights ? '<span class="pill blue">New</span>' : ''}<button class="btn sm right" data-go="flights">All flights</button></div>
      ${(() => { const f = S.flights.find((x) => x.depart_at.slice(0, 10) >= new Date().toISOString().slice(0, 10)) || S.flights[0]; return `<div class="flight mt"><div class="small mut">${esc(f.airline)} · ${esc(f.flight_no)}</div><div class="route">${esc(f.from_airport)}<span class="line"></span>${esc(f.to_airport)}</div><div class="small">${fdt(f.depart_at)} · Conf <b>${esc(f.confirmation)}</b></div></div>`; })()}</div>` : ''}
  </div>`;
  $('#banner')?.addEventListener('click', () => go(/^✈️ Itinerary/.test(latest.title) ? 'schedule' : 'alerts'));
  $('#itinGo')?.addEventListener('click', () => go('schedule'));
  api('GET', '/api/my/badge').then(async (b) => {
    if (!$('#bcv')) return; b.v = HS_V; await drawBadge($('#bcv'), b);
    $('#bNote').textContent = b.headshot_status === 'pending' ? 'Your new photo is waiting for office approval.' : b.headshot_status === 'rejected' ? `Photo needs a retake${b.headshot_note ? `: ${b.headshot_note}` : ''}.` : b.headshot_status === 'placeholder' ? 'Add a headshot so your badge shows your photo.' : '';
    $('#bPng').onclick = () => badgePng($('#bcv'), b); $('#bPdf').onclick = () => badgePdf($('#bcv'), b);
  }).catch(() => {});
  $('#hsBtn').addEventListener('click', () => headshotPicker(uploadHeadshot));
  $('#trkC')?.addEventListener('change', (e) => { if (e.target.checked) { e.target.checked = false; consentModal(load); } else guard(async () => { await api('PUT', '/api/my/tracking/consent', { consent: false }); toast('Location sharing off'); load(); }); });
  $('#trkIn')?.addEventListener('click', () => guard(async () => { const pos = await getPos(); await api('POST', '/api/my/checkin', { ...(pos || {}), kind: 'checkin' }); toast(pos ? '✅ Checked in with location' : '✅ Checked in (location unavailable)'); load(); }));
  $('#sos')?.addEventListener('click', () => modal(`<h2>🆘 Send SOS?</h2><p>This immediately alerts the deployment office with your location.</p><label for="sosM">Message (optional)</label><input id="sosM" placeholder="What's happening?">
    <div class="row mt"><button class="btn grow" data-close>Cancel</button><button class="btn danger grow" id="sosGo">Send SOS</button></div>`, (m, close) => {
    $('#sosGo', m).addEventListener('click', () => guard(async () => { const pos = await getPos(); await api('POST', '/api/my/sos', { ...(pos || {}), message: $('#sosM', m).value }); close(); toast('🆘 SOS sent — the office has been alerted'); }));
  }));
}
function renderFlights() {
  const groups = {};
  S.flights.forEach((f) => (groups[f.confirmation || f.id] = groups[f.confirmation || f.id] || []).push(f));
  $('#view').innerHTML = `<div class="section"><h2 class="mb">My flights</h2>
    ${S.flights.length ? Object.entries(groups).map(([conf, fs]) => `<div class="mb"><div class="row mb"><span class="small mut">Confirmation</span><b>${esc(conf)}</b></div>
      ${fs.map((f) => `<div class="flight ${f.seen_at ? '' : 'new'}">
        <div class="row"><div class="small mut">${esc(f.airline)} · <b>${esc(f.flight_no)}</b></div>${f.updated_at ? '<span class="pill yellow">Changed</span>' : ''}${f.seen_at ? '' : '<span class="pill blue right">New</span>'}</div>
        <div class="route">${esc(f.from_airport)}<span class="line"></span>✈<span class="line"></span>${esc(f.to_airport)}</div>
        <dl class="kv"><dt>Departs</dt><dd>${fdt(f.depart_at)}</dd>${f.arrive_at ? `<dt>Arrives</dt><dd>${fdt(f.arrive_at)}</dd>` : ''}${f.seat ? `<dt>Seat</dt><dd>${esc(f.seat)}</dd>` : ''}</dl>
        ${f.notes ? `<div class="small mt">📝 ${esc(f.notes)}</div>` : ''}</div>`).join('')}</div>`).join('')
      : '<div class="card center mut">No flights booked yet. You’ll get an alert as soon as the deployment office books your travel.</div>'}</div>`;
  if (S.new_flights) api('POST', '/api/my/flights/seen').then(() => { S.new_flights = 0; S.flights.forEach((f) => (f.seen_at = f.seen_at || 'now')); badges(); });
}
function renderAlerts() {
  const pushOk = 'PushManager' in window && 'serviceWorker' in navigator;
  $('#view').innerHTML = `<div class="section"><div class="row mb"><h2>Alerts</h2>
    ${pushOk ? `<button class="btn sm right" id="push">${Notification.permission === 'granted' ? '🔔 Push on' : 'Enable push alerts'}</button>` : ''}</div>
    ${!pushOk ? '<p class="small mut">Tip: on iPhone, tap Share → Add to Home Screen to get push alerts.</p>' : ''}
    <div class="card">${S.alerts.length ? S.alerts.map((a) => `<div class="alert-item ${a.read_at ? '' : 'unread'}"><div class="t">${a.kind === 'flight' ? '✈️' : a.kind === 'urgent' ? '🚨' : a.kind === 'readiness' ? '🚦' : '📣'} ${esc(a.title)}${a.read_at ? '' : ' <span class="pill blue">New</span>'}</div>
      <div class="small">${esc(a.body)}</div><div class="small mut">${esc(a.created_at)} UTC</div></div>`).join('') : '<div class="mut center">No alerts yet.</div>'}</div></div>`;
  $('#push')?.addEventListener('click', enablePush);
  if (S.unread_alerts) api('POST', '/api/my/alerts/read').then(() => { S.unread_alerts = 0; S.alerts.forEach((a) => (a.read_at = a.read_at || 'now')); badges(); });
}
async function enablePush() {
  await guard(async () => {
    const perm = await Notification.requestPermission(); if (perm !== 'granted') throw new Error('Notifications were not allowed');
    const reg = await navigator.serviceWorker.ready;
    const key = Uint8Array.from(atob(DRS.me.vapid.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - DRS.me.vapid.length % 4) % 4)), (c) => c.charCodeAt(0));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api('POST', '/api/my/push', { subscription: sub.toJSON() }); toast('Push alerts enabled'); $('#push').textContent = '🔔 Push on';
  });
}
async function renderProfile() {
  const { profile, uploads, titles, title_id } = await api('GET', '/api/my/profile');
  $('#view').innerHTML = `<div class="section"><h2>My information</h2><p class="small mut">Keep this current. Passport, visa, ID, shot and clearance details you enter here update your readiness automatically (marked self-reported until the office verifies).</p>
    <div class="card mb"><div class="row"><img class="av lg" src="/api/headshot/${S.contractor.id}?v=${HS_V}" alt=""><div><b>Headshot</b><div class="small mut">For your ID badge. Plain background, face centered. The office approves it.</div></div><button class="btn sm right" id="hsBtn2">📸 Take / upload</button></div>
      <label for="myTitle" class="mt">Title / role</label><select id="myTitle"><option value="">— Select your title —</option>${titles.map((t) => `<option value="${t.id}" ${t.id === title_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
    <div id="pf"></div>
    <details class="sec"><summary><span>📎</span>Document photos (${uploads.length})</summary><div class="body">
      ${uploads.map((u) => `<div class="row small mt"><span>📄</span><a href="/api/uploads/${u.id}" target="_blank" rel="noopener">${esc(u.label)}</a><span class="mut right">${Math.round(u.size / 1024)} KB</span></div>`).join('') || '<p class="small mut">None yet.</p>'}
      <label for="upLabel">What is it?</label><input id="upLabel" placeholder="e.g. Passport photo page">
      <label for="upFile">Photo or PDF (max 5 MB)</label><input id="upFile" type="file" accept="image/jpeg,image/png,image/webp,application/pdf">
      <button class="btn mt" id="upBtn">Upload</button></div></details>
    <div class="sticky-save"><button class="btn pri block" id="save">Save my information</button></div></div>`;
  const form = renderProfileForm($('#pf'), profile, { open: 'personal', uploadUrl: '/api/my/uploads' });
  $('#save').addEventListener('click', () => guard(async () => {
    const r = await api('PUT', '/api/my/profile', { profile: form.collect(), title_id: $('#myTitle').value || null });
    toast(r.synced.length ? `Saved · updated ${r.synced.join(', ')}` : 'Saved'); await load(); tab = 'profile';
  }));
  $('#hsBtn2').addEventListener('click', () => headshotPicker(async (data) => { await uploadHeadshot(data); tab = 'profile'; render(); }));
  $('#upBtn').addEventListener('click', () => guard(async () => {
    const f = $('#upFile').files[0]; if (!f) throw new Error('Choose a file');
    await api('POST', '/api/my/uploads', await fileToPayload(f, $('#upLabel').value || f.name)); toast('Uploaded'); renderProfile();
  }));
}
function fixModal(typeId) {
  const i = S.readiness.items.find((x) => x.requirement_type_id === typeId);
  if (i.is_check) return checkSubmit(i);
  modal(`<div class="row"><h2>${esc(i.name)}</h2><button class="btn sm right" data-close>✕</button></div>
    <p class="small mut">${esc(i.instructions || '')}</p>
    <div class="grid2"><div><label for="mNum">Document / card number</label><input id="mNum" autocomplete="off"></div>
    <div><label for="mIss">${i.category === 'immunization' ? 'Shot date' : 'Issue date'}</label><input id="mIss" type="date"></div>
    ${i.has_expiry ? `<div><label for="mExp">Expiration date *</label><input id="mExp" type="date"></div>` : ''}</div>
    <label for="mFile">Photo of document (optional)</label><input id="mFile" type="file" accept="image/jpeg,image/png,image/webp,application/pdf">
    <button class="btn pri block mt" id="mSave">Submit</button>`, (m, close) => {
    $('#mSave', m).addEventListener('click', () => guard(async () => {
      const f = $('#mFile', m).files[0];
      const body = { number: $('#mNum', m).value, issued: $('#mIss', m).value, expires: $('#mExp', m)?.value || '', file: f ? await fileToPayload(f, i.name) : undefined };
      const r = await api('POST', `/api/my/requirements/${typeId}`, body); close();
      toast(r.readiness.status === 'green' ? '✅ CLEARED TO DEPLOY' : 'Submitted'); await load();
    }));
  });
}
function checkSubmit(i) {
  const doc = i.document || {};
  modal(`<div class="row"><h2>🛡️ ${esc(i.name)}</h2><button class="btn sm right" data-close>✕</button></div>
    <p class="small mut">${esc(i.instructions || '')}</p>
    ${doc.check_status ? `<p>Current status: <b>${esc(doc.check_status.replace('_', ' '))}</b>${doc.expires ? ` · valid until ${fdate(doc.expires)}` : ''}</p>` : ''}
    <div class="grid2"><div><label for="kP">Provider</label><input id="kP" value="${esc(doc.provider)}" placeholder="e.g. Sterling"></div>
    <div><label for="kR">Reference #</label><input id="kR" value="${esc(doc.reference)}"></div>
    <div><label for="kC">Completion date</label><input id="kC" type="date"></div></div>
    <label for="kF">Upload report (stored encrypted)</label><input id="kF" type="file" accept="image/jpeg,image/png,image/webp,application/pdf">
    <p class="small mut">The deployment office reviews and marks it cleared.</p>
    <button class="btn pri block mt" id="kSave">Submit for review</button>`, (m, close) => {
    $('#kSave', m).addEventListener('click', () => guard(async () => {
      const f = $('#kF', m).files[0];
      await api('POST', `/api/my/requirements/${i.requirement_type_id}`, { provider: $('#kP', m).value, reference: $('#kR', m).value, issued: $('#kC', m).value, file: f ? await fileToPayload(f, i.name) : undefined });
      close(); toast('Submitted for review'); await load();
    }));
  });
}
function go(t) { tab = t; render(); }
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]'); if (t) go(t.dataset.tab);
  const g = e.target.closest('[data-go]'); if (g) go(g.dataset.go);
  const f = e.target.closest('[data-fix]'); if (f) fixModal(+f.dataset.fix);
});
$('#bell').addEventListener('click', () => go('alerts'));
$('#logout').addEventListener('click', logout);
(async () => { if (await requireRole('contractor')) { await load(); setInterval(() => { if (tab === 'status') load().catch(() => {}); else api('GET', '/api/my/status').then((s) => { S = s; badges(); }).catch(() => {}); }, 20000); } })();

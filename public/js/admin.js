'use strict';
const A = { list: [], filter: { status: '', q: '', dest: '' }, dests: null };
const main = () => $('#main');
const CAT = { passport: '🛂 Passport', visa: '📄 Visa', immunization: '💉 Immunization', id: '🪪 ID', clearance: '🩺 Clearance', other: '📌 Other' };
async function loadDests() { A.dests = await api('GET', '/api/admin/destinations'); return A.dests; }

// ---------------- Readiness board ----------------
async function dash() {
  const { contractors } = await api('GET', '/api/admin/contractors'); A.list = contractors; if (!A.dests) await loadDests();
  const n = (s) => contractors.filter((c) => c.status === s).length;
  main().innerHTML = `<div class="head"><h1>Readiness board</h1><span class="mut small">${new Date().toDateString()}</span>
      <div class="right row"><button class="btn" id="newC">+ Add contractor</button></div></div>
    <div class="tiles">
      <button class="tile ${!A.filter.status ? 'on' : ''}" data-st=""><div class="mut small">ALL CONTRACTORS</div><div class="n">${contractors.length}</div></button>
      <button class="tile green ${A.filter.status === 'green' ? 'on' : ''}" data-st="green"><div class="mut small">🟢 CLEARED TO DEPLOY</div><div class="n">${n('green')}</div></button>
      <button class="tile yellow ${A.filter.status === 'yellow' ? 'on' : ''}" data-st="yellow"><div class="mut small">🟡 FIX BEFORE NEXT ROTATION</div><div class="n">${n('yellow')}</div></button>
      <button class="tile red ${A.filter.status === 'red' ? 'on' : ''}" data-st="red"><div class="mut small">🔴 NO-GO</div><div class="n">${n('red')}</div></button></div>
    <div class="row mb"><input id="q" placeholder="Search name or employee #" value="${esc(A.filter.q)}" class="grow">
      <select id="dest" class="grow"><option value="">All destinations</option>${A.dests.destinations.map((d) => `<option value="${d.id}" ${String(A.filter.dest) === String(d.id) ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>
    <div class="card"><table><thead><tr><th>Status</th><th>Contractor</th><th>Destination</th><th>Deploys</th><th>Issues</th><th>Passport</th><th>DOB</th></tr></thead><tbody id="rows"></tbody></table></div>`;
  const rows = () => {
    const q = A.filter.q.toLowerCase();
    const list = contractors.filter((c) => (!A.filter.status || c.status === A.filter.status) && (!A.filter.dest || String(c.destination_id) === String(A.filter.dest))
      && (!q || c.name.toLowerCase().includes(q) || c.employee_no.toLowerCase().includes(q)));
    const order = { red: 0, yellow: 1, green: 2 };
    list.sort((a, b) => order[a.status] - order[b.status] || a.days_to_deploy - b.days_to_deploy);
    $('#rows').innerHTML = list.map((c) => `<tr class="click" data-id="${c.id}"><td>${pill(c.status)}${c.overridden ? '<div class="small mut mt">manual</div>' : ''}</td>
      <td><b>${esc(c.name)}</b><div class="small mut">${esc(c.employee_no)}${c.unverified ? ` · <span class="pill blue">${c.unverified} to verify</span>` : ''}</div></td>
      <td>${esc(c.destination)}</td><td>${fdate(c.deploy_date)}<div class="small mut">${c.days_to_deploy > 0 ? `in ${c.days_to_deploy} days` : 'on rotation'}</div></td>
      <td><div class="issues">${c.issues.map((i) => `<span class="pill ${i.status}">${esc(i.name)}</span>`).join('') || '<span class="mut small">None</span>'}</div>${c.fix_by ? `<div class="small mut mt">Fix by ${fdate(c.fix_by)}</div>` : ''}</td>
      <td class="mut">${esc(c.passport_masked) || '—'}</td><td class="mut">${esc(c.dob_masked) || '—'}</td></tr>`).join('') || '<tr><td colspan="7" class="mut center">No matches</td></tr>';
  };
  rows();
  $$('[data-st]').forEach((b) => b.addEventListener('click', () => { A.filter.status = b.dataset.st; dash(); }));
  $('#q').addEventListener('input', (e) => { A.filter.q = e.target.value; rows(); });
  $('#dest').addEventListener('change', (e) => { A.filter.dest = e.target.value; rows(); });
  $('#rows').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) location.hash = `#/c/${tr.dataset.id}`; });
  $('#newC').addEventListener('click', () => contractorModal());
}

function contractorModal(c = {}) {
  const ds = A.dests.destinations;
  modal(`<div class="row"><h2>${c.id ? 'Edit contractor' : 'Add contractor'}</h2><button class="btn sm right" data-close>✕</button></div>
    <div class="grid2">
      <div><label>Full name *</label><input id="cName" value="${esc(c.name)}"></div><div><label>Employee # *</label><input id="cEmp" value="${esc(c.employee_no)}"></div>
      <div><label>Phone</label><input id="cPhone" value="${esc(c.phone)}"></div><div><label>Email</label><input id="cEmail" value="${esc(c.email)}"></div>
      <div><label>Destination</label><select id="cDest"><option value="">—</option>${ds.map((d) => `<option value="${d.id}" ${d.id === c.destination_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>
      <div><label>Home airport (IATA)</label><input id="cHome" maxlength="3" value="${esc(c.home_airport)}"></div>
      <div><label>Rotation start (deploy date)</label><input id="cDep" type="date" value="${esc(c.deploy_date)}"></div>
      <div><label>Next rotation start (optional)</label><input id="cNext" type="date" value="${esc(c.next_deploy_date)}"></div>
      <div><label>Days on</label><input id="cOn" type="number" value="${c.rotation_on ?? 60}"></div><div><label>Days off</label><input id="cOff" type="number" value="${c.rotation_off ?? 30}"></div></div>
    <label>Notes</label><textarea id="cNotes" rows="2">${esc(c.notes)}</textarea>
    ${c.id ? '' : `<h3 class="mt">App login (optional)</h3><div class="grid2"><div><label>Login email</label><input id="aEmail"></div><div><label>Temporary password (10+ chars)</label><input id="aPw" type="password" autocomplete="new-password"></div></div>`}
    <div class="row mt">${c.id ? '<button class="btn danger" id="cDel">Delete</button>' : ''}<button class="btn pri right" id="cSave">Save</button></div>`, (m, close) => {
    $('#cSave', m).addEventListener('click', () => guard(async () => {
      const body = { name: $('#cName', m).value, employee_no: $('#cEmp', m).value, phone: $('#cPhone', m).value, email: $('#cEmail', m).value, destination_id: $('#cDest', m).value || null,
        home_airport: $('#cHome', m).value, deploy_date: $('#cDep', m).value, next_deploy_date: $('#cNext', m).value, rotation_on: +$('#cOn', m).value, rotation_off: +$('#cOff', m).value, notes: $('#cNotes', m).value };
      const r = c.id ? await api('PUT', `/api/admin/contractors/${c.id}`, body) : await api('POST', '/api/admin/contractors', body);
      if (!c.id && $('#aEmail', m).value) await api('PUT', `/api/admin/contractors/${r.id}/account`, { email: $('#aEmail', m).value, password: $('#aPw', m).value });
      close(); toast('Saved'); location.hash = `#/c/${c.id || r.id}`; route();
    }));
    $('#cDel', m)?.addEventListener('click', () => guard(async () => { if (!confirm(`Delete ${c.name}? This removes all their records.`)) return; await api('DELETE', `/api/admin/contractors/${c.id}`); close(); location.hash = '#/'; }));
  });
}

// ---------------- Contractor detail ----------------
async function detail(id, sub = 'readiness') {
  if (!A.dests) await loadDests();
  const d = await api('GET', `/api/admin/contractors/${id}`); const c = d.contractor; const r = d.readiness;
  main().innerHTML = `<div class="head"><a href="#/" class="btn sm">← Board</a><h1>${esc(c.name)}</h1>${pill(r.status)}${r.overridden ? '<span class="pill gray">manual override</span>' : ''}
      <div class="right row"><button class="btn" id="edit">Edit</button></div></div>
    <div class="row wrap mb small mut"><span>${esc(c.employee_no)}</span>·<span>📍 ${esc((A.dests.destinations.find((x) => x.id === c.destination_id) || {}).name || '—')}</span>·
      <span>Rotation ${fdate(r.rotation.start)} → ${fdate(r.rotation.end)}</span>·<span>Next ${fdate(r.rotation.next_start)}</span>·<span>${c.rotation_on}/${c.rotation_off}</span>·<span>Login: ${esc(d.account_email || 'none')}</span></div>
    <div class="tabs">${[['readiness', 'Readiness'], ['profile', 'Profile / intake'], ['flights', `Flights (${d.flights.length})`], ['alerts', 'Alerts'], ['account', 'App login']].map(([k, t]) => `<button data-sub="${k}" class="${k === sub ? 'on' : ''}">${t}</button>`).join('')}</div>
    <div id="sub"></div>`;
  $('#edit').addEventListener('click', () => contractorModal(c));
  $$('[data-sub]').forEach((b) => b.addEventListener('click', () => { location.hash = `#/c/${id}/${b.dataset.sub}`; }));
  ({ readiness: subReadiness, profile: subProfile, flights: subFlights, alerts: subAlerts, account: subAccount })[sub](d);
}
function subReadiness(d) {
  const c = d.contractor; const r = d.readiness;
  $('#sub').innerHTML = `<div class="cols"><div class="card"><div class="row"><h2>Requirements for this destination</h2><span class="right small mut">computed: ${pill(r.computed_status)}</span></div>
      <table class="mt"><thead><tr><th></th><th>Requirement</th><th>Expires</th><th>Status</th><th></th></tr></thead><tbody>
      ${r.items.map((i) => `<tr><td><span class="dot ${i.status}"></span></td><td><b>${esc(i.name)}</b><div class="small mut">${esc(CAT[i.category])}${i.document && i.document.ref_last4 ? ` · •••• ${esc(i.document.ref_last4)}` : ''}</div></td>
        <td>${i.document ? (i.has_expiry ? fdate(i.document.expires) : 'No expiry') : '—'}</td>
        <td class="small">${esc(i.message)}${i.document && !i.document.verified ? `<div><span class="pill blue">self-reported</span></div>` : ''}${i.document && i.document.upload_id ? ` <a href="/api/uploads/${i.document.upload_id}" target="_blank" rel="noopener">photo</a>` : ''}</td>
        <td class="row">${i.document && !i.document.verified ? `<button class="btn sm pri" data-verify="${i.requirement_type_id}">Verify</button>` : ''}<button class="btn sm" data-doc="${i.requirement_type_id}">Edit</button></td></tr>`).join('')}</tbody></table></div>
    <div><div class="card"><h2>Manual override</h2><p class="small mut">Overrides the computed light. The reason is shown to the contractor.</p>
        <div class="grid2"><div><label>Status</label><select id="ovS"><option value="">Automatic</option>${['green', 'yellow', 'red'].map((s) => `<option ${c.override_status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div><label>Reason</label><input id="ovR" value="${esc(c.override_reason)}"></div></div><button class="btn mt" id="ovSave">Save override</button></div>
      <div class="card mt"><h2>Other blockers</h2><p class="small mut">Any active blocker makes the contractor RED (e.g. HR hold, pending medical review).</p>
        ${d.blockers.map((b) => `<div class="row mt"><span class="dot ${b.active ? 'red' : 'green'}"></span><span class="grow ${b.active ? '' : 'mut'}">${esc(b.description)}</span><button class="btn sm" data-blk="${b.id}" data-act="${b.active ? 0 : 1}">${b.active ? 'Clear' : 'Re-activate'}</button></div>`).join('') || '<p class="small mut">None.</p>'}
        <div class="row mt"><input id="blkD" placeholder="Add blocker…"><button class="btn" id="blkAdd">Add</button></div></div></div></div>`;
  const reload = () => detail(c.id, 'readiness');
  $$('[data-verify]').forEach((b) => b.addEventListener('click', () => guard(async () => { await api('POST', `/api/admin/contractors/${c.id}/documents/${b.dataset.verify}/verify`); toast('Verified'); reload(); })));
  $$('[data-doc]').forEach((b) => b.addEventListener('click', () => docModal(c, r.items.find((i) => i.requirement_type_id === +b.dataset.doc), reload)));
  $('#ovSave').addEventListener('click', () => guard(async () => { await api('PUT', `/api/admin/contractors/${c.id}/override`, { status: $('#ovS').value, reason: $('#ovR').value }); toast('Override saved'); reload(); }));
  $$('[data-blk]').forEach((b) => b.addEventListener('click', () => guard(async () => { await api('PUT', `/api/admin/blockers/${b.dataset.blk}`, { active: b.dataset.act === '1' }); reload(); })));
  $('#blkAdd').addEventListener('click', () => guard(async () => { await api('POST', `/api/admin/contractors/${c.id}/blockers`, { description: $('#blkD').value }); reload(); }));
}
function docModal(c, i, done) {
  const doc = i.document || {};
  modal(`<div class="row"><h2>${esc(i.name)}</h2><button class="btn sm right" data-close>✕</button></div>
    <div class="grid2"><div><label>Doc # (last 4 only)</label><input id="dL4" maxlength="4" value="${esc(doc.ref_last4)}"></div>
    <div><label>Status</label><select id="dSt">${['valid', 'pending', 'rejected'].map((s) => `<option ${doc.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    <div><label>Issued</label><input id="dIss" type="date" value="${esc(doc.issued)}"></div>
    <div><label>Expires ${i.has_expiry ? '' : '(n/a)'}</label><input id="dExp" type="date" value="${esc(doc.expires)}" ${i.has_expiry ? '' : 'disabled'}></div></div>
    <label>Notes</label><input id="dNotes" value="${esc(doc.notes)}">
    <div class="row mt">${i.document ? '<button class="btn danger" id="dDel">Remove</button>' : ''}<button class="btn pri right" id="dSave">Save (verified)</button></div>`, (m, close) => {
    $('#dSave', m).addEventListener('click', () => guard(async () => {
      await api('PUT', `/api/admin/contractors/${c.id}/documents/${i.requirement_type_id}`, { ref_last4: $('#dL4', m).value, status: $('#dSt', m).value, issued: $('#dIss', m).value, expires: $('#dExp', m).value, notes: $('#dNotes', m).value });
      close(); toast('Saved'); done();
    }));
    $('#dDel', m)?.addEventListener('click', () => guard(async () => { await api('DELETE', `/api/admin/contractors/${c.id}/documents/${i.requirement_type_id}`); close(); done(); }));
  });
}
function subProfile(d) {
  const c = d.contractor;
  $('#sub').innerHTML = `<div class="row mb"><p class="small mut grow">Full intake sheet (encrypted at rest). Last updated ${esc(d.profile._updated_at || '—')} UTC by ${esc(d.profile._updated_by || '—')}.</p>
      <button class="btn pri" id="pSave">Save profile</button></div><div id="pf"></div>
    <div class="card mt"><h3>Document photos</h3>${d.uploads.map((u) => `<div class="row small mt"><span>📄</span><a href="/api/uploads/${u.id}" target="_blank" rel="noopener">${esc(u.label)}</a><span class="mut">by ${esc(u.uploaded_by)} · ${esc(u.created_at)}</span></div>`).join('') || '<p class="small mut">None uploaded.</p>'}
      <div class="row mt"><input id="upL" placeholder="Label"><input id="upF" type="file" accept="image/jpeg,image/png,image/webp,application/pdf"><button class="btn" id="upB">Upload</button></div></div>`;
  const form = renderProfileForm($('#pf'), d.profile, { open: true });
  $('#pSave').addEventListener('click', () => guard(async () => { await api('PUT', `/api/admin/contractors/${c.id}/profile`, { profile: form.collect() }); toast('Profile saved'); }));
  $('#upB').addEventListener('click', () => guard(async () => { const f = $('#upF').files[0]; if (!f) throw new Error('Choose a file'); await api('POST', `/api/admin/contractors/${c.id}/uploads`, await fileToPayload(f, $('#upL').value || f.name)); detail(c.id, 'profile'); }));
}
function flightForm(f = {}) {
  return `<div class="grid3"><div><label>Airline *</label><input id="fAir" value="${esc(f.airline)}"></div><div><label>Flight # *</label><input id="fNo" value="${esc(f.flight_no)}"></div><div><label>Confirmation #</label><input id="fConf" value="${esc(f.confirmation)}"></div>
    <div><label>From (IATA) *</label><input id="fFrom" maxlength="3" value="${esc(f.from_airport)}"></div><div><label>To (IATA) *</label><input id="fTo" maxlength="3" value="${esc(f.to_airport)}"></div><div><label>Seat</label><input id="fSeat" value="${esc(f.seat)}"></div>
    <div><label>Departs (local) *</label><input id="fDep" type="datetime-local" value="${esc(f.depart_at)}"></div><div><label>Arrives (local)</label><input id="fArr" type="datetime-local" value="${esc(f.arrive_at)}"></div></div>
    <label>Notes for contractor</label><textarea id="fNotes" rows="2">${esc(f.notes)}</textarea>`;
}
const readFlight = (m) => ({ airline: $('#fAir', m).value, flight_no: $('#fNo', m).value, confirmation: $('#fConf', m).value, from_airport: $('#fFrom', m).value, to_airport: $('#fTo', m).value,
  seat: $('#fSeat', m).value, depart_at: $('#fDep', m).value, arrive_at: $('#fArr', m).value, notes: $('#fNotes', m).value });
function subFlights(d) {
  const c = d.contractor;
  $('#sub').innerHTML = `<div class="cols"><div class="card"><h2>Send flight to ${esc(c.name.split(' ')[0])}</h2><p class="small mut">Shows up instantly in their app with a NEW badge and an alert (and a push notification if they enabled it).</p>
      <div id="ff">${flightForm()}</div><label class="chk mt"><input type="checkbox" id="fNotify" checked> Send alert to contractor</label><button class="btn pri mt" id="fSend">✈️ Send flight</button></div>
    <div class="card"><h2>Itinerary</h2>${d.flights.map((f) => `<div class="flight ${f.seen_at ? '' : 'new'}"><div class="row small mut">${esc(f.airline)} · <b>${esc(f.flight_no)}</b> · Conf ${esc(f.confirmation || '—')}
      <span class="right">${f.seen_at ? '✓ seen' : '<span class="pill blue">not seen yet</span>'}</span></div><div class="route">${esc(f.from_airport)}<span class="line"></span>${esc(f.to_airport)}</div>
      <div class="small">${fdt(f.depart_at)}${f.arrive_at ? ` → ${fdt(f.arrive_at)}` : ''}</div><div class="row mt"><button class="btn sm" data-fe="${f.id}">Edit</button><button class="btn sm danger" data-fd="${f.id}">Cancel flight</button></div></div>`).join('') || '<p class="mut small">No flights yet.</p>'}</div></div>`;
  $('#fSend').addEventListener('click', () => guard(async () => { await api('POST', `/api/admin/contractors/${c.id}/flights`, { ...readFlight($('#ff')), notify: $('#fNotify').checked }); toast('Flight sent ✈️'); detail(c.id, 'flights'); }));
  $$('[data-fe]').forEach((b) => b.addEventListener('click', () => {
    const f = d.flights.find((x) => x.id === +b.dataset.fe);
    modal(`<div class="row"><h2>Edit flight</h2><button class="btn sm right" data-close>✕</button></div>${flightForm(f)}<p class="small mut">Saving sends a “Flight changed” alert automatically.</p><button class="btn pri mt" id="feS">Save & notify</button>`, (m, close) => {
      $('#feS', m).addEventListener('click', () => guard(async () => { await api('PUT', `/api/admin/flights/${f.id}`, readFlight(m)); close(); toast('Updated — contractor alerted'); detail(c.id, 'flights'); }));
    });
  }));
  $$('[data-fd]').forEach((b) => b.addEventListener('click', () => guard(async () => { if (!confirm('Cancel this flight? The contractor will be alerted.')) return; await api('DELETE', `/api/admin/flights/${b.dataset.fd}`); detail(c.id, 'flights'); })));
}
function subAlerts(d) {
  $('#sub').innerHTML = `<div class="card"><div class="row"><h2>Alerts sent to ${esc(d.contractor.name)}</h2><a class="btn sm right" href="#/alerts?to=${d.contractor.id}">+ New alert</a></div>
    ${d.alerts.map((a) => `<div class="alert-item"><div class="t"><b>${esc(a.title)}</b><span class="pill gray">${esc(a.kind)}</span><span class="right small mut">${a.read_at ? '✓ read' : 'unread'}</span></div><div class="small">${esc(a.body)}</div><div class="small mut">${esc(a.created_at)} UTC</div></div>`).join('') || '<p class="mut small">None.</p>'}</div>`;
}
function subAccount(d) {
  $('#sub').innerHTML = `<div class="card"><h2>App login</h2><p class="small mut">Set or reset the contractor's login. Resetting signs them out everywhere. Passwords are stored as salted scrypt hashes.</p>
    <div class="grid2"><div><label>Login email</label><input id="acE" value="${esc(d.account_email || d.contractor.email)}"></div><div><label>New temporary password (10+ chars)</label><input id="acP" type="password" autocomplete="new-password"></div></div>
    <button class="btn pri mt" id="acS">Save login</button></div>`;
  $('#acS').addEventListener('click', () => guard(async () => { await api('PUT', `/api/admin/contractors/${d.contractor.id}/account`, { email: $('#acE').value, password: $('#acP').value }); toast('Login saved'); }));
}

// ---------------- Send alert ----------------
async function alertsPage(pre) {
  const { contractors } = await api('GET', '/api/admin/contractors');
  main().innerHTML = `<div class="head"><h1>Send alert</h1></div><div class="cols"><div class="card">
    <label>Send to</label><select id="alTo"><option value="pick">Selected contractors</option><option value="all">Everyone</option><option value="red">All RED</option><option value="yellow">All YELLOW</option><option value="green">All GREEN</option></select>
    <div id="pickWrap"><label>Contractors</label><div class="pick">${contractors.map((c) => `<label><input type="checkbox" value="${c.id}" ${String(c.id) === pre ? 'checked' : ''}><span class="dot ${c.status}"></span>${esc(c.name)} <span class="mut small">${esc(c.destination)}</span></label>`).join('')}</div></div>
    <div class="grid2"><div><label>Type</label><select id="alK"><option value="info">📣 Info</option><option value="flight">✈️ Flight</option><option value="urgent">🚨 Urgent</option><option value="readiness">🚦 Readiness</option></select></div><div></div></div>
    <label>Title *</label><input id="alT" maxlength="120" placeholder="e.g. Flight time changed">
    <label>Message</label><textarea id="alB" rows="4"></textarea>
    <div class="chips mt">${['Flight changed — check the app', 'Weather delay at hub', 'Report to airport 4 hours early', 'Upload your updated shot records'].map((t) => `<span class="chip" data-t="${esc(t)}">${esc(t)}</span>`).join('')}</div>
    <button class="btn pri mt" id="alSend">Send alert</button></div>
    <div class="card"><h3>How contractors get it</h3><p class="small mut">• In-app banner on their status screen + Alerts inbox with unread badge.<br>• Web push notification if they tapped “Enable push alerts” (Android/desktop; iPhone after Add to Home Screen, iOS 16.4+).<br>• Production: native push via Capacitor (APNs/FCM) and optional SMS fallback.</p></div></div>`;
  const sync = () => $('#pickWrap').classList.toggle('hidden', $('#alTo').value !== 'pick'); sync();
  $('#alTo').addEventListener('change', sync);
  $$('[data-t]').forEach((c) => c.addEventListener('click', () => { $('#alT').value = c.dataset.t; }));
  $('#alSend').addEventListener('click', () => guard(async () => {
    const to = $('#alTo').value;
    const r = await api('POST', '/api/admin/alerts', { to: to === 'pick' ? undefined : to, contractor_ids: $$('.pick input:checked').map((i) => +i.value), kind: $('#alK').value, title: $('#alT').value, body: $('#alB').value });
    toast(`Alert sent to ${r.sent} contractor${r.sent === 1 ? '' : 's'}`); $('#alT').value = ''; $('#alB').value = '';
  }));
}

// ---------------- Booking assistant ----------------
const chat = [];
function assistantPage() {
  main().innerHTML = `<div class="head"><h1>🤖 Booking assistant</h1><span class="pill yellow">Demo · sample fares</span></div>
    <p class="small mut">Ask in plain English. The assistant checks the contractor’s readiness for that destination, applies a 30-day advance booking window, and ranks fares by price. You approve before anything is booked.</p>
    <div class="chips mb">${['John Doe needs to go to Africa', 'Tyler Brandt needs to go to Africa', 'Book Marcus Delgado to Erbil', 'Sam Kowalski needs to go to Iraq', 'Cody Ramirez to Kuwait'].map((t) => `<span class="chip" data-q="${esc(t)}">${esc(t)}</span>`).join('')}</div>
    <div class="chat" id="chat"></div>
    <div class="row mt"><input id="ask" placeholder="e.g. John Doe needs to go to Africa"><button class="btn pri" id="askB">Ask</button></div>`;
  const draw = () => {
    $('#chat').innerHTML = chat.map((m, idx) => m.me ? `<div class="bubble me">${esc(m.text)}</div>` : `<div class="bubble bot">${m.html}</div>`).join('');
    $$('[data-book]').forEach((b) => b.addEventListener('click', () => book(chat[+b.dataset.idx].plan, b.dataset.book)));
  };
  const ask = (text) => guard(async () => {
    if (!text.trim()) return; chat.push({ me: true, text }); draw();
    const p = await api('POST', '/api/admin/assistant/plan', { text });
    chat.push({ plan: p, html: planHtml(p, chat.length) }); draw(); $('#ask').value = '';
    window.scrollTo(0, document.body.scrollHeight);
  });
  async function book(p, airline) {
    await guard(async () => {
      const r = await api('POST', '/api/admin/assistant/book', { contractor_id: p.contractor.id, destination_id: p.destination.id, depart_date: p.depart_date, airline });
      chat.push({ html: `✅ <b>Booked.</b> ${esc(p.contractor.name)} → ${esc(p.destination.name)} on ${esc(airline)}, confirmation <b>${esc(r.confirmation)}</b>. Added to their Flights tab and alert sent. <a href="#/c/${p.contractor.id}/flights">View itinerary</a>` });
      draw(); toast('Booked & contractor alerted');
    });
  }
  $('#askB').addEventListener('click', () => ask($('#ask').value));
  $('#ask').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask($('#ask').value); });
  $$('[data-q]').forEach((c) => c.addEventListener('click', () => ask(c.dataset.q)));
  draw();
}
function planHtml(p, idx) {
  if (!p.ok) return `⚠️ ${esc(p.message)}`;
  const r = p.readiness;
  return `<div class="row"><b>${esc(p.contractor.name)}</b> → <b>${esc(p.destination.name)}</b> ${pill(r.status, r.status === 'red' ? 'Blocked' : r.status === 'yellow' ? 'Go — action needed' : 'Cleared')}</div>
    <p>${esc(p.summary)}</p>
    ${p.notes.map((n) => `<div class="small mut">ℹ️ ${esc(n)}</div>`).join('')}
    <div class="mt"><b class="small">Readiness check for ${esc(p.destination.country)}</b>${r.items.map((i) => `<div class="row small"><span class="dot ${i.status}"></span><span>${esc(i.name)}</span><span class="mut">— ${esc(i.message)}</span></div>`).join('')}
    ${r.blockers.map((b) => `<div class="row small"><span class="dot red"></span>${esc(b.description)}</div>`).join('')}</div>
    <div class="mt small"><b>Proposed trip:</b> ${esc(p.contractor.home_airport)} → ${esc(p.destination.airport)} · depart ${fdate(p.depart_date)} · return ~${fdate(p.return_date)} (${r.rotation.on}-day rotation)</div>
    <div class="mt"><b class="small">Fare options (DEMO data, ranked by price)</b>${p.fares.map((f, i) => `<div class="fare ${i === 0 ? 'best' : ''}"><div class="price">$${f.price_usd.toLocaleString()}</div>
      <div><b>${esc(f.airline)}</b>${i === 0 ? ' <span class="pill green">Cheapest</span>' : ''}<div class="small mut">${f.legs.map((l) => esc(l.flight_no)).join(' + ')} · via ${esc(f.via)} · ${f.duration_h}h · ${f.refundable ? 'refundable' : 'non-refundable'}</div><div class="small mut">Departs ${fdt(f.depart_at)} · arrives ${fdt(f.arrive_at)}</div></div>
      <div></div>${p.can_book ? `<button class="btn ${i === 0 ? 'pri' : ''} sm" data-book="${esc(f.airline)}" data-idx="${idx}">Approve & book</button>` : '<button class="btn sm" disabled title="Contractor is RED">Blocked</button>'}</div>`).join('')}</div>`;
}

// ---------------- Demo scenarios ----------------
async function scenarios() {
  const { contractors } = await api('GET', '/api/admin/contractors');
  const info = await api('GET', '/api/demo-info');
  const by = (n) => contractors.find((c) => c.name === n) || {};
  const card = (name, title, story) => { const c = by(name); return `<div class="card"><h3>${pill(c.status || 'gray')} ${esc(title)}</h3><p><b>${esc(name)}</b> · ${esc(c.destination || '')}</p><p class="small mut">${story}</p>
    <div class="small">Login: <code>${esc((info.contractors.find((x) => x.name === name) || {}).email || '')}</code> / <code>${esc(info.contractor_password || '')}</code></div>
    <div class="row mt"><a class="btn sm" href="#/c/${c.id}">Open admin record</a></div></div>`; };
  main().innerHTML = `<div class="head"><h1>🎬 Demo scenarios</h1><div class="right row"><button class="btn danger" id="reset">↺ Reset demo data</button></div></div>
    <p class="small mut">All people and documents are fictional. Open a contractor login in a phone-sized window (or a second browser) to see their side.</p>
    <div class="scen">
      ${card('Marcus Delgado', 'A · Green — ready to deploy', 'Every requirement is valid through his next rotation. Flights already sent — his app shows CLEARED TO DEPLOY and a NEW flight badge.')}
      ${card('Cody Ramirez', 'B · Yellow — passport expires before next rotation', 'Passport fails the 6-month rule for his NEXT rotation only. He can deploy now; his app shows a countdown to the renewal deadline.')}
      ${card('Brianna Holt', 'B · Yellow — shot lapses before next rotation', 'Typhoid vaccine lapses before her next rotation. Countdown + instructions shown.')}
      ${card('Sam Kowalski', 'C · Red — expired passport + missing visa', 'Passport expired and no Iraq work visa on file. NO-GO.')}
      ${card('John Doe', 'C/D · Red — missing yellow fever shot → live fix', 'Djibouti requires yellow fever. <b>Walk-through:</b> 1) Ask the assistant “John Doe needs to go to Africa” → booking is BLOCKED. 2) Log in as John, tap <i>Fix now</i> on Yellow Fever, enter shot date, attach a photo → light flips to GREEN. 3) Ask the assistant again → fares can be approved and booked; flights appear in John’s app with an alert.')}
      ${card('Tyler Brandt', 'Green — AI booking allowed', 'Cleared for Djibouti. “Tyler Brandt needs to go to Africa” returns ranked fares you can approve.')}
      ${card('Trent Vaughn', 'Red — manual hold', 'All documents valid, but an admin blocker + override (HR hold) keeps him RED with the reason shown in his app.')}
    </div>
    <div class="card mt"><h3>Try these too</h3><p class="small mut">• Edit one of Marcus’s flights → he gets an automatic “Flight changed” alert.<br>• Send an alert to all RED contractors from <a href="#/alerts">Send alert</a>.<br>• Add a requirement to a destination in <a href="#/destinations">Destinations</a> and watch statuses recompute.</p></div>`;
  $('#reset').addEventListener('click', () => guard(async () => { if (!confirm('Reset ALL demo data to the starting scenarios? You will be signed out.')) return; await api('POST', '/api/admin/demo/reset'); location.href = '/'; }));
}

// ---------------- Destinations ----------------
async function destinations() {
  const { destinations: ds, requirement_types: rts } = await loadDests();
  main().innerHTML = `<div class="head"><h1>Destinations & requirements</h1><div class="right row"><button class="btn" id="newD">+ Destination</button><button class="btn" id="newR">+ Requirement type</button></div></div>
    <div class="cols"><div>${ds.map((d) => `<div class="card mb"><div class="row"><h2>${esc(d.name)}</h2><span class="pill gray">${esc(d.region)}</span><span class="mut small">${esc(d.airport)}</span><button class="btn sm right" data-ed="${d.id}">Edit</button></div>
      <div class="issues mt">${d.requirement_ids.map((id) => `<span class="pill gray">${esc((rts.find((r) => r.id === id) || {}).name)}</span>`).join('')}</div></div>`).join('')}</div>
    <div class="card"><h2>Requirement types</h2><table class="mt"><thead><tr><th>Name</th><th>Validity rule</th><th>Lead time</th><th></th></tr></thead><tbody>
      ${rts.map((r) => `<tr><td><b>${esc(r.name)}</b><div class="small mut">${esc(CAT[r.category])}</div></td><td class="small">${r.has_expiry ? (r.min_validity_days ? `valid ${r.min_validity_days}d past return` : 'valid through return') : 'no expiry'}</td><td class="small">${r.lead_days}d</td><td><button class="btn sm" data-er="${r.id}">Edit</button></td></tr>`).join('')}</tbody></table></div></div>`;
  const destModal = (d = { requirement_ids: [] }) => modal(`<div class="row"><h2>${d.id ? 'Edit' : 'New'} destination</h2><button class="btn sm right" data-close>✕</button></div>
    <div class="grid2"><div><label>Name *</label><input id="dN" value="${esc(d.name)}"></div><div><label>Country *</label><input id="dC" value="${esc(d.country)}"></div>
    <div><label>Region</label><input id="dR" value="${esc(d.region)}" placeholder="Africa, Middle East…"></div><div><label>Arrival airport (IATA)</label><input id="dA" maxlength="3" value="${esc(d.airport)}"></div></div>
    <label>Required for this destination</label><div class="pick">${rts.map((r) => `<label><input type="checkbox" value="${r.id}" ${d.requirement_ids.includes(r.id) ? 'checked' : ''}>${esc(r.name)}</label>`).join('')}</div>
    <button class="btn pri mt" id="dS">Save</button>`, (m, close) => {
    $('#dS', m).addEventListener('click', () => guard(async () => {
      const body = { name: $('#dN', m).value, country: $('#dC', m).value, region: $('#dR', m).value, airport: $('#dA', m).value, requirement_ids: $$('.pick input:checked', m).map((i) => +i.value) };
      d.id ? await api('PUT', `/api/admin/destinations/${d.id}`, body) : await api('POST', '/api/admin/destinations', body); close(); toast('Saved — statuses recomputed'); destinations();
    }));
  });
  const rtModal = (r = { has_expiry: 1, lead_days: 30, min_validity_days: 0, category: 'other' }) => modal(`<div class="row"><h2>${r.id ? 'Edit' : 'New'} requirement type</h2><button class="btn sm right" data-close>✕</button></div>
    <div class="grid2"><div><label>Name *</label><input id="rN" value="${esc(r.name)}"></div><div><label>Category</label><select id="rC">${Object.keys(CAT).map((k) => `<option value="${k}" ${r.category === k ? 'selected' : ''}>${CAT[k]}</option>`).join('')}</select></div>
    <div><label>Must stay valid N days past return</label><input id="rM" type="number" value="${r.min_validity_days}"></div><div><label>Lead time to renew (days)</label><input id="rL" type="number" value="${r.lead_days}"></div>
    <div><label>Intake keyword (matches contractor entries)</label><input id="rK" value="${esc(r.keyword)}"></div><div><label class="chk"><input type="checkbox" id="rE" ${r.has_expiry ? 'checked' : ''}> Has an expiration date</label></div></div>
    <label>Instructions shown to contractor</label><textarea id="rI" rows="3">${esc(r.instructions)}</textarea><button class="btn pri mt" id="rS">Save</button>`, (m, close) => {
    $('#rS', m).addEventListener('click', () => guard(async () => {
      const body = { name: $('#rN', m).value, category: $('#rC', m).value, min_validity_days: +$('#rM', m).value, lead_days: +$('#rL', m).value, keyword: $('#rK', m).value, has_expiry: $('#rE', m).checked, instructions: $('#rI', m).value };
      r.id ? await api('PUT', `/api/admin/requirement-types/${r.id}`, body) : await api('POST', '/api/admin/requirement-types', body); close(); toast('Saved'); destinations();
    }));
  });
  $('#newD').addEventListener('click', () => destModal()); $('#newR').addEventListener('click', () => rtModal());
  $$('[data-ed]').forEach((b) => b.addEventListener('click', () => destModal(ds.find((d) => d.id === +b.dataset.ed))));
  $$('[data-er]').forEach((b) => b.addEventListener('click', () => rtModal(rts.find((r) => r.id === +b.dataset.er))));
}
async function audit() {
  const { log } = await api('GET', '/api/admin/audit');
  main().innerHTML = `<div class="head"><h1>Audit log</h1><span class="mut small">last 200 events · times UTC</span></div><div class="card"><table><thead><tr><th>When (UTC)</th><th>User</th><th>Action</th><th>Details</th><th>IP</th></tr></thead><tbody>
    ${log.map((l) => `<tr><td class="small">${esc(l.at)}</td><td class="small">${esc(l.email || '—')}</td><td><span class="pill gray">${esc(l.action)}</span></td><td class="small">${esc(l.details)}</td><td class="small mut">${esc(l.ip)}</td></tr>`).join('')}</tbody></table></div>`;
}

async function route() {
  const h = location.hash.slice(1) || '/'; const [p, qs] = h.split('?'); const parts = p.split('/').filter(Boolean);
  const nav = parts[0] === 'c' ? 'dash' : parts[0] || 'dash';
  $$('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === nav));
  await guard(async () => {
    if (parts[0] === 'c') return detail(+parts[1], parts[2] || 'readiness');
    if (parts[0] === 'scenarios') return scenarios();
    if (parts[0] === 'assistant') return assistantPage();
    if (parts[0] === 'alerts') return alertsPage(new URLSearchParams(qs || '').get('to'));
    if (parts[0] === 'destinations') return destinations();
    if (parts[0] === 'audit') return audit();
    return dash();
  });
}
$('#logout').addEventListener('click', (e) => { e.preventDefault(); logout(); });
window.addEventListener('hashchange', route);
(async () => { if (await requireRole('admin')) route(); })();

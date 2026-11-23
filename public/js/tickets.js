'use strict';
// Tickets to approve: proposed itineraries for everyone departing in <= 30 days. Admin confirms (one or many), swaps, or rejects.
// Status flow: Waiting for approval -> Confirmed by admin → Booking -> Booked (mock in the demo).
const TKS = { tab: 'pending', sel: new Set() };
const legTimes = (f) => `${esc(f.depart_at.slice(5).replace('T', ' '))} → ${esc(String(f.arrive_at || '').slice(5).replace('T', ' '))}`;
const routeTxt = (f) => [f.origin, ...f.legs.map((l) => l.to_airport)].map(esc).join(' → ');
const cabinPill = (f) => `<span class="pill ${f.cabin === 'first' ? 'gold' : 'blue'}">${esc(f.cabin_label)}</span>${f.cabin_note ? ` <span class="small mut">${esc(f.cabin_note)}</span>` : ''}`;
const prefPill = (f) => (f.preferred ? ' <span class="pill green">★ Company preferred</span>' : '');
const daysTxt = (n) => (n === 0 ? 'departs today' : `${n} day${n === 1 ? '' : 's'} out`);
const ST_CLS = { pending: 'yellow', confirmed: 'blue', booked: 'green', rejected: 'red' };

// Banner + badges on every admin page (full and compact view)
async function tkBar() {
  const s = await api('GET', '/api/admin/tickets/summary').catch(() => null); if (!s) return;
  const bar = $('#tkBar'); const on = location.hash.startsWith('#/tickets');
  bar.innerHTML = s.pending && !on ? `<a class="tk-bar" href="#/tickets"><span class="tk-ic">🎫</span><span class="grow"><b>${esc(s.text)}</b>${s.red ? `<span class="small"> · ${s.red} RED (needs your override)</span>` : ''}</span><span class="btn sm pri">Review</span></a>` : '';
  $$('.tkN').forEach((b) => { b.textContent = s.pending || ''; b.classList.toggle('hidden', !s.pending); });
}

async function ticketsPage() {
  const d = await api('GET', `/api/admin/tickets?status=${TKS.tab === 'pending' ? 'pending' : TKS.tab}`); const st = d.settings;
  TKS.sel = new Set([...TKS.sel].filter((id) => d.tickets.some((t) => t.id === id && t.status === 'pending')));
  const pref = st.airlines.find((a) => a.code === st.preferred_airline);
  main().innerHTML = `<div class="head"><h1>🎫 Tickets to approve</h1><span class="pill yellow">Demo · mock booking</span></div>
    <p class="small mut tk-intro">Everyone whose next rotation leaves in ${30} days or less gets a proposed itinerary: home or alternate airport, ${pref ? `<b>${esc(pref.name)}</b> (company preferred)` : 'any airline'}, <b>${esc(st.cabins[st.default_cabin])}</b> on long-haul, cheapest sensible fare. You make the final call — <b>Confirm</b> and the assistant books it; the contractor gets the itinerary in the app and by email.</p>
    ${d.summary.pending ? `<div class="tk-bar static"><span class="tk-ic">🎫</span><b class="grow">${esc(d.summary.text)}</b></div>` : ''}
    <div class="row wrap tk-tabs">${[['pending', `Waiting (${d.counts.pending})`], ['done', `Confirmed / booked (${d.counts.confirmed + d.counts.booked})`], ['rejected', `Rejected (${d.counts.rejected})`]]
      .map(([k, t]) => `<button class="btn ${TKS.tab === k ? 'pri' : ''}" data-tab="${k}">${t}</button>`).join('')}</div>
    ${TKS.tab === 'pending' && d.tickets.length ? `<div class="row wrap tk-tools"><label class="row small tk-all"><input type="checkbox" id="tkAll"> Select all</label>
      <button class="btn pri" id="tkBulk" disabled>✓ Confirm selected (<span id="tkSelN">0</span>)</button><span class="small mut">RED travelers are skipped in bulk — open them to override.</span></div>` : ''}
    <div id="tkList">${d.tickets.map(card).join('') || `<p class="mut mt">${TKS.tab === 'pending' ? '✅ Nothing waiting — every rotation in the next 30 days has a ticket.' : 'Nothing here yet.'}</p>`}</div>
    <details class="card mt tk-set" id="tkSet"><summary><b>⚙️ Travel policy settings</b> <span class="small mut">default cabin, long-haul rule, company preferred airline</span></summary>
      <div class="grid2 mt"><div><label>Default cabin for long-haul flights</label><select id="tsCabin">${Object.entries(st.cabins).map(([k, v]) => `<option value="${k}" ${k === st.default_cabin ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        <div class="small mut">Long-haul = overseas, or more than the hours below. Shorter domestic hops stay in Economy.</div></div>
        <div><label>Long-haul threshold (hours)</label><input id="tsHours" type="number" min="2" max="16" value="${st.longhaul_hours}"></div>
        <div><label>Company preferred airline</label><select id="tsPref"><option value="">No preference (cheapest)</option>${st.airlines.map((a) => `<option value="${a.code}" ${a.code === st.preferred_airline ? 'selected' : ''}>${esc(a.name)}${a.first ? ' — sells First' : ' — Business only'}</option>`).join('')}</select>
        <div class="small mut">Company preferred list. Proposals and the booking assistant default to this airline.</div></div></div>
      <div class="note mt">💳 <b>Payment:</b> ${esc(st.notes.payment)}</div>
      <div class="note mt">🧪 <b>Booking:</b> ${esc(st.notes.booking)}</div>
      <button class="btn pri mt" id="tsSave">Save travel policy</button><span class="small mut"> New proposals use the new policy; existing ones keep their flight until you swap it.</span></details>`;
  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => { TKS.tab = b.dataset.tab; ticketsPage(); }));
  const syncSel = () => { const n = TKS.sel.size; if ($('#tkSelN')) { $('#tkSelN').textContent = n; $('#tkBulk').disabled = !n; } };
  $$('[data-sel]').forEach((c) => c.addEventListener('change', () => { const id = +c.dataset.sel; if (c.checked) TKS.sel.add(id); else TKS.sel.delete(id); c.closest('.tk').classList.toggle('picked', c.checked); syncSel(); }));
  $('#tkAll')?.addEventListener('change', (e) => { $$('[data-sel]').forEach((c) => { c.checked = e.target.checked; c.dispatchEvent(new Event('change')); }); });
  $('#tkBulk')?.addEventListener('click', () => confirmTickets([...TKS.sel], d.tickets));
  $$('[data-ok]').forEach((b) => b.addEventListener('click', () => confirmTickets([+b.dataset.ok], d.tickets)));
  $$('[data-swap]').forEach((b) => b.addEventListener('click', () => swapModal(+b.dataset.swap)));
  $$('[data-rej]').forEach((b) => b.addEventListener('click', () => rejectModal(+b.dataset.rej, d.tickets.find((t) => t.id === +b.dataset.rej))));
  $('#tsSave').addEventListener('click', () => guard(async () => {
    await api('PUT', '/api/admin/travel/settings', { default_cabin: $('#tsCabin').value, longhaul_hours: +$('#tsHours').value, preferred_airline: $('#tsPref').value });
    toast('Travel policy saved'); ticketsPage();
  }));
  syncSel(); tkBar();
  if (d.tickets.some((t) => t.status === 'confirmed')) setTimeout(() => { if (location.hash.startsWith('#/tickets')) ticketsPage(); }, 3000);
}
function card(t) {
  const f = t.fare; const pend = t.status === 'pending';
  return `<div class="card tk ${t.readiness}" data-tk="${t.id}">
    <div class="tk-top">${pend ? `<input type="checkbox" class="tk-cb" data-sel="${t.id}" aria-label="Select ${esc(t.contractor.name)}" ${TKS.sel.has(t.id) ? 'checked' : ''}>` : ''}
      ${av(t.contractor.id, 'lg')}<div class="grow"><a href="#/c/${t.contractor.id}" class="tk-name">${esc(t.contractor.name)}</a> ${pill(t.readiness)}
        <div class="small"><b class="${t.days_out <= 7 ? 'red-t' : ''}">${daysTxt(t.days_out)}</b> · rotation starts ${fdate(t.depart_date)} · ${esc(t.destination)}</div>
        ${t.issues.length ? `<div class="issues mt">${t.issues.slice(0, 3).map((i) => `<span class="pill ${i.status}">${esc(i.name)}</span>`).join('')}</div>` : ''}</div>
      <span class="pill ${ST_CLS[t.status]} tk-st">${esc(t.status_label)}</span></div>
    <div class="tk-trip"><div class="tk-route">🛫 <b>${routeTxt(f)}</b> ${f.origin !== t.contractor.home_airport ? '<span class="small mut">(alternate airport)</span>' : '<span class="small mut">(home)</span>'}</div>
      <div class="row wrap small">${cabinPill(f)}${prefPill(f)}<span><b>${esc(f.airline)}</b> · ${f.legs.map((l) => esc(l.flight_no)).join(' + ')} · ${legTimes(f)} · ${f.duration_h} h · ${f.refundable ? 'refundable' : 'non-refundable'}</span>
        <span class="tk-price">$${f.price_usd.toLocaleString()}</span></div>
      ${t.confirmation ? `<div class="small mt">Confirmation <b class="mono">${esc(t.confirmation)}</b> · confirmed by ${esc(t.confirmed_by || '')} ${t.confirmed_at ? localTime(t.confirmed_at) : ''}${t.status === 'booked' ? ' · ✅ contractor notified in app + itinerary emailed' : ''}${t.red_override ? ' · <span class="red-t">RED override</span>' : ''} · <span class="mut">mock booking</span></div>` : ''}
      ${t.status === 'confirmed' ? '<div class="small mt">⏳ Confirmed by admin → assistant is booking…</div>' : ''}
      ${t.status === 'rejected' ? `<div class="small mt">Rejected by ${esc(t.rejected_by)}${t.reject_reason ? ` — “${esc(t.reject_reason)}”` : ''}</div>` : ''}</div>
    ${pend ? `<div class="row wrap tk-act"><button class="btn pri" data-ok="${t.id}">✓ Confirm${t.readiness === 'red' ? ' (override)' : ''}</button><button class="btn" data-swap="${t.id}">⇄ Swap flight <span class="small mut">(${t.options})</span></button><button class="btn danger" data-rej="${t.id}">✕ Reject</button></div>` : ''}</div>`;
}
async function confirmTickets(ids, all) {
  const red = all.filter((t) => ids.includes(t.id) && t.readiness === 'red');
  let allow = false;
  if (ids.length === 1 && red.length) {
    allow = confirm(`${red[0].contractor.name} is RED — NOT cleared to travel (${red[0].issues.map((i) => i.name).join(', ')}).\n\nConfirm this ticket anyway? Your override is written to the audit log.`);
    if (!allow) return;
  } else if (ids.length > 1 && !confirm(`Confirm ${ids.length} tickets? The assistant books each one and sends the itinerary to the contractor.${red.length ? `\n\n${red.length} RED traveler(s) will be skipped.` : ''}`)) return;
  await guard(async () => {
    const r = await api('POST', '/api/admin/tickets/confirm', { ids, allow_red: allow });
    const ok = r.results.filter((x) => x.ok); const sk = r.results.filter((x) => !x.ok);
    toast(`✓ ${ok.length} confirmed → booking${sk.length ? ` · ${sk.length} skipped (${sk.map((x) => x.name).join(', ')})` : ''}`);
    TKS.sel.clear(); TKS.tab = 'done'; ticketsPage();
  });
}
async function swapModal(id) {
  const o = await api('GET', `/api/admin/tickets/${id}/options`); const cur = o.ticket.fare.id;
  modal(`<div class="row"><h2>⇄ Swap flight — ${esc(o.ticket.contractor.name)}</h2><button class="btn sm right" data-close>✕</button></div>
    <p class="small mut">Departs ${fdate(o.ticket.depart_date)} · ${esc(o.ticket.destination)} · demo fares. ★ = company preferred airline.</p>
    <div class="tk-opts">${o.options.map((f) => `<label class="fare tk-opt ${f.id === cur ? 'best' : ''}"><input type="radio" name="tkopt" value="${esc(f.id)}" ${f.id === cur ? 'checked' : ''}>
      <div class="grow"><b>${esc(f.airline)}</b>${f.preferred ? ' ★' : ''} ${cabinPill(f)}<div class="small mut">${routeTxt(f)} · ${f.legs.map((l) => esc(l.flight_no)).join(' + ')} · ${legTimes(f)} · ${f.duration_h} h${f.sensible ? '' : ' · long connection'}</div></div>
      <div class="price">$${f.price_usd.toLocaleString()}</div></label>`).join('')}</div>
    <div class="row mt"><button class="btn pri" id="swGo">Use this flight</button><button class="btn" data-close>Cancel</button></div>`, (m, close) => {
    $('#swGo', m).addEventListener('click', () => guard(async () => {
      const v = (m.querySelector('input[name=tkopt]:checked') || {}).value; if (!v) return;
      await api('PUT', `/api/admin/tickets/${id}/fare`, { fare_id: v }); close(); toast('Flight swapped — still waiting for your confirmation'); ticketsPage();
    }));
  });
}
function rejectModal(id, t) {
  modal(`<div class="row"><h2>✕ Reject ticket — ${esc(t.contractor.name)}</h2><button class="btn sm right" data-close>✕</button></div>
    <p class="small mut">No ticket is booked. The proposal won't come back for this departure date.</p>
    <label>Reason (optional, audit log)</label><input id="rjR" maxlength="300" placeholder="e.g. Booking through the client's travel desk">
    <div class="row mt"><button class="btn danger" id="rjGo">Reject</button><button class="btn" data-close>Cancel</button></div>`, (m, close) => {
    $('#rjGo', m).addEventListener('click', () => guard(async () => { await api('POST', `/api/admin/tickets/${id}/reject`, { reason: $('#rjR', m).value }); close(); toast('Rejected'); ticketsPage(); }));
  });
}
// Section for the Daily Deployment Report page (full and compact)
function tkReportCard(rep) {
  const q = rep.tickets_to_approve; if (!q) return '';
  return `<div class="card mt tk-rep" id="tkRep"><div class="row"><h2>🎫 Tickets to approve <span class="badge">${q.count}</span></h2><a class="btn sm right no-print" href="#/tickets">Open queue</a></div>
    <div class="small">${esc(q.headline)}</div>
    ${q.items.length ? `<div class="tk-rep-list">${q.items.map((t) => `<div class="tk-rep-row"><b>${esc(t.contractor)}</b> <span class="small mut">${esc(t.employee_no)}</span> ${pill(t.readiness)}
      <span class="small">${daysTxt(t.days_out)} · ${fdate(t.depart_date)} · ${esc(t.route)} · ${esc(t.airline)} ${esc(t.cabin)} · $${t.price_usd.toLocaleString()}</span></div>`).join('')}</div>` : ''}</div>`;
}

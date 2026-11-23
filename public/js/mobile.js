'use strict';
// Compact (phone) admin view. Default on screens < 768px; "Compact / Full view" toggle is remembered per device (localStorage).
const MOB = {
  KEY: 'ffd-admin-view',
  pref() { try { return localStorage.getItem(this.KEY); } catch { return null; } },
  on() { const p = this.pref(); return p ? p === 'compact' : window.innerWidth < 768; },
  set(v) { try { localStorage.setItem(this.KEY, v); } catch {} this.apply(); route(); },
  shown: 25, chip: '',
  apply() {
    const on = this.on(); document.body.classList.toggle('compact', on);
    $('#viewToggle').textContent = on ? '🖥 Full view' : '📱 Compact view';
    $('#viewToggle').setAttribute('aria-pressed', String(on));
  },
};
(function chrome() {
  const top = document.createElement('div'); top.id = 'mTop';
  top.innerHTML = '<img src="/icons/logo.png" alt=""><b data-brand="short">FFD</b><span class="mut small">Admin</span><span class="grow"></span>';
  const tg = document.createElement('button'); tg.id = 'viewToggle'; tg.className = 'btn sm'; tg.type = 'button';
  tg.addEventListener('click', () => MOB.set(MOB.on() ? 'full' : 'compact'));
  top.appendChild(tg); document.body.prepend(top);
  const tabs = document.createElement('nav'); tabs.id = 'mTabs';
  tabs.innerHTML = [['#/', 'dash', '🚦', 'Board'], ['#/schedule', 'schedule', '🗓️', 'Schedule'], ['#/report', 'report', '📋', 'Report'], ['#/map', 'map', '🗺️', 'Map'], ['#more', 'more', '☰', 'More']]
    .map(([h, n, i, t]) => `<a href="${h}" data-mtab="${n}"><span>${i}</span>${t}</a>`).join('');
  document.body.appendChild(tabs);
  tabs.querySelector('[data-mtab="more"]').addEventListener('click', (e) => { e.preventDefault();
    const links = [...$$('.side a[href^="#/"]')].filter((a) => !['#/', '#/schedule', '#/report', '#/map'].includes(a.getAttribute('href')));
    modal(`<div class="row"><h2>More</h2><button class="btn sm right" data-close>✕</button></div><div class="mmore">${links.map((a) => `<a href="${a.getAttribute('href')}" data-close>${esc(a.textContent)}</a>`).join('')}
      <a href="#" id="mReset">↺ Reset demo data</a><a href="#" id="mOut">↩︎ Sign out</a></div>`, (m, close) => {
      $$('a[href^="#/"]', m).forEach((a) => a.addEventListener('click', () => close()));
      $('#mReset', m).addEventListener('click', (ev) => { ev.preventDefault(); close(); $('#resetDemo').click(); });
      $('#mOut', m).addEventListener('click', (ev) => { ev.preventDefault(); logout(); });
    });
  });
  const hl = () => { const p = (location.hash.slice(2).split(/[/?]/)[0]) || 'dash'; $$('[data-mtab]').forEach((a) => a.classList.toggle('on', a.dataset.mtab === (p === 'c' ? 'dash' : p))); };
  window.addEventListener('hashchange', hl); hl();
  MOB.apply();
})();

const dot = (s) => `<span class="bigdot ${s}" aria-label="${esc(STATUS_TXT[s] || s)}"></span>`;
async function mDash() {
  const [{ contractors }, rep] = await Promise.all([api('GET', '/api/admin/contractors'), api('GET', '/api/admin/reports/daily?days=1').catch(() => ({ rows: [] }))]);
  const travel = new Set(rep.rows.map((r) => r.contractor.id));
  const n = (s) => contractors.filter((c) => c.status === s).length;
  const order = { red: 0, yellow: 1, green: 2 };
  const chips = [['red', `🔴 ${n('red')} no-go`], ['yellow', `🟡 ${n('yellow')} fix`], ['green', `🟢 ${n('green')} cleared`], ['travel', `✈️ ${travel.size} traveling today`]];
  main().innerHTML = `<div class="m-head"><h1>Readiness</h1><span class="mut">${contractors.length} crew · ${contractors.filter((c) => c.on_now).length} on rotation</span></div>
    <div class="chips">${chips.map(([k, t]) => `<button class="chip ${k} ${MOB.chip === k ? 'on' : ''}" data-chip="${k}">${t}</button>`).join('')}</div>
    <input id="mq" class="m-search" type="search" placeholder="Search name or employee #" value="${esc(A.filter.q)}">
    <div id="mCards"></div>`;
  const draw = () => {
    const q = A.filter.q.toLowerCase();
    const list = contractors.filter((c) => (!MOB.chip || (MOB.chip === 'travel' ? travel.has(c.id) : c.status === MOB.chip)) && (!q || c.name.toLowerCase().includes(q) || c.employee_no.toLowerCase().includes(q)))
      .sort((a, b) => order[a.status] - order[b.status] || (a.days_to_deploy - b.days_to_deploy));
    const show = list.slice(0, MOB.shown);
    $('#mCards').innerHTML = show.map((c) => `<a class="mcard ${c.status}" href="#/c/${c.id}">${av(c.id, 'lg')}<div class="mc-body"><div class="mc-name">${esc(c.name)}${c.swing ? ' <span class="pill blue">SWING</span>' : ''}</div>
        <div class="mc-sub">${esc(c.title || '—')}</div><div class="mc-sub">${esc((c.destination || '').split(',')[0])} · ${c.on_now ? 'on rotation' : c.days_to_deploy > 0 ? `deploys in ${c.days_to_deploy} d` : 'off'}${travel.has(c.id) ? ' · ✈️ today' : ''}</div>
        ${c.issues.length ? `<div class="mc-iss">${c.issues.slice(0, 2).map((i) => `<span class="pill ${i.status}">${esc(i.name)}</span>`).join('')}${c.issues.length > 2 ? ` <span class="mut small">+${c.issues.length - 2}</span>` : ''}</div>` : ''}</div>${dot(c.status)}</a>`).join('')
      + (list.length > show.length ? `<button class="btn block mt" id="mMore">Show ${Math.min(25, list.length - show.length)} more (${list.length - show.length} left)</button>` : '')
      + (list.length ? '' : '<p class="mut center mt">No matches</p>');
    $('#mMore')?.addEventListener('click', () => { MOB.shown += 25; draw(); });
  };
  draw();
  $$('[data-chip]').forEach((b) => b.addEventListener('click', () => { MOB.chip = MOB.chip === b.dataset.chip ? '' : b.dataset.chip; MOB.shown = 25; mDash(); }));
  $('#mq').addEventListener('input', (e) => { A.filter.q = e.target.value; MOB.shown = 25; draw(); });
}
async function mDetail(id) {
  const d = await api('GET', `/api/admin/contractors/${id}`); const c = d.contractor; const r = d.readiness; const p = d.profile || {}; const pe = p.personal || {}; const md = p.medical || {};
  if (!A.dests) await loadDests(); const site = A.dests.destinations.find((x) => x.id === c.destination_id);
  const sec = (k, title, body, open) => `<details class="msec" ${open ? 'open' : ''}><summary>${title}</summary><div class="msec-b">${body}</div></details>`;
  const t = new Date().toISOString().slice(0, 10);
  main().innerHTML = `<a class="m-back" href="#/">‹ Board</a>
    <div class="m-prof ${r.status}"><img class="m-photo" src="/api/headshot/${c.id}" alt="Headshot of ${esc(c.name)}">
      <h1>${esc(c.name)}</h1><div class="mut">${esc(c.title || '—')} · ${esc(c.employee_no)}</div><div class="mt">${pill(r.status)}${c.swing ? ' <span class="pill blue">SWING</span>' : ''}</div>
      <div class="m-kv"><span>Site</span><b>${esc(site ? site.name : '—')}</b><span>Rotation</span><b>${fdate(r.rotation.start)} → ${fdate(r.rotation.end)}</b><span>Next</span><b>${fdate(r.rotation.next_start)}</b><span>Home</span><b>${esc(c.home_airport || '—')}${c.alt_airport ? ` / ${esc(c.alt_airport)}` : ''}</b></div>
      <div class="row m-act">${pe.phone || c.phone ? `<a class="btn" href="tel:${esc((pe.phone || c.phone).replace(/[^0-9+]/g, ''))}">📞 Call</a>` : ''}<a class="btn" href="#/c/${c.id}/badge" data-full>🪪 Badge</a><a class="btn" href="#/c/${c.id}/account" data-full>🔑 Login</a></div></div>
    ${r.status !== 'green' ? `<div class="card m-fix"><b>What to fix</b>${r.items.filter((i) => i.status !== 'green').map((i) => `<div class="m-li">${dot(i.status)}<div><b>${esc(i.name)}</b><div class="small">${esc(i.message || '')}</div></div></div>`).join('')}${r.blockers.map((b) => `<div class="m-li">${dot('red')}<div><b>${esc(b.description)}</b></div></div>`).join('')}${r.fix_by ? `<div class="small mut mt">Fix by ${fdate(r.fix_by)}</div>` : ''}</div>` : ''}
    ${sec('docs', `📄 Documents <span class="mut">(${r.items.length})</span>`, r.items.map((i) => `<div class="m-li">${dot(i.status)}<div><b>${esc(i.name)}</b><div class="small">${esc(i.message || '')}${i.document && i.document.ref_last4 ? ` · •••• ${esc(i.document.ref_last4)}` : ''}</div></div></div>`).join(''), r.status !== 'green')}
    ${sec('fl', `✈️ Flights <span class="mut">(${d.flights.length})</span>`, d.flights.slice().reverse().map((f) => `<div class="m-li"><span class="m-ic">${f.depart_at.slice(0, 10) >= t ? '🛫' : '✔︎'}</span><div><b>${esc(f.airline)} ${esc(f.flight_no)}</b> · ${esc(f.from_airport)} → ${esc(f.to_airport)}<div class="small">${fdt(f.depart_at)} · ${esc(f.confirmation || '')}${f.seat ? ` · seat ${esc(f.seat)}` : ''}</div></div></div>`).join('') || '<p class="mut">No flights.</p>')}
    ${sec('ct', '☎️ Contacts', `<div class="m-li"><span class="m-ic">👤</span><div><b>${esc(pe.phone || c.phone || '—')}</b><div class="small">${esc(pe.email || c.email || '')}</div></div></div>`
      + (p.emergency_contacts || []).map((e, i) => `<div class="m-li"><span class="m-ic">${i ? '☎️' : '🚨'}</span><div><b>${esc(e.name)}</b> <span class="mut">(${esc(e.relationship)}${i ? '' : ', primary'})</span><div class="small"><a href="tel:${esc(String(e.phone).replace(/[^0-9+]/g, ''))}">${esc(e.phone)}</a>${e.email ? ` · ${esc(e.email)}` : ''}</div></div></div>`).join(''))}
    ${sec('med', '🩺 Medical <span class="mut">(confidential)</span>', `<div class="m-kv"><span>Blood type</span><b>${esc(md.blood_type || '—')}</b><span>Allergies</span><b>${esc(md.allergies || '—')}</b><span>Conditions</span><b>${esc(md.conditions || '—')}</b>
      <span>Medications</span><b>${esc((p.medications || []).map((m) => `${m.name} ${m.dose}`).join(', ') || 'None')}</b><span>Physical</span><b>${p.physical && p.physical.expires ? `valid to ${fdate(p.physical.expires)}` : '—'}</b></div>`)}
    ${sec('sch', '🗓️ Schedule', d.schedule.filter((b) => b.end >= t).slice(0, 8).map((b) => `<div class="m-li"><span class="m-ic">${{ on: '🟩', off: '⬜', travel: '✈️', training: '🎓', leave: '🌴' }[b.kind] || '•'}</span><div><b>${esc(b.kind.toUpperCase())}</b> ${fdate(b.start)} → ${fdate(b.end)}<div class="small">${esc(b.notes || '')}</div></div></div>`).join('') || '<p class="mut">Nothing scheduled.</p>')}
    <button class="btn block mt" id="mFull">Open full profile (all tabs)</button>`;
  const full = () => { try { localStorage.setItem(MOB.KEY, 'full'); } catch {} MOB.apply(); };
  $$('[data-full]', main()).forEach((a) => a.addEventListener('click', full));
  $('#mFull').addEventListener('click', () => { full(); route(); });
}
async function mSchedule() {
  const t = new Date(); const from = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const [d, crew] = await Promise.all([api('GET', `/api/admin/schedule?from=${from}&days=31&per=500`), api('GET', '/api/admin/crew')]);
  const ev = [];
  for (const c of d.contractors) for (const b of c.blocks) {
    if (b.kind === 'on' && b.start >= from) ev.push({ date: b.start, c, txt: `starts ON · ${(d.destinations.find((x) => x.id === b.destination_id) || {}).name || ''}`, ic: '🛫' });
    if (b.kind === 'on' && b.end >= from && b.end <= d.to) ev.push({ date: b.end, c, txt: 'rotation ends', ic: '🏠' });
    if (['training', 'leave'].includes(b.kind) && b.start >= from) ev.push({ date: b.start, c, txt: `${b.kind} → ${fdate(b.end)}`, ic: b.kind === 'leave' ? '🌴' : '🎓' });
  }
  ev.sort((a, b) => a.date.localeCompare(b.date));
  const byDay = {}; ev.forEach((e) => (byDay[e.date] = byDay[e.date] || []).push(e));
  main().innerHTML = `<div class="m-head"><h1>Schedule</h1><span class="mut">next 31 days</span></div>
    <div class="card"><b>Coverage today</b>${crew.sites.map((s) => `<div class="m-li">${dot(s.short ? 'red' : 'green')}<div><b>${esc(s.name)}</b> <span class="${s.short ? 'red-t' : ''}">${s.on} / ${s.target}</span>
      <div class="small">${s.next_gap ? `Gap ${fdate(s.next_gap.start)} → ${fdate(s.next_gap.end)} (short ${s.next_gap.short})` : 'No gap in 90 days'}</div></div></div>`).join('')}
      <a class="btn block mt" href="#/crew">👥 Crew &amp; swing assignments</a></div>
    ${d.conflicts.length ? `<div class="card m-fix"><b>⚠️ Conflicts (${d.conflicts.length})</b>${d.conflicts.slice(0, 8).map((x) => `<div class="m-li">${dot(x.status || 'red')}<div><b>${esc(x.name || '')}</b><div class="small">${esc(x.message || x.reason || '')}</div></div></div>`).join('')}</div>` : ''}
    ${Object.entries(byDay).map(([day, list]) => `<h3 class="m-day">${fdate(day)}</h3>${list.map((e) => `<a class="mrow" href="#/c/${e.c.id}">${av(e.c.id)}<div><b>${esc(e.c.name)}</b><div class="small">${e.ic} ${esc(e.txt)}</div></div>${dot(e.c.status)}</a>`).join('')}`).join('') || '<p class="mut">No changes in the next 31 days.</p>'}`;
}
async function mReport() {
  const r = await api('GET', '/api/admin/reports/daily?days=9'); const s = r.summary;
  const byDay = {}; r.rows.forEach((x) => (byDay[x.date] = byDay[x.date] || []).push(x));
  main().innerHTML = `<div class="m-head"><h1>Deployment report</h1><span class="mut">${fdate(r.from)} → ${fdate(r.to)}</span></div>
    <div class="chips"><span class="chip">🛫 ${s.departing} departing</span><span class="chip">🏠 ${s.returning} returning</span><span class="chip red">⚑ ${s.flagged} flagged</span></div>
    ${Object.entries(byDay).map(([day, rows]) => `<h3 class="m-day">${fdate(day)}</h3>${rows.map((x) => `<div class="card mrep ${x.status}"><div class="row">${av(x.contractor.id)}<div><b>${esc(x.contractor.name)}</b><div class="small">${x.direction === 'outbound' ? '🛫 to' : '🏠 home from'} ${esc((x.destination || '').split(',')[0])} · ${esc(x.contractor.title || '')}</div></div>${dot(x.status)}</div>
      ${x.legs.length ? x.legs.map((l) => `<div class="m-leg"><b>${esc(l.flight_no)}</b> ${esc(l.from)} → ${esc(l.to)} <span class="mut">${esc(l.depart_local.slice(11))} → ${esc(l.arrive_local.slice(11))}</span>${l.seat ? ` · ${esc(l.seat)}` : ''}</div>`).join('') : '<div class="m-leg red-t">No flight booked</div>'}
      ${x.flags.length ? `<div class="mc-iss">${x.flags.map((f) => `<span class="pill ${f.code === 'status_yellow' ? 'yellow' : 'red'}">${esc(f.label)}</span>`).join('')}</div>` : ''}
      ${x.emergency_contact ? `<div class="small mut">EC: ${esc(x.emergency_contact.name)} · <a href="tel:${esc(String(x.emergency_contact.phone).replace(/[^0-9+]/g, ''))}">${esc(x.emergency_contact.phone)}</a></div>` : ''}</div>`).join('')}`).join('') || '<p class="mut">No departures or returns.</p>'}
    <a class="btn block mt" href="/api/admin/reports/daily.csv?days=9">⬇ CSV</a>`;
}
// Swap in the compact renderers when compact view is on (full view is untouched)
{
  MOB.orig = { dash: window.dash, detail: window.detail, schedulePage: window.schedulePage, reportPage: window.reportPage };
  const W = (orig, alt) => function (...a) { if (MOB.on()) { window.scrollTo(0, 0); return alt(...a); } return orig(...a); };
  window.dash = W(window.dash, mDash);
  window.detail = W(window.detail, (id, sub) => (sub && sub !== 'readiness' ? MOB.orig.detail(id, sub) : mDetail(id)));
  window.schedulePage = W(window.schedulePage, mSchedule);
  window.reportPage = W(window.reportPage, (qs) => (qs ? MOB.orig.reportPage(qs) : mReport()));
}

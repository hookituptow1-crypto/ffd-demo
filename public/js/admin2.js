'use strict';
// Admin: Daily Deployment Report, Crew Schedule (Gantt + coverage + conflicts), Titles settings. Loaded after admin.js.
const av = (id, cls = '') => `<img class="av ${cls}" src="/api/headshot/${id}" alt="" loading="lazy">`;
const isoAdd = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const dayName = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const titleOpts = (titles, sel, blank = 'All titles') => `<option value="">${blank}</option>${titles.map((t) => `<option value="${t.id}" ${String(sel) === String(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}`;
async function getTitles() { A.titles = A.titles || (await api('GET', '/api/admin/titles')).titles; return A.titles; }

// ---------------- Daily Deployment Report ----------------
const FLAG_CLS = { status_red: 'red', status_yellow: 'yellow', no_flight: 'red', changed_24h: 'blue' };
const FLAG_ICON = { status_red: '🔴', status_yellow: '🟡', no_flight: '⚠️', changed_24h: '🔄' };
async function reportPage(qs) {
  const q = new URLSearchParams(qs || ''); const titles = await getTitles();
  const today = (await api('GET', '/api/admin/reports/daily?days=1')).from;
  const mode = q.get('date') ? 'day' : 'week'; const from = q.get('date') || today; const days = mode === 'day' ? 1 : 9; const tf = q.get('title') || '';
  const rep = await api('GET', `/api/admin/reports/daily?date=${from}&days=${days}`);
  const rows = rep.rows.filter((r) => !tf || r.contractor.title === (titles.find((t) => String(t.id) === tf) || {}).name);
  const S = { departing: rows.filter((r) => r.direction === 'outbound').length, returning: rows.filter((r) => r.direction === 'return').length, flagged: rows.filter((r) => r.flags.length).length,
    rt: rows.filter((r) => r.status === 'red').length, yt: rows.filter((r) => r.status === 'yellow').length, nf: rows.filter((r) => r.flags.some((f) => f.code === 'no_flight')).length, ch: rows.filter((r) => r.flags.some((f) => f.code === 'changed_24h')).length };
  const groups = [];
  if (mode === 'day') groups.push([from === today ? `Today — ${dayName(from)}` : dayName(from), [from]]);
  else { groups.push([`Today — ${dayName(today)}`, [today]]); groups.push([`Tomorrow — ${dayName(isoAdd(today, 1))}`, [isoAdd(today, 1)]]);
    groups.push([`Next 7 days — ${dayName(isoAdd(today, 2))} to ${dayName(isoAdd(today, 8))}`, [...Array(7)].map((_, i) => isoAdd(today, i + 2))]); }
  const leg = (l) => `<div class="leg"><b>${esc(l.airline)} ${esc(l.flight_no)}</b> ${esc(l.from)} <span class="mut">${esc(l.depart_local.slice(5).replace('T', ' '))}</span> → ${esc(l.to)} <span class="mut">${esc((l.arrive_local || '').slice(5).replace('T', ' '))}</span>${l.seat ? ` · seat ${esc(l.seat)}` : ''}</div>`;
  const rowHtml = (r, i) => `<tr class="${r.flags.length ? 'flagged' : ''}"><td><div class="nm">${av(r.contractor.id)}<div><a href="#/c/${r.contractor.id}"><b>${esc(r.contractor.name)}</b></a><div class="small mut">${esc(r.contractor.title || '—')} · ${esc(r.contractor.employee_no)}</div></div></div></td>
    <td>${pill(r.status)}</td><td>${r.direction === 'outbound' ? '🛫 Outbound' : '🛬 Return'}<div class="small mut">${esc(r.destination)}</div></td>
    <td class="small">${r.legs.length ? `${r.legs.map(leg).join('')}<div class="mut">PNR <b>${esc(r.confirmation || '—')}</b>${r.connections.length ? ` · via ${esc(r.connections.join(', '))}` : ' · nonstop'} · local times</div>` : '<span class="pill red">No flight booked</span>'}</td>
    <td>${esc(r.home_airport || '—')}${r.alt_airport ? `<div class="small mut">alt ${esc(r.alt_airport)}</div>` : ''}</td>
    <td><button class="btn sm ec-btn" data-ec="${i}" title="Emergency contact">☎️</button><div class="print-only small">${r.emergency_contact ? `${esc(r.emergency_contact.name)} ${esc(r.emergency_contact.phone)}` : '—'}</div></td>
    <td>${r.flags.map((f) => `<span class="pill ${FLAG_CLS[f.code]}">${FLAG_ICON[f.code]} ${esc(f.label)}</span>`).join(' ') || '<span class="mut small">—</span>'}</td></tr>`;
  main().innerHTML = `<div class="head"><h1>📋 Daily Deployment Report</h1><span class="mut small">Generated ${new Date(rep.generated_at).toLocaleString()} </span></div>
    <div class="row wrap mb no-print"><button class="btn ${mode === 'week' ? 'pri' : ''}" data-go="">Today + next 8 days</button><button class="btn ${mode === 'day' && from === today ? 'pri' : ''}" data-go="${today}">Today</button>
      <button class="btn ${mode === 'day' && from === isoAdd(today, 1) ? 'pri' : ''}" data-go="${isoAdd(today, 1)}">Tomorrow</button>
      <label class="small">Any day</label><input type="date" class="wauto" id="rDate" value="${mode === 'day' ? from : ''}"><select id="rTitle" class="wauto">${titleOpts(titles, tf)}</select>
      <span class="right row"><button class="btn" id="rCsv">⬇️ CSV</button><button class="btn" id="rPrint">🖨️ Print / Save PDF</button></span></div>
    <div class="print-only"><h2>FFD — Daily Deployment Report · ${mode === 'day' ? dayName(from) : `${dayName(today)} – ${dayName(isoAdd(today, 8))}`}</h2></div>
    <div class="tiles rtiles"><div class="tile"><div class="mut small">🛫 DEPARTING</div><div class="n">${S.departing}</div></div><div class="tile"><div class="mut small">🛬 RETURNING</div><div class="n">${S.returning}</div></div>
      <div class="tile red"><div class="mut small">⚑ FLAGGED</div><div class="n">${S.flagged}</div></div><div class="tile"><div class="mut small">🔴 RED TRAVELING</div><div class="n">${S.rt}</div></div>
      <div class="tile"><div class="mut small">🟡 YELLOW TRAVELING</div><div class="n">${S.yt}</div></div><div class="tile"><div class="mut small">⚠️ NO FLIGHT</div><div class="n">${S.nf}</div></div><div class="tile"><div class="mut small">🔄 CHANGED &lt;24H</div><div class="n">${S.ch}</div></div></div>
    ${typeof tkReportCard === 'function' ? tkReportCard(rep) : ''}
    ${groups.map(([label, dates]) => { const g = rows.filter((r) => dates.includes(r.date)); return `<div class="card mt rgroup"><h2>${esc(label)} <span class="mut small">${g.length} movement${g.length === 1 ? '' : 's'}</span></h2>
      ${g.length ? `<table class="mt rtable"><thead><tr><th>Contractor</th><th>Readiness</th><th>Direction / site</th><th>Flights (local times)</th><th>Home</th><th>EC</th><th>Flags</th></tr></thead><tbody>
      ${dates.map((d) => { const dr = g.filter((r) => r.date === d); return dr.length ? `${dates.length > 1 ? `<tr class="dsub"><td colspan="7">${dayName(d)}</td></tr>` : ''}${dr.map((r) => rowHtml(r, rows.indexOf(r))).join('')}` : ''; }).join('')}</tbody></table>` : '<p class="small mut">No departures or returns.</p>'}</div>`; }).join('')}`;
  const nav = (date) => { const p = new URLSearchParams(); if (date) p.set('date', date); if ($('#rTitle').value) p.set('title', $('#rTitle').value); location.hash = `#/report${p.toString() ? `?${p}` : ''}`; };
  $$('[data-go]').forEach((b) => b.addEventListener('click', () => nav(b.dataset.go)));
  $('#rDate').addEventListener('change', (e) => e.target.value && nav(e.target.value));
  $('#rTitle').addEventListener('change', () => nav(mode === 'day' ? from : ''));
  $('#rPrint').addEventListener('click', () => window.print());
  $('#rCsv').addEventListener('click', () => { location.href = `/api/admin/reports/daily.csv?date=${from}&days=${days}`; });
  $$('[data-ec]').forEach((b) => b.addEventListener('click', () => { const r = rows[+b.dataset.ec]; const e = r.emergency_contact;
    modal(`<div class="row"><h2>☎️ Emergency contact — ${esc(r.contractor.name)}</h2><button class="btn sm right" data-close>✕</button></div>${e ? `<p><b>${esc(e.name)}</b> · ${esc(e.relationship)}</p>
      <p>📱 <a href="tel:${esc(e.phone)}">${esc(e.phone)}</a>${e.alt_phone ? ` · ☎ ${esc(e.alt_phone)}` : ''}</p>${e.email ? `<p>✉ ${esc(e.email)}</p>` : ''}` : '<p>⚠️ No emergency contact on file.</p>'}`); }));
}

// ---------------- Crew schedule ----------------
const KIND = { on: 'ON', off: 'OFF', travel: 'Travel', training: 'Training', leave: 'Leave' };
const SITE_COL = ['#4f7a2b', '#2b6d7a', '#7a5a2b', '#5a2b7a', '#2b7a52', '#7a2b45'];
const DW = 16; // px per day
async function schedulePage(qs) {
  const q = new URLSearchParams(qs || ''); if (!A.dests) await loadDests();
  const p = new URLSearchParams(); ['from', 'title', 'site', 'crew', 'page'].forEach((k) => { if (q.get(k)) p.set(k, q.get(k)); });
  const go = (k, v) => { const np = new URLSearchParams(p); if (v === '' || v === null) np.delete(k); else np.set(k, v); if (k !== 'page') np.delete('page'); location.hash = `#/schedule?${np}`; };
  const d = await api('GET', `/api/admin/schedule?${p}`); const from = d.from; const N = d.days;
  const siteIdx = Object.fromEntries(d.destinations.map((x, i) => [x.id, i])); const siteName = Object.fromEntries(d.destinations.map((x) => [x.id, x.name]));
  const off = (iso) => Math.round((Date.parse(iso) - Date.parse(from)) / 86400000);
  const conflictBlocks = new Set(d.conflicts.map((c) => c.block_id));
  const months = []; for (let i = 0; i < N; i++) { const iso = isoAdd(from, i); if (i === 0 || iso.endsWith('-01')) months.push([i, new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })]); }
  const tIdx = off(d.today);
  const blockHtml = (b) => {
    const s = Math.max(0, off(b.start)); const e = Math.min(N - 1, off(b.end)); if (e < s) return '';
    const bg = b.kind === 'on' ? SITE_COL[siteIdx[b.destination_id] % SITE_COL.length] : '';
    const lab = b.kind === 'on' ? `${(siteName[b.destination_id] || '').split(',')[0]}` : KIND[b.kind];
    const travel = b.kind === 'on' ? [b.start, b.end].filter((x) => off(x) >= 0 && off(x) < N).map((x) => `<div class="g-trav" data-style="left:${(off(x) - s) * DW}px" title="Travel day ${x}">✈</div>`).join('') : '';
    return `<div class="g-blk k-${b.kind} ${conflictBlocks.has(b.id) ? 'conflict' : ''}" data-b="${b.id}" data-style="left:${s * DW}px;width:${(e - s + 1) * DW - 2}px;${bg ? `background:${bg}` : ''}" title="${esc(`${KIND[b.kind]} ${lab ? `· ${lab} ` : ''}${b.start} → ${b.end}${b.notes ? ` · ${b.notes}` : ''}`)}"><span>${esc(lab)}</span>${travel}</div>`;
  };
  const W = N * DW;
  main().innerHTML = `<div class="head"><h1>🗓️ Crew schedule</h1><span class="mut small">${fdate(d.from)} → ${fdate(d.to)}</span>
      <div class="right row"><button class="btn" data-mv="-1">◀ Month</button><button class="btn" data-mv="0">This month</button><button class="btn" data-mv="1">Month ▶</button>
      <select id="sTitle" class="wauto">${titleOpts(d.titles, q.get('title'))}</select>
      <select id="sSite" class="wauto"><option value="">All sites</option>${d.destinations.map((x) => `<option value="${x.id}" ${String(x.id) === q.get('site') ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <select id="sCrew" class="wauto">${[['', 'All crew'], ['on', 'On rotation in view'], ['off', 'Off in view'], ['swing', 'Swing / fill-in']].map(([v, t]) => `<option value="${v}" ${(q.get('crew') || '') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div></div>
    <div class="pager mb"><span class="small mut">${d.total} people · showing ${d.total ? d.page * d.per + 1 : 0}–${d.page * d.per + d.contractors.length}</span>${d.pages > 1 ? `<button class="btn sm" id="sgP" ${d.page ? '' : 'disabled'}>‹ Prev</button><span class="small">Page ${d.page + 1} / ${d.pages}</span><button class="btn sm" id="sgN" ${d.page < d.pages - 1 ? '' : 'disabled'}>Next ›</button>` : ''}</div>
    <div class="legend small mb">${d.destinations.map((x, i) => `<span><i data-style="background:${SITE_COL[i % SITE_COL.length]}"></i>ON · ${esc(x.name)}</span>`).join('')}<span><i class="k-off"></i>OFF</span><span><i class="k-travel"></i>✈ Travel day</span><span><i class="k-training"></i>Training</span><span><i class="k-leave"></i>Leave</span><span><i class="conflict"></i>Readiness conflict</span>
      <span class="mut">Drag a block to move it · click a block to edit · click an empty day to add</span></div>
    <div class="card gantt-card"><div class="gantt"><div class="g-names"><div class="g-hd">Contractor</div>${d.contractors.map((c) => `<div class="g-name"><div class="nm">${av(c.id)}<div><a href="#/c/${c.id}"><b>${esc(c.name)}</b></a> <span class="dot ${c.status}"></span><div class="small mut">${esc(c.title || '—')} · ${c.rotation_on}/${c.rotation_off}</div></div><button class="btn sm right" data-gen="${c.id}" title="Rotation pattern">⚙</button></div></div>`).join('')}
        <div class="g-hd2">Coverage (ON headcount vs target)</div>${d.coverage.map((s) => `<div class="g-name cov-name"><div><b>${esc(s.site)}</b><div class="small mut">min ${s.min}${s.max ? ` · max ${s.max}` : ''} ${s.gap_days ? `· <span class="pill red">${s.gap_days}d gap</span>` : ''}${s.over_days ? ` <span class="pill yellow">${s.over_days}d over</span>` : ''}</div></div><button class="btn sm right" data-tg="${s.site_id}">Targets</button></div>`).join('')}</div>
      <div class="g-scroll" id="gScroll"><div data-style="width:${W}px;position:relative">
        <div class="g-hd g-months">${months.map(([i, m]) => `<span data-style="left:${i * DW}px">${m}</span>`).join('')}<div class="g-days">${[...Array(N)].map((_, i) => { const iso = isoAdd(from, i); return `<i class="${i === tIdx ? 'today' : ''}">${+iso.slice(8)}</i>`; }).join('')}</div></div>
        ${d.contractors.map((c) => `<div class="g-row" data-c="${c.id}">${c.blocks.map(blockHtml).join('')}</div>`).join('')}
        <div class="g-hd2"></div>
        ${d.coverage.map((s) => `<div class="g-row cov">${s.days.map((x, i) => `<div class="cov-c ${x.state}" data-style="left:${i * DW}px" title="${esc(`${x.date}: ${x.headcount} on site${x.who.length ? ` — ${x.who.join(', ')}` : ''}`)}">${x.headcount}</div>`).join('')}</div>`).join('')}
        ${tIdx >= 0 && tIdx < N ? `<div class="g-today" data-style="left:${tIdx * DW + DW / 2}px"></div>` : ''}
      </div></div></div></div>
    <div class="cols mt"><div class="card"><h2>⚠️ Readiness conflicts (${d.conflicts.length})</h2>${d.conflicts.map((c) => `<div class="alert-item"><div class="t">${pill(c.status)} <a href="#/c/${c.contractor_id}"><b>${esc(c.name)}</b></a> <span class="mut small">${fdate(c.start)} → ${fdate(c.end)}</span></div><div class="small">${esc(c.reason)}</div></div>`).join('') || '<p class="small mut">None — everyone scheduled is ready.</p>'}</div>
      <div class="card"><h2>📉 Coverage gaps &amp; overstaffing</h2>${d.coverage.filter((s) => s.gap_days || s.over_days).map((s) => { const runs = []; let cur = null; s.days.forEach((x) => { if (x.state !== 'ok') { if (cur && cur.state === x.state) cur.to = x.date; else { cur = { state: x.state, from: x.date, to: x.date, n: x.headcount }; runs.push(cur); } } else cur = null; });
        return runs.map((r) => `<div class="alert-item"><div class="t"><span class="pill ${r.state === 'gap' ? 'red' : 'yellow'}">${r.state === 'gap' ? 'GAP' : 'OVER'}</span> <b>${esc(s.site)}</b> <span class="small mut">${fdate(r.from)} → ${fdate(r.to)}</span></div><div class="small">${r.state === 'gap' ? `Below minimum of ${s.min}` : `Above maximum of ${s.max}`} (e.g. ${r.n} on site)</div></div>`).join(''); }).join('') || '<p class="small mut">All sites within target.</p>'}</div></div>`;
  const sc = $('#gScroll'); if (tIdx > 10) sc.scrollLeft = (tIdx - 7) * DW;
  const reload = () => schedulePage(qs);
  $$('[data-mv]').forEach((b) => b.addEventListener('click', () => { const mv = +b.dataset.mv; let f = d.today.slice(0, 8) + '01';
    if (mv) { const dt = new Date(Date.parse(from)); dt.setUTCMonth(dt.getUTCMonth() + mv); f = dt.toISOString().slice(0, 10); }
    const np = new URLSearchParams(p); np.set('from', f); location.hash = `#/schedule?${np}`; }));
  $('#sTitle').addEventListener('change', (e) => go('title', e.target.value));
  $('#sSite').addEventListener('change', (e) => go('site', e.target.value)); $('#sCrew').addEventListener('change', (e) => go('crew', e.target.value));
  $('#sgP')?.addEventListener('click', () => go('page', d.page - 1)); $('#sgN')?.addEventListener('click', () => go('page', d.page + 1));
  const allBlocks = Object.fromEntries(d.contractors.flatMap((c) => c.blocks.map((b) => [b.id, { ...b, cname: c.name }])));
  // drag to move (snaps to whole days); a click without movement opens the editor
  $$('.g-blk').forEach((el) => {
    let st = null;
    el.addEventListener('pointerdown', (e) => { st = { x: e.clientX, left: parseFloat(el.style.left), moved: false }; el.setPointerCapture(e.pointerId); e.stopPropagation(); });
    el.addEventListener('pointermove', (e) => { if (!st) return; const dx = e.clientX - st.x; if (Math.abs(dx) > 4) st.moved = true; if (st.moved) el.style.left = `${st.left + Math.round(dx / DW) * DW}px`; });
    el.addEventListener('pointerup', (e) => { if (!st) return; const shift = Math.round((e.clientX - st.x) / DW); const moved = st.moved; st = null;
      const b = allBlocks[el.dataset.b];
      if (!moved) return blockModal(b, d, reload);
      if (!shift) return;
      guard(async () => { try { await api('PUT', `/api/admin/schedule/blocks/${b.id}`, { start: isoAdd(b.start, shift), end: isoAdd(b.end, shift) }); toast(`Moved ${shift > 0 ? '+' : ''}${shift}d — ${b.cname} alerted`); } finally { reload(); } }); });
  });
  $$('.g-row[data-c]').forEach((row) => row.addEventListener('click', (e) => { if (e.target.closest('.g-blk')) return; const rect = row.getBoundingClientRect(); const i = Math.floor((e.clientX - rect.left) / DW);
    blockModal({ contractor_id: +row.dataset.c, kind: 'training', start: isoAdd(from, i), end: isoAdd(from, i), cname: d.contractors.find((c) => c.id === +row.dataset.c).name }, d, reload); }));
  $$('[data-gen]').forEach((b) => b.addEventListener('click', () => genModal(d.contractors.find((c) => c.id === +b.dataset.gen), d, reload)));
  $$('[data-tg]').forEach((b) => b.addEventListener('click', () => { const s = d.destinations.find((x) => x.id === +b.dataset.tg);
    modal(`<div class="row"><h2>Coverage targets — ${esc(s.name)}</h2><button class="btn sm right" data-close>✕</button></div><div class="grid2"><div><label>Minimum on site</label><input id="tMin" type="number" min="0" value="${s.min_headcount || 0}"></div><div><label>Maximum (optional)</label><input id="tMax" type="number" min="1" value="${s.max_headcount ?? ''}"></div></div><button class="btn pri mt" id="tSave">Save</button>`,
      (m, close) => $('#tSave', m).addEventListener('click', () => guard(async () => { await api('PUT', `/api/admin/destinations/${s.id}/targets`, { min: +$('#tMin', m).value, max: $('#tMax', m).value }); close(); reload(); }))); }));
}
function blockModal(b, d, reload) {
  modal(`<div class="row"><h2>${b.id ? 'Edit' : 'Add'} schedule block — ${esc(b.cname)}</h2><button class="btn sm right" data-close>✕</button></div>
    <div class="grid2"><div><label>Type</label><select id="bK">${Object.entries(KIND).map(([k, v]) => `<option value="${k}" ${k === b.kind ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div><label>Site (ON only)</label><select id="bD"><option value="">—</option>${d.destinations.map((x) => `<option value="${x.id}" ${x.id === b.destination_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div><label>Start</label><input id="bS" type="date" value="${esc(b.start)}"></div><div><label>End (inclusive)</label><input id="bE" type="date" value="${esc(b.end)}"></div></div>
    <label>Notes</label><input id="bN" value="${esc(b.notes || '')}" maxlength="300">
    <p class="small mut">Saving alerts the contractor and is written to the audit log. ON rotations drive readiness (current + next rotation).</p>
    <div class="row mt">${b.id ? '<button class="btn danger" id="bDel">Delete</button>' : ''}<button class="btn pri right" id="bSave">Save</button></div>`, (m, close) => {
    $('#bSave', m).addEventListener('click', () => guard(async () => {
      const body = { kind: $('#bK', m).value, destination_id: $('#bD', m).value || null, start: $('#bS', m).value, end: $('#bE', m).value, notes: $('#bN', m).value };
      if (b.id) await api('PUT', `/api/admin/schedule/blocks/${b.id}`, body); else await api('POST', '/api/admin/schedule/blocks', { ...body, contractor_id: b.contractor_id });
      close(); toast('Schedule saved — contractor alerted'); reload(); }));
    $('#bDel', m)?.addEventListener('click', () => guard(async () => { if (!confirm('Delete this block?')) return; await api('DELETE', `/api/admin/schedule/blocks/${b.id}`); close(); reload(); }));
  });
}
function genModal(c, d, reload) {
  modal(`<div class="row"><h2>Rotation pattern — ${esc(c.name)}</h2><button class="btn sm right" data-close>✕</button></div>
    <p class="small mut">Lays out ON/OFF rotations from the start date (replaces ON/OFF from that date on; training and leave stay).</p>
    <div class="grid2"><div><label>First rotation starts</label><input id="gS" type="date" value="${esc(c.next_start && c.blocks.length ? (c.blocks.find((b) => b.kind === 'on' && b.end >= d.today) || {}).start || d.today : d.today)}"></div>
      <div><label>Site</label><select id="gD">${d.destinations.map((x) => `<option value="${x.id}" ${x.name === c.destination ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div><label>Days on</label><input id="gOn" type="number" min="1" max="365" value="${c.rotation_on}"></div><div><label>Days off</label><input id="gOff" type="number" min="0" max="365" value="${c.rotation_off}"></div>
      <div><label>Cycles</label><input id="gC" type="number" min="1" max="8" value="3"></div></div>
    <button class="btn pri mt" id="gGo">Apply pattern</button>`, (m, close) => $('#gGo', m).addEventListener('click', () => guard(async () => {
    await api('POST', `/api/admin/contractors/${c.id}/schedule/generate`, { start: $('#gS', m).value, destination_id: $('#gD', m).value, on: +$('#gOn', m).value, off: +$('#gOff', m).value, cycles: +$('#gC', m).value });
    close(); toast('Pattern applied — contractor alerted'); reload(); })));
}

// ---------------- Titles ----------------
async function titlesPage() {
  const { titles } = await api('GET', '/api/admin/titles'); A.titles = null;
  main().innerHTML = `<div class="head"><h1>🏷️ Titles / roles</h1><span class="mut small">Shown in the contractor intake dropdown, board, schedule, report and ID badge</span></div>
    <div class="card"><table><thead><tr><th>Order</th><th>Title</th><th>In use</th><th>Status</th><th></th></tr></thead><tbody>
    ${titles.map((t, i) => `<tr data-t="${t.id}"><td class="row"><button class="btn sm" data-up="${i}" ${i ? '' : 'disabled'}>▲</button><button class="btn sm" data-dn="${i}" ${i < titles.length - 1 ? '' : 'disabled'}>▼</button></td>
      <td><input class="tname" value="${esc(t.name)}" maxlength="80"></td><td class="small">${t.in_use}</td><td>${t.active ? '<span class="pill green">Active</span>' : '<span class="pill gray">Inactive</span>'}</td>
      <td class="row"><button class="btn sm" data-ren="${t.id}">Rename</button><button class="btn sm" data-act="${t.id}" data-v="${t.active ? 0 : 1}">${t.active ? 'Deactivate' : 'Reactivate'}</button>${t.in_use ? '' : `<button class="btn sm danger" data-del="${t.id}">Delete</button>`}</td></tr>`).join('')}</tbody></table>
    <div class="row mt"><input id="tNew" placeholder="New title…" maxlength="80" class="grow"><button class="btn pri" id="tAdd">+ Add title</button></div>
    <p class="small mut mt">Deactivated titles stay on anyone who already has them but can't be picked for new selections. Unused titles can be deleted. Your titles are kept when the demo data resets.</p></div>`;
  const order = titles.map((t) => t.id);
  const move = (i, j) => guard(async () => { [order[i], order[j]] = [order[j], order[i]]; await api('PUT', '/api/admin/titles-order', { ids: order }); titlesPage(); });
  $$('[data-up]').forEach((b) => b.addEventListener('click', () => move(+b.dataset.up, +b.dataset.up - 1)));
  $$('[data-dn]').forEach((b) => b.addEventListener('click', () => move(+b.dataset.dn, +b.dataset.dn + 1)));
  $$('[data-ren]').forEach((b) => b.addEventListener('click', () => guard(async () => { await api('PUT', `/api/admin/titles/${b.dataset.ren}`, { name: b.closest('tr').querySelector('.tname').value }); toast('Renamed'); titlesPage(); })));
  $$('[data-act]').forEach((b) => b.addEventListener('click', () => guard(async () => { await api('PUT', `/api/admin/titles/${b.dataset.act}`, { active: b.dataset.v === '1' }); titlesPage(); })));
  $$('[data-del]').forEach((b) => b.addEventListener('click', () => guard(async () => { if (!confirm('Delete this unused title?')) return; await api('DELETE', `/api/admin/titles/${b.dataset.del}`); titlesPage(); })));
  $('#tAdd').addEventListener('click', () => guard(async () => { await api('POST', '/api/admin/titles', { name: $('#tNew').value }); toast('Title added'); titlesPage(); }));
}

// ---------------- Crew & coverage: headcount settings, on-rotation vs target, swing / fill-in pool ----------------
async function crewPage(qs) {
  const q = new URLSearchParams(qs || ''); const day = q.get('date') || '';
  const d = await api('GET', `/api/admin/crew${day ? `?date=${encodeURIComponent(day)}` : ''}`);
  const st = d.settings; const siteSum = d.sites.reduce((a, s) => a + s.target, 0);
  const tile = (n, lbl, sub, cls = '') => `<div class="tile ${cls}"><div class="n">${n}</div><div class="l">${lbl}</div>${sub ? `<div class="small mut">${sub}</div>` : ''}</div>`;
  main().innerHTML = `<div class="head"><h1>👥 Crew &amp; coverage</h1><span class="mut small">as of ${fdate(d.date)}</span>
      <input type="date" id="cwD" value="${esc(d.date)}" class="wauto right"></div>
    <div class="tiles mb">${tile(`${d.total}<span class="mut small"> / ${st.total_target}</span>`, 'Total crew', d.total === st.total_target ? 'at headcount' : `${d.total < st.total_target ? st.total_target - d.total + ' open' : d.total - st.total_target + ' over'} vs target`)}
      ${tile(`${d.on_today}<span class="mut small"> / ${st.on_target}</span>`, 'On rotation today', d.on_today >= st.on_target ? 'target met' : `${st.on_target - d.on_today} short of target`, d.on_today >= st.on_target ? 'green' : 'yellow')}
      ${tile(d.swing_count, 'Swing / fill-in pool', `${d.swing_ready} ready (green) and unassigned`, 'blue')}
      ${tile(d.sites.filter((s) => s.short).length, 'Sites short today', d.sites.filter((s) => s.short).map((s) => esc(s.name.split(',')[0])).join(', ') || 'none', d.sites.some((s) => s.short) ? 'red' : 'green')}</div>
    <div class="grid2 wauto">
      <div class="card"><h2>Coverage by site</h2>
        <table class="tbl"><thead><tr><th>Site</th><th>On today / target</th><th>Next gap (90 days)</th><th></th></tr></thead><tbody>
        ${d.sites.map((s) => `<tr><td><b>${esc(s.name)}</b><div class="small mut">${s.who.map(esc).join(', ') || '—'}</div></td>
          <td>${s.short ? `<span class="pill red">${s.on} / ${s.target}</span> <span class="small">short ${s.short}</span>` : `<span class="pill green">${s.on} / ${s.target}</span>`}${s.max && s.on > s.max ? ' <span class="pill yellow">over max</span>' : ''}</td>
          <td class="small">${s.next_gap ? `${fdate(s.next_gap.start)} → ${fdate(s.next_gap.end)} · short ${s.next_gap.short}` : '<span class="mut">none</span>'}<div class="mut">${s.gap_days_90} gap day(s) in 90</div></td>
          <td><button class="btn sm pri" data-assign="${s.id}" ${s.next_gap ? '' : 'disabled'}>Assign swing</button> <button class="btn sm" data-tgt="${s.id}">Target</button></td></tr>`).join('')}
        </tbody></table>
        <p class="small mut">Per-site targets add up to ${siteSum}${siteSum !== st.on_target ? ` — <b>overall target is ${st.on_target}</b>` : ' (matches the overall target)'}. Gaps also show on the <a href="#/schedule">Schedule</a> coverage rows.</p></div>
      <div class="card"><h2>Headcount settings</h2>
        <div class="grid2"><div><label>Total crew headcount</label><input id="cwT" type="number" min="1" value="${st.total_target}"></div><div><label>Target on rotation (overall)</label><input id="cwO" type="number" min="0" value="${st.on_target}"></div></div>
        <button class="btn pri mt" id="cwSave">Save settings</button>
        <h2 class="mt">Swing / fill-in pool</h2>
        ${d.swing.map((p) => `<div class="row swrow">${av(p.id)}<div><a href="#/c/${p.id}"><b>${esc(p.name)}</b></a><div class="small mut">${esc(p.title || '')} · ${esc(p.home_site)}</div></div>
          <span class="right">${pill(p.status)} ${p.assigned ? `<span class="pill blue">${p.assigned.now ? 'at' : 'booked'} ${esc(p.assigned.site.split(',')[0])} ${fdate(p.assigned.start)} → ${fdate(p.assigned.end)}</span>` : '<span class="pill gray">available</span>'}</span></div>`).join('') || '<p class="small mut">No one is flagged as swing yet. Open a contractor → Edit → “Swing / fill-in”.</p>'}
      </div></div>`;
  $('#cwD').addEventListener('change', (e) => { location.hash = `#/crew?date=${e.target.value}`; });
  $('#cwSave').addEventListener('click', () => guard(async () => { await api('PUT', '/api/admin/crew/settings', { total_target: +$('#cwT').value, on_target: +$('#cwO').value }); toast('Settings saved'); crewPage(qs); }));
  $$('[data-tgt]').forEach((b) => b.addEventListener('click', () => { const s = d.sites.find((x) => x.id === +b.dataset.tgt);
    modal(`<div class="row"><h2>Target — ${esc(s.name)}</h2><button class="btn sm right" data-close>✕</button></div>
      <div class="grid2"><div><label>Target on rotation (minimum)</label><input id="tMin" type="number" min="0" value="${s.target}"></div><div><label>Overstaffed above (optional)</label><input id="tMax" type="number" min="1" value="${s.max ?? ''}"></div></div>
      <button class="btn pri mt" id="tSave">Save</button>`, (m, close) => $('#tSave', m).addEventListener('click', () => guard(async () => {
      await api('PUT', `/api/admin/destinations/${s.id}/targets`, { min: +$('#tMin', m).value, max: $('#tMax', m).value === '' ? null : +$('#tMax', m).value }); close(); crewPage(qs); }))); }));
  $$('[data-assign]').forEach((b) => b.addEventListener('click', () => { const s = d.sites.find((x) => x.id === +b.dataset.assign); assignSwing(s, () => crewPage(qs)); }));
}
async function assignSwing(s, reload) {
  const g0 = s.next_gap; const g = g0 ? { ...g0, end: g0.end < isoAdd(g0.start, 29) ? isoAdd(g0.start, 29) : g0.end } : { start: isoAdd(new Date().toISOString().slice(0, 10), 0), end: isoAdd(new Date().toISOString().slice(0, 10), 29) };
  modal(`<div class="row"><h2>Assign swing — ${esc(s.name)}</h2><button class="btn sm right" data-close>✕</button></div>
    <p class="small mut">${g0 ? `Gap: ${fdate(g0.start)} → ${fdate(g0.end)}, short ${g0.short}. Default fill-in is at least 30 days — adjust the dates if needed.` : ''} Suggestions are checked against <b>this site's</b> requirements for these dates; ready (green) and available people are listed first.</p>
    <div class="grid2"><div><label>Start</label><input id="aS" type="date" value="${esc(g.start)}"></div><div><label>End (inclusive)</label><input id="aE" type="date" value="${esc(g.end)}"></div></div>
    <div id="aList" class="mt"><p class="mut small">Loading…</p></div>`, (m, close) => {
    const load = () => guard(async () => {
      const r = await api('GET', `/api/admin/crew/suggest?site=${s.id}&start=${$('#aS', m).value}&end=${$('#aE', m).value}`);
      $('#aList', m).innerHTML = r.suggestions.map((p, i) => `<div class="row swrow ${p.available && p.status !== 'red' ? '' : 'dim'}">${av(p.id)}<div><b>${esc(p.name)}</b>${i === 0 && p.available && p.status === 'green' ? ' <span class="pill green">suggested</span>' : ''}
          <div class="small mut">${esc(p.title || '')} · home site ${esc(p.home_site)}${p.issues.length ? ` · ${p.issues.map((x) => esc(x.name)).join(', ')}` : ''}${p.available ? '' : ` · busy: ${p.busy.map(esc).join('; ')}`}</div></div>
          <span class="right">${pill(p.status)} <button class="btn sm ${p.status === 'green' ? 'pri' : ''}" data-pick="${p.id}" data-st="${p.status}" ${p.available && p.status !== 'red' ? '' : 'disabled'}>Assign</button></span></div>`).join('') || '<p class="small">No swing people in the pool.</p>';
      $$('[data-pick]', m).forEach((x) => x.addEventListener('click', () => guard(async () => {
        const yellow = x.dataset.st === 'yellow';
        if (yellow && !confirm('This person is YELLOW for the assignment (something lapses). Assign anyway?')) return;
        await api('POST', '/api/admin/crew/assign-swing', { contractor_id: +x.dataset.pick, destination_id: s.id, start: $('#aS', m).value, end: $('#aE', m).value, allow_yellow: yellow });
        close(); toast('Swing assigned — contractor alerted'); reload(); })));
    });
    $('#aS', m).addEventListener('change', load); $('#aE', m).addEventListener('change', load); load();
  });
}

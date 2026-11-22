'use strict';
// Crew scheduling: ON / OFF / travel / training / leave blocks per contractor (dates inclusive, YYYY-MM-DD).
const db = require('./db');
const { fmt, addDays, toDate, today } = require('./status');

const KINDS = ['on', 'off', 'travel', 'training', 'leave'];
const plus = (iso, n) => fmt(addDays(toDate(iso), n));
const blocks = (cid) => db.prepare('SELECT * FROM schedule_blocks WHERE contractor_id = ? ORDER BY start, id').all(cid);
const onBlocks = (cid) => db.prepare("SELECT * FROM schedule_blocks WHERE contractor_id = ? AND kind = 'on' ORDER BY start").all(cid);

// Mirror the schedule into contractors.deploy_date / next_deploy_date so everything else (assistant, lists) agrees.
function sync(cid) {
  const t = fmt(today());
  const on = onBlocks(cid).filter((b) => b.end >= t);
  if (!on.length) return;
  db.prepare('UPDATE contractors SET deploy_date = ?, next_deploy_date = ?, destination_id = COALESCE(?, destination_id) WHERE id = ?')
    .run(on[0].start, on[1] ? on[1].start : null, on[0].destination_id, cid);
}

// Lay out a rotation pattern: ON (start .. start+on) then OFF, for `cycles` cycles. Replaces on/off/travel blocks
// from `start` onwards; training and leave are kept.
function generate(cid, start, on, off, destId, cycles = 3) {
  db.prepare("DELETE FROM schedule_blocks WHERE contractor_id = ? AND kind IN ('on','off','travel') AND end >= ?").run(cid, start);
  const ins = db.prepare('INSERT INTO schedule_blocks (contractor_id, kind, start, end, destination_id, notes) VALUES (?,?,?,?,?,?)');
  let s = start;
  for (let i = 0; i < cycles; i++) {
    const e = plus(s, on);
    ins.run(cid, 'on', s, e, destId, '');
    if (off > 1) ins.run(cid, 'off', plus(e, 1), plus(e, off - 1), null, '');
    s = plus(e, off); // same arithmetic as the readiness pattern: next start = end + off
  }
  sync(cid);
}

// Headcount per site per day (ON blocks), against each site's min / max target.
function coverage(from, days) {
  const to = plus(from, days - 1);
  const sites = db.prepare('SELECT id, name, min_headcount, max_headcount FROM destinations ORDER BY name').all();
  const rows = db.prepare(`SELECT b.*, c.name FROM schedule_blocks b JOIN contractors c ON c.id = b.contractor_id
    WHERE b.kind = 'on' AND b.start <= ? AND b.end >= ?`).all(to, from);
  return sites.map((s) => {
    const dayList = [];
    for (let i = 0; i < days; i++) {
      const d = plus(from, i);
      const who = rows.filter((b) => b.destination_id === s.id && b.start <= d && b.end >= d).map((b) => b.name);
      const n = who.length;
      const state = s.min_headcount && n < s.min_headcount ? 'gap' : s.max_headcount && n > s.max_headcount ? 'over' : 'ok';
      dayList.push({ date: d, headcount: n, state, who });
    }
    return { site_id: s.id, site: s.name, min: s.min_headcount || 0, max: s.max_headcount || null, days: dayList,
      gap_days: dayList.filter((x) => x.state === 'gap').length, over_days: dayList.filter((x) => x.state === 'over').length };
  });
}

// Conflicts: readiness status that collides with a scheduled deployment.
//  RED contractor with any ON block in the window that hasn't ended -> can't go.
//  YELLOW contractor with an ON block starting on/after their next-rotation date (the one the lapsing item blocks).
function conflicts(from, to, contractors, readiness) {
  const out = [];
  for (const c of contractors) {
    const r = readiness(c); if (r.status === 'green') continue;
    for (const b of onBlocks(c.id)) {
      if (b.start > to || b.end < from || b.end < fmt(today())) continue;
      if (r.status === 'red') out.push({ contractor_id: c.id, name: c.name, block_id: b.id, start: b.start, end: b.end, status: 'red',
        reason: `RED readiness overlaps scheduled rotation ${b.start} → ${b.end}: ${(r.items.filter((i) => i.status === 'red').map((i) => i.name).concat(r.blockers.map((x) => x.description)).join(', ')) || r.override_reason || 'not cleared'}` });
      else if (b.start >= r.rotation.next_start) out.push({ contractor_id: c.id, name: c.name, block_id: b.id, start: b.start, end: b.end, status: 'yellow',
        reason: `Will be RED for this rotation unless fixed by ${r.fix_by}: ${r.items.filter((i) => i.status === 'yellow').map((i) => i.name).join(', ')}` });
    }
  }
  return out;
}

// RFC 5545 calendar for a contractor's schedule + flights.
function ics(name, list, flights) {
  const esc = (s) => String(s || '').replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\r?\n/g, '\\n');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FFD//Crew Schedule//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(`FFD schedule — ${name}`)}`];
  const LABEL = { on: 'ON rotation', off: 'OFF (home)', travel: 'Travel day', training: 'Training', leave: 'Leave' };
  for (const b of list) {
    L.push('BEGIN:VEVENT', `UID:ffd-block-${b.id}@ffd.demo`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${b.start.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${plus(b.end, 1).replace(/-/g, '')}`, `SUMMARY:${esc(`${LABEL[b.kind]}${b.site ? ` — ${b.site}` : ''}`)}`, `DESCRIPTION:${esc(b.notes)}`, 'END:VEVENT');
  }
  for (const f of flights) {
    const t = (s) => s.replace(/[-:]/g, '').slice(0, 13) + '00';
    L.push('BEGIN:VEVENT', `UID:ffd-flight-${f.id}@ffd.demo`, `DTSTAMP:${stamp}`, `DTSTART:${t(f.depart_at)}`, `DTEND:${t(f.arrive_at || f.depart_at)}`,
      `SUMMARY:${esc(`✈ ${f.airline} ${f.flight_no} ${f.from_airport}→${f.to_airport}`)}`, `LOCATION:${esc(f.from_airport)}`,
      `DESCRIPTION:${esc(`Confirmation ${f.confirmation || '—'} · Seat ${f.seat || '—'} · times are local at each airport`)}`, 'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map((l) => (l.length > 74 ? l.match(/.{1,73}/g).join('\r\n ') : l)).join('\r\n') + '\r\n';
}

module.exports = { KINDS, blocks, onBlocks, sync, generate, coverage, conflicts, ics, plus };

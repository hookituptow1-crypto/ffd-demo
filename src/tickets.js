'use strict';
// Ticket approval queue. Everyone whose next rotation departure is <= 30 days away and has no ticket gets a PROPOSED itinerary
// (home/alternate airport, company preferred airline, policy cabin — First by default for long-haul — cheapest sensible fare).
// Admin confirms (one or many), swaps to an alternate flight, or rejects. Flow: pending -> confirmed ("Confirmed by admin -> Booking")
// -> booked. In this demo the booking step is MOCKED (no ticket is issued, nothing is charged). In production the assistant books
// the real ticket with the company card OUTSIDE this app after the admin confirms — the app never stores card data.
const crypto = require('crypto');
const db = require('./db');
const A = require('./assistant');
const SCH = require('./schedule');
const mail = require('./mail');
const { today, fmt } = require('./status');

db.exec(`CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  destination_id INTEGER REFERENCES destinations(id) ON DELETE SET NULL,
  depart_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','booked','rejected')),
  fare_json TEXT NOT NULL, options_json TEXT NOT NULL,
  confirmation TEXT DEFAULT '', red_override INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT, confirmed_by TEXT, booked_at TEXT, notified_at TEXT, emailed_at TEXT,
  rejected_at TEXT, rejected_by TEXT, reject_reason TEXT DEFAULT '',
  UNIQUE (contractor_id, depart_date));
CREATE INDEX IF NOT EXISTS ix_tickets_status ON tickets(status);`);

let D = {}; // deps injected by server.js: readiness, sendAlert, appUrl
const init = (deps) => { D = deps; };
const WINDOW = 30;
const todayS = () => fmt(today());
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const audit = (userId, action, details) => db.prepare("INSERT INTO audit_log (user_id, action, details, ip) VALUES (?,?,?,'')").run(userId || null, action, details);
const uid = (email) => (db.prepare('SELECT id FROM users WHERE email = ?').get(email || '') || {}).id || null;

function nextDeparture(c) {
  const t = todayS();
  const b = SCH.onBlocks(c.id).find((x) => x.start >= t);
  if (b) return { date: b.start, destination_id: b.destination_id || c.destination_id };
  // swing pool has no fixed rotation until assigned
  if (!c.swing && c.deploy_date && c.deploy_date >= t) return { date: c.deploy_date, destination_id: c.destination_id };
  return null;
}
// Already ticketed = an outbound flight from home/alternate (or marked outbound) within 3 days before .. 1 day after the departure.
function ticketed(c, date) {
  const lo = fmt(new Date(Date.parse(date) - 3 * 86400000)), hi = fmt(new Date(Date.parse(date) + 2 * 86400000));
  const home = [c.home_airport, c.alt_airport].filter(Boolean);
  return db.prepare('SELECT * FROM flights WHERE contractor_id = ? AND depart_at >= ? AND depart_at < ?').all(c.id, lo, hi)
    .some((f) => f.direction === 'outbound' || home.includes(f.from_airport));
}
function options(c, dest, date) {
  const pol = A.policy(); const cabins = [...new Set([pol.default_cabin, 'first', 'business'])];
  const from = c.home_airport || 'IAH'; let list = A.searchFares(from, dest.airport || 'XXX', date, { cabins });
  if (c.alt_airport && c.alt_airport !== from) list = list.concat(A.searchFares(c.alt_airport, dest.airport || 'XXX', date, { cabins }).filter((f) => f.cabin === pol.default_cabin || f.cabin === 'business').slice(0, 4));
  const rank = { business: 1, first: 2, premium: 3, economy: 4, [pol.default_cabin]: 0 };
  // home airport before alternate when the fare is otherwise equal in preference
  return list.sort((a, b) => (rank[a.cabin] - rank[b.cabin]) || (b.preferred - a.preferred) || (b.sensible - a.sensible) || ((a.origin !== from) - (b.origin !== from)) || (a.price_usd - b.price_usd));
}
let lastRun = 0;
function propose(force = false) {
  if (!force && Date.now() - lastRun < 30000) return 0;
  lastRun = Date.now(); let n = 0; const t = todayS();
  for (const c of db.prepare('SELECT * FROM contractors').all()) {
    const nd = nextDeparture(c);
    const valid = nd && daysBetween(t, nd.date) >= 0 && daysBetween(t, nd.date) <= WINDOW && !ticketed(c, nd.date);
    // drop stale proposals (date moved, or someone booked it another way)
    for (const p of db.prepare("SELECT id, depart_date FROM tickets WHERE contractor_id = ? AND status = 'pending'").all(c.id)) {
      if (!valid || p.depart_date !== nd.date) db.prepare('DELETE FROM tickets WHERE id = ?').run(p.id);
    }
    if (!valid || db.prepare('SELECT 1 FROM tickets WHERE contractor_id = ? AND depart_date = ?').get(c.id, nd.date)) continue;
    const dest = db.prepare('SELECT * FROM destinations WHERE id = ?').get(nd.destination_id || 0); if (!dest) continue;
    const opts = options(c, dest, nd.date);
    db.prepare('INSERT INTO tickets (contractor_id, destination_id, depart_date, fare_json, options_json) VALUES (?,?,?,?,?)')
      .run(c.id, dest.id, nd.date, JSON.stringify(opts[0]), JSON.stringify(opts)); n++;
  }
  // finish any booking interrupted by a restart
  for (const k of db.prepare("SELECT id FROM tickets WHERE status = 'confirmed' AND confirmed_at < datetime('now', '-20 seconds')").all()) book(k.id);
  return n;
}
const STATUS_LABEL = { pending: 'Waiting for approval', confirmed: 'Confirmed by admin → Booking', booked: 'Booked', rejected: 'Rejected' };
function shape(k) {
  const c = db.prepare('SELECT * FROM contractors WHERE id = ?').get(k.contractor_id) || {}; const r = D.readiness(c);
  const dest = db.prepare('SELECT name, airport FROM destinations WHERE id = ?').get(k.destination_id || 0) || {};
  const fare = JSON.parse(k.fare_json);
  return { id: k.id, status: k.status, status_label: STATUS_LABEL[k.status], depart_date: k.depart_date, days_out: daysBetween(todayS(), k.depart_date),
    contractor: { id: c.id, name: c.name, employee_no: c.employee_no, home_airport: c.home_airport || '', alt_airport: c.alt_airport || '' },
    readiness: r.status, issues: r.items.filter((i) => i.status !== 'green').map((i) => ({ name: i.name, status: i.status })).concat(r.blockers.map((b) => ({ name: b.description, status: 'red' }))),
    destination: dest.name || '—', destination_airport: dest.airport || '', fare, options: JSON.parse(k.options_json).length,
    confirmation: k.confirmation, confirmed_by: k.confirmed_by, confirmed_at: k.confirmed_at, booked_at: k.booked_at, notified_at: k.notified_at, emailed_at: k.emailed_at,
    red_override: !!k.red_override, rejected_by: k.rejected_by, rejected_at: k.rejected_at, reject_reason: k.reject_reason, created_at: k.created_at, mock: true };
}
function list(status = 'pending') {
  const where = status === 'done' ? "status IN ('confirmed','booked')" : 'status = ?';
  const rows = db.prepare(`SELECT * FROM tickets WHERE ${where} ORDER BY depart_date, id`).all(...(status === 'done' ? [] : [status])).map(shape);
  if (status === 'done') rows.sort((a, b) => (b.confirmed_at || '').localeCompare(a.confirmed_at || ''));
  return rows;
}
function counts() { return Object.fromEntries(['pending', 'confirmed', 'booked', 'rejected'].map((s) => [s, db.prepare('SELECT COUNT(*) n FROM tickets WHERE status = ?').get(s).n])); }
function summary() {
  propose();
  const p = list('pending'); if (!p.length) return { pending: 0, text: '' };
  const soon = p[0]; const at30 = p.filter((x) => x.days_out === WINDOW);
  const who = at30.length ? `${at30.map((x) => x.contractor.name).slice(0, 2).join(' and ')} ${at30.length === 1 ? 'is' : 'are'} ${WINDOW} days out` : `${soon.contractor.name} is ${soon.days_out} day${soon.days_out === 1 ? '' : 's'} out`;
  const soonTxt = at30.length && soon.days_out < WINDOW ? ` · soonest: ${soon.contractor.name} in ${soon.days_out} day${soon.days_out === 1 ? '' : 's'}` : '';
  return { pending: p.length, red: p.filter((x) => x.readiness === 'red').length, soonest: { name: soon.contractor.name, days_out: soon.days_out },
    at_30: at30.map((x) => x.contractor.name), text: `You have ${p.length} ticket${p.length === 1 ? '' : 's'} to approve today — ${who}${soonTxt}` };
}
// Confirm one or many. RED travelers are skipped unless allow_red (explicit admin override, audited).
function confirm(ids, email, allowRed, delayMs = 2500) {
  const out = [];
  for (const id of ids) {
    const k = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    if (!k) { out.push({ id, ok: false, error: 'Not found' }); continue; }
    const name = (db.prepare('SELECT name FROM contractors WHERE id = ?').get(k.contractor_id) || {}).name;
    if (k.status !== 'pending') { out.push({ id, name, ok: false, error: `Already ${k.status}` }); continue; }
    const r = D.readiness(db.prepare('SELECT * FROM contractors WHERE id = ?').get(k.contractor_id));
    if (r.status === 'red' && !allowRed) { out.push({ id, name, ok: false, skipped: 'red', error: `${name} is RED — not cleared to travel (open the ticket to override)` }); continue; }
    db.prepare("UPDATE tickets SET status = 'confirmed', confirmed_at = datetime('now'), confirmed_by = ?, red_override = ? WHERE id = ? AND status = 'pending'").run(email, r.status === 'red' ? 1 : 0, id);
    const fare = JSON.parse(k.fare_json);
    audit(uid(email), 'ticket_confirm', `${name} ${k.depart_date} ${fare.airline} ${fare.cabin_label} $${fare.price_usd}${r.status === 'red' ? ' (RED override)' : ''}`);
    out.push({ id, name, ok: true, status: 'confirmed' });
    if (delayMs > 0) setTimeout(() => { try { book(id); } catch (e) { console.error('mock booking failed', e.message); } }, delayMs).unref(); else book(id);
  }
  return out;
}
const PNR = () => Array.from({ length: 6 }, () => 'ACDEFGHJKMNPQRTUVWXY34679'[crypto.randomInt(25)]).join('');
// MOCK booking: writes the itinerary as flights, notifies the contractor in-app (+ web push) and emails the itinerary.
function book(id) {
  const k = db.prepare("SELECT * FROM tickets WHERE id = ? AND status = 'confirmed'").get(id); if (!k) return null;
  const c = db.prepare('SELECT * FROM contractors WHERE id = ?').get(k.contractor_id);
  const dest = db.prepare('SELECT * FROM destinations WHERE id = ?').get(k.destination_id || 0) || {};
  const fare = JSON.parse(k.fare_json); const conf = PNR();
  const ins = db.prepare(`INSERT INTO flights (contractor_id, airline, flight_no, from_airport, to_airport, depart_at, arrive_at, confirmation, seat, notes, direction, cabin)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  // leg times: leg 1 departs at fare.depart_at; connection leaves ~3h after leg 1 lands; final arrival = fare.arrive_at
  const dep1 = fare.depart_at; const arrHub = new Date(Date.parse(dep1 + ':00Z') + Math.round(fare.duration_h * 0.55) * 3600000).toISOString().slice(0, 16);
  const dep2 = new Date(Date.parse(arrHub + ':00Z') + 3 * 3600000).toISOString().slice(0, 16);
  const times = [[dep1, arrHub], [dep2, fare.arrive_at]];
  fare.legs.forEach((l, i) => ins.run(c.id, l.airline, l.flight_no, l.from_airport, l.to_airport, times[i][0], times[i][1], conf, '',
    `MOCK BOOKING (demo — no ticket issued) · ${fare.cabin_label} · pick your own seat and check in with the airline`, 'outbound', fare.cabin_label));
  db.prepare("UPDATE tickets SET status = 'booked', confirmation = ?, booked_at = datetime('now'), notified_at = datetime('now'), emailed_at = datetime('now') WHERE id = ?").run(conf, id);
  const legTxt = fare.legs.map((l, i) => `${l.flight_no} ${l.from_airport}→${l.to_airport} ${times[i][0].replace('T', ' ')}`).join(' · ');
  D.sendAlert([c.id], 'flight', `✈️ Itinerary booked: ${dest.name || 'your rotation'} ${k.depart_date}`, `${fare.cabin_label} · Conf ${conf} · ${legTxt}. Open My Schedule to pick your seat / check in. (Demo — mock booking)`, k.confirmed_by || 'admin');
  const u = db.prepare('SELECT email FROM users WHERE contractor_id = ?').get(c.id);
  const manage = fare.manage_url || A.manageUrl(fare.legs[0].flight_no);
  if (u) mail.send(u.email, `Your itinerary to ${dest.name || 'site'} — ${k.depart_date} (Conf ${conf})`, [
    `Hi ${c.name.split(' ')[0]},`, '',
    `Your travel for your next rotation is booked. [DEMO — MOCK BOOKING: no real ticket was issued]`, '',
    `Confirmation / record locator: ${conf}`, `Cabin: ${fare.cabin_label}`, `Airline: ${fare.airline}`, '',
    ...fare.legs.map((l, i) => `  ${l.flight_no}  ${l.from_airport} → ${l.to_airport}   departs ${times[i][0].replace('T', ' ')}   arrives ${String(times[i][1] || '').replace('T', ' ')} (local times)`), '',
    `Pick your seat / Check in: ${manage || 'the airline website'}`,
    'You handle your own seat selection, check-in and boarding pass with the airline, using the confirmation code above and your last name.', '',
    `Your itinerary is also on My Schedule in the FFD app: ${D.appUrl}/app.html`, '',
    '— FFD Deployment Office'].join('\n'), 'itinerary');
  audit(uid(k.confirmed_by), 'ticket_booked', `${c.name} ${k.depart_date} conf ${conf} (mock) · contractor notified + itinerary emailed`);
  return conf;
}
function reject(id, email, reason) {
  const k = db.prepare("SELECT * FROM tickets WHERE id = ? AND status = 'pending'").get(id); if (!k) return false;
  db.prepare("UPDATE tickets SET status = 'rejected', rejected_at = datetime('now'), rejected_by = ?, reject_reason = ? WHERE id = ?").run(email, reason, id);
  audit(uid(email), 'ticket_reject', `${(db.prepare('SELECT name FROM contractors WHERE id = ?').get(k.contractor_id) || {}).name} ${k.depart_date}: ${reason || '—'}`);
  return true;
}
function getOptions(id) { const k = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id); return k ? { ticket: shape(k), options: JSON.parse(k.options_json) } : null; }
function choose(id, fareId, email) {
  const k = db.prepare("SELECT * FROM tickets WHERE id = ? AND status = 'pending'").get(id); if (!k) return null;
  const f = JSON.parse(k.options_json).find((x) => x.id === fareId); if (!f) return null;
  db.prepare('UPDATE tickets SET fare_json = ? WHERE id = ?').run(JSON.stringify(f), id);
  audit(uid(email), 'ticket_swap', `ticket ${id} → ${f.airline} ${f.cabin_label} from ${f.origin} $${f.price_usd}`);
  return f;
}
function forContractor(cid) {
  return db.prepare("SELECT * FROM tickets WHERE contractor_id = ? AND status IN ('confirmed','booked') AND depart_date >= ? ORDER BY depart_date").all(cid, fmt(new Date(Date.now() - 2 * 86400000)))
    .map((k) => { const f = JSON.parse(k.fare_json); const legs = db.prepare('SELECT * FROM flights WHERE contractor_id = ? AND confirmation = ? ORDER BY depart_at').all(cid, k.confirmation || '-');
      return { id: k.id, status: k.status, status_label: STATUS_LABEL[k.status], depart_date: k.depart_date, destination: (db.prepare('SELECT name FROM destinations WHERE id = ?').get(k.destination_id || 0) || {}).name || '',
        confirmation: k.confirmation, cabin: f.cabin_label, airline: f.airline, manage_url: f.manage_url || A.manageUrl(f.legs[0].flight_no), booked_at: k.booked_at, mock: true,
        legs: legs.map((l) => ({ flight_no: l.flight_no, airline: l.airline, from: l.from_airport, to: l.to_airport, depart_at: l.depart_at, arrive_at: l.arrive_at })) }; });
}
// Demo seed: build the queue, then mark a few as already approved + booked (confirmed yesterday by the admin).
function seedDemo() {
  propose(true);
  const skip = new Set(['John Doe', 'Wes Calloway']);
  const pend = list('pending').filter((t) => t.readiness === 'green' && !skip.has(t.contractor.name)).sort((a, b) => b.days_out - a.days_out).slice(0, 3);
  for (const t of pend) { confirm([t.id], 'admin@ffd.demo', false, 0); db.prepare("UPDATE tickets SET confirmed_at = datetime('now', '-1 day', '-2 hours'), booked_at = datetime('now', '-1 day', '-2 hours') WHERE id = ?").run(t.id); }
  db.prepare("UPDATE outbox SET created_at = datetime('now', '-1 day', '-2 hours') WHERE kind = 'itinerary'").run();
  db.prepare("UPDATE alerts SET created_at = datetime('now', '-1 day', '-2 hours'), read_at = datetime('now', '-1 day') WHERE title LIKE '✈️ Itinerary booked%'").run();
  return pend.length;
}
module.exports = { init, propose, list, counts, summary, confirm, book, reject, getOptions, choose, forContractor, seedDemo, nextDeparture, STATUS_LABEL, WINDOW };

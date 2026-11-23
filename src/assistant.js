'use strict';
// Demo booking assistant. Rule-based parsing (no external AI/API keys) + MOCK fares.
// Production: swap parse() for an LLM call and searchFares() for a real fare API (Duffel, Amadeus, Sabre, or a TMC).
const db = require('./db');
const { evaluate, today, fmt, addDays, toDate } = require('./status');

const REGION_WORDS = { africa: 'Africa', 'middle east': 'Middle East', mideast: 'Middle East', gulf: 'Middle East',
  europe: 'Europe', asia: 'Asia' };

function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }

function findContractor(text) {
  const t = ` ${norm(text)} `;
  const all = db.prepare('SELECT * FROM contractors').all();
  let best = null, score = 0;
  for (const c of all) {
    const parts = norm(c.name).split(' ');
    let s = 0;
    if (t.includes(` ${norm(c.name)} `)) s += 10;
    for (const p of parts) if (p.length > 1 && t.includes(` ${p} `)) s += 3;
    if (t.includes(` ${norm(c.employee_no)} `)) s += 10;
    if (s > score) { score = s; best = c; }
  }
  return score >= 3 ? best : null;
}

function findDestinations(text) {
  const t = ` ${norm(text)} `;
  const dests = db.prepare('SELECT * FROM destinations').all();
  const direct = dests.filter((d) => norm(d.name).split(' ').some((w) => w.length > 3 && t.includes(` ${w} `))
    || t.includes(` ${norm(d.country)} `) || (d.airport && t.includes(` ${d.airport.toLowerCase()} `)));
  if (direct.length) return { matches: direct, how: 'named' };
  for (const [w, region] of Object.entries(REGION_WORDS)) {
    if (t.includes(` ${w} `)) return { matches: dests.filter((d) => d.region === region), how: `region "${region}"` };
  }
  return { matches: [], how: 'none' };
}

function parseDate(text) {
  const m = String(text).match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return m ? m[1] : null;
}

// Deterministic mock fares so screenshots/demo are stable.
const CARRIERS = [
  ['Qatar Airways', 'QR', 'DOH'], ['Emirates', 'EK', 'DXB'], ['Turkish Airlines', 'TK', 'IST'],
  ['Lufthansa', 'LH', 'FRA'], ['United + Ethiopian', 'UA/ET', 'ADD'], ['Delta + KLM', 'DL/KL', 'AMS'], ['Air France', 'AF', 'CDG'],
];
const OP = { QR: 'Qatar Airways', EK: 'Emirates', TK: 'Turkish Airlines', LH: 'Lufthansa', UA: 'United', ET: 'Ethiopian Airlines', DL: 'Delta', KL: 'KLM', AF: 'Air France' };
const FIRST_SOLD = new Set(['EK', 'LH', 'AF', 'QR']); // carriers that sell a First cabin on these long-haul routes (mock)
// Real "manage trip" pages, where the traveler picks a seat and checks in with the confirmation code + last name
const MANAGE = { QR: 'https://www.qatarairways.com/en/manage-booking.html', EK: 'https://www.emirates.com/us/english/manage-booking/',
  TK: 'https://www.turkishairlines.com/en-us/flights/manage-booking/', LH: 'https://www.lufthansa.com/us/en/my-bookings', UA: 'https://www.united.com/en/us/manageres/mytrips',
  ET: 'https://www.ethiopianairlines.com/us/book/manage-booking', DL: 'https://www.delta.com/my-trips/search', KL: 'https://www.klm.us/trip', AF: 'https://wwws.airfrance.us/trip',
  AA: 'https://www.aa.com/reservation/view/find-your-trip', FZ: 'https://www.flydubai.com/en/plan/manage-booking' };
const manageUrl = (flightNo) => MANAGE[String(flightNo || '').split(' ')[0]] || null;
const CABINS = { first: 'First', business: 'Business', premium: 'Premium Economy', economy: 'Economy' };
const US = new Set(['IAH', 'HOU', 'DFW', 'DAL', 'ATL', 'MEM', 'BNA', 'DEN', 'COS', 'SAT', 'AUS', 'LIT', 'MSY', 'BTR', 'OKC', 'TUL', 'ELP', 'ABQ', 'JAX', 'SAV', 'TUS', 'PHX', 'SEA', 'PDX',
  'ORD', 'LAX', 'SFO', 'JFK', 'EWR', 'IAD', 'DCA', 'BOS', 'MIA', 'MCO', 'TPA', 'CLT', 'PHL', 'DTW', 'MSP', 'SLC', 'LAS', 'SAN', 'STL', 'MCI', 'IND', 'CVG', 'CMH', 'PIT', 'RDU', 'BHM', 'JAN', 'SHV', 'LBB', 'MAF', 'AMA', 'CRP', 'HRL', 'MFE', 'BRO', 'GPT', 'PNS', 'MOB', 'HSV', 'TYS', 'CHA', 'GSP', 'RIC', 'ORF', 'BWI', 'SDF', 'LEX', 'OMA']);
// Company preferred airline (one carrier the company picks). Proposals and the assistant default to it, in the policy cabin.
const AIRLINES = CARRIERS.map(([name, code, hub]) => ({ code: code.split('/')[0], name, hub, first: FIRST_SOLD.has(code.split('/')[0]) }));
function policy() {
  const cabin = db.meta.get('default_cabin') || 'first'; const pref = db.meta.get('preferred_airline') || 'QR';
  return { default_cabin: CABINS[cabin] ? cabin : 'first', longhaul_hours: Number(db.meta.get('longhaul_hours') || 6),
    preferred_airline: AIRLINES.some((a) => a.code === pref) ? pref : '', airlines: AIRLINES };
}
// Long-haul = leaves the US (overseas) or more than `longhaul_hours` in the air -> default cabin from the travel policy.
function cabinFor(from, to, hours, pol = policy()) {
  const longhaul = (US.has(from) !== US.has(to)) || hours > pol.longhaul_hours;
  return { longhaul, cabin: longhaul ? pol.default_cabin : 'economy' };
}
const MULT = { economy: 1, premium: 1.7, business: 3.4, first: 5.6 };
// opts.cabins = ['first','business'] returns one fare per carrier per cabin (for the approval queue's swap list).
function searchFares(from, to, departDate, opts = {}) {
  let seed = [...`${from}${to}${departDate}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const pol = policy(); const out = [];
  CARRIERS.forEach(([airline, code, hub]) => {
    const base = Math.round(780 + rnd() * 1400);
    const hours = Math.round(17 + rnd() * 14);
    const depH = 6 + Math.floor(rnd() * 15);
    const n1 = 100 + Math.floor(rnd() * 800), n2 = 100 + Math.floor(rnd() * 800);
    const c1 = code.split('/')[0], c2 = (code.split('/')[1] || c1);
    const dep = `${departDate}T${String(depH).padStart(2, '0')}:${rnd() > 0.5 ? '30' : '05'}`;
    const arr = new Date(new Date(dep + ':00Z').getTime() + hours * 3600000).toISOString().slice(0, 16);
    const refundable = rnd() > 0.6;
    const want = cabinFor(from, to, hours, pol);
    const cabins = opts.cabins || [want.cabin];
    for (const askCabin of cabins) {
      let cabin = askCabin; let note = '';
      if (cabin === 'first' && !FIRST_SOLD.has(c1)) { cabin = 'business'; note = 'First not sold on this route — Business'; if (opts.cabins && opts.cabins.includes('business')) continue; }
      out.push({ id: `${from}-${code}-${cabin}`, origin: from, airline, carrier: c1, preferred: c1 === pol.preferred_airline, cabin, cabin_label: CABINS[cabin], cabin_note: note, longhaul: want.longhaul,
        price_usd: Math.round(base * MULT[cabin] / 10) * 10 - 1, duration_h: hours, stops: 1, via: hub, refundable,
        legs: [
          { airline: OP[c1] || airline, flight_no: `${c1} ${n1}`, from_airport: from, to_airport: hub, depart_at: dep },
          { airline: OP[c2] || airline, flight_no: `${c2} ${n2}`, from_airport: hub, to_airport: to, arrive_at: arr },
        ], depart_at: dep, arrive_at: arr, manage_url: MANAGE[c1] || null, demo: true });
    }
  });
  // Policy cabin first, then cheapest. "Sensible" = skip itineraries more than 8 h longer than the quickest one.
  const fastest = Math.min(...out.map((f) => f.duration_h));
  const rank = { business: 1, first: 2, premium: 3, economy: 4, [pol.default_cabin]: 0 };
  // Order: company preferred airline in the policy cabin, then the policy cabin by price, then the rest.
  return out.map((f) => ({ ...f, sensible: f.duration_h <= fastest + 8 }))
    .sort((a, b) => (rank[a.cabin] - rank[b.cabin]) || (b.preferred - a.preferred) || (b.sensible - a.sensible) || (a.price_usd - b.price_usd));
}

function plan(text) {
  const contractor = findContractor(text);
  const { matches, how } = findDestinations(text);
  const notes = [];
  if (!contractor) return { ok: false, message: "I couldn't tell which contractor you mean. Try their full name or employee number." };
  let dest = null;
  if (matches.length === 1) dest = matches[0];
  else if (matches.length > 1) {
    const cur = matches.find((d) => d.id === contractor.destination_id);
    dest = cur || matches[0];
    notes.push(`"${how}" matched ${matches.map((d) => d.name).join(', ')} — picked ${dest.name}${cur ? ' (their assigned site)' : ''}. Name the site to change it.`);
  } else {
    dest = db.prepare('SELECT * FROM destinations WHERE id = ?').get(contractor.destination_id);
    if (!dest) return { ok: false, message: `Found ${contractor.name}, but no destination. Name a country or site.` };
    notes.push(`No destination in the request — using their assigned site, ${dest.name}.`);
  }
  // Readiness against the TARGET destination's requirements
  const reqs = db.prepare(`SELECT rt.* FROM requirement_types rt JOIN destination_requirements dr ON dr.requirement_type_id = rt.id
    WHERE dr.destination_id = ? ORDER BY CASE rt.category WHEN 'passport' THEN 0 WHEN 'visa' THEN 1 WHEN 'id' THEN 2 WHEN 'immunization' THEN 3 ELSE 4 END, rt.name`).all(dest.id);
  const docs = db.prepare('SELECT * FROM documents WHERE contractor_id = ?').all(contractor.id);
  const blockers = db.prepare('SELECT * FROM blockers WHERE contractor_id = ?').all(contractor.id);

  // Booking window: depart no sooner than 30 days out (or the requested / scheduled date if later)
  const t = today();
  const earliest = addDays(t, 30);
  let depart = parseDate(text) || contractor.deploy_date;
  if (!depart || toDate(depart) < earliest) {
    if (depart) notes.push(`Requested/scheduled date ${depart} is inside the 30-day booking window — moved to ${fmt(earliest)}.`);
    depart = fmt(earliest);
  }
  const sim = { ...contractor, deploy_date: depart, next_deploy_date: null, override_status: null };
  const readiness = evaluate(sim, reqs, docs, blockers);
  const from = contractor.home_airport || 'IAH';
  if (!contractor.home_airport) notes.push('No home airport on file — searched from IAH. Add one in their profile.');
  let fares = searchFares(from, dest.airport || 'XXX', depart);
  if (contractor.alt_airport && contractor.alt_airport !== from) {
    const rank = (f) => (f.cabin === policy().default_cabin ? 0 : 1);
    fares = fares.concat(searchFares(contractor.alt_airport, dest.airport || 'XXX', depart).slice(0, 3)).sort((a, b) => (rank(a) - rank(b)) || (b.preferred - a.preferred) || (a.price_usd - b.price_usd));
    notes.push(`Searched home airport ${from} plus alternate ${contractor.alt_airport}.`);
  }
  const issues = readiness.items.filter((i) => i.status !== 'green');
  return {
    ok: true, contractor: { id: contractor.id, name: contractor.name, employee_no: contractor.employee_no, home_airport: from, alt_airport: contractor.alt_airport || '' },
    destination: { id: dest.id, name: dest.name, country: dest.country, airport: dest.airport },
    depart_date: depart, return_date: readiness.rotation.end, readiness, issues, notes, fares,
    can_book: readiness.status !== 'red',
    summary: readiness.status === 'red'
      ? `${contractor.name} is NOT cleared for ${dest.name}: ${issues.filter((i) => i.status === 'red').map((i) => i.name).join(', ')}${readiness.blockers.length ? ' + active blockers' : ''}. Fix before booking (you can still hold a fare).`
      : readiness.status === 'yellow'
        ? `${contractor.name} can go to ${dest.name} on ${depart}, but ${issues.map((i) => i.name).join(', ')} must be renewed before the following rotation.`
        : `${contractor.name} is cleared for ${dest.name}. ${fares[0].preferred ? 'Company preferred airline' : 'Best'} ${fares[0].cabin_label} demo fare: $${fares[0].price_usd.toLocaleString()} on ${fares[0].airline}.`,
    policy: policy(),
  };
}

module.exports = { plan, searchFares, policy, AIRLINES, cabinFor, manageUrl, CABINS, MANAGE };

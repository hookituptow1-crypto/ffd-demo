'use strict';
// Demo data — ALL names, numbers and people are fictional. Dates are relative to "today" so scenarios stay valid.
const db = require('./db');
const { hashPassword, verifyPassword, encJSON, encrypt, token } = require('./crypto');
const { today, fmt, addDays } = require('./status');

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// Demo passwords are NOT in the source code. They come from env (ADMIN_PASSWORD / CONTRACTOR_PASSWORD, set privately on
// the host) or, if unset, are generated once and kept server-side in data/demo-credentials.json (never served).
function demoPasswords() {
  if (process.env.ADMIN_PASSWORD && process.env.CONTRACTOR_PASSWORD) return { admin: process.env.ADMIN_PASSWORD, contractor: process.env.CONTRACTOR_PASSWORD };
  const f = path.join(__dirname, '..', 'data', 'demo-credentials.json');
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ admin: crypto.randomBytes(12).toString('base64url'), contractor: crypto.randomBytes(9).toString('base64url') }), { mode: 0o600 });
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
const ADMIN_EMAIL = 'admin@ffd.demo';
// On every boot (demo mode): make the seeded demo accounts match the current ADMIN_PASSWORD / CONTRACTOR_PASSWORD, so a
// password change on the host takes effect with a plain restart (no reseed). Only touches the seeded @ffd.demo accounts.
function syncPasswords() {
  const pw = demoPasswords(); let n = 0;
  for (const u of db.prepare("SELECT id, role, password_hash FROM users WHERE email LIKE '%@ffd.demo'").all()) {
    const want = u.role === 'admin' ? pw.admin : pw.contractor;
    if (!verifyPassword(want, u.password_hash)) { db.prepare('UPDATE users SET password_hash = ?, must_change = 0 WHERE id = ?').run(hashPassword(want), u.id); db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); n++; }
  }
  return n;
}

function seed() {
  const T = today();
  const d = (n) => fmt(addDays(T, n));
  // remove encrypted files of the uploads we're about to drop (keeps the disk from filling up across nightly resets)
  const UP = path.join(__dirname, '..', 'data', 'uploads');
  for (const u of db.prepare('SELECT file FROM uploads').all()) { try { fs.unlinkSync(path.join(UP, u.file)); } catch {} }
  try { db.exec('DELETE FROM tickets'); } catch {} // ticket approval queue (table created by tickets.js)
  db.exec(`DELETE FROM sessions; DELETE FROM outbox; DELETE FROM password_resets; DELETE FROM push_subs; DELETE FROM schedule_blocks; DELETE FROM checkins; DELETE FROM admin_alerts; DELETE FROM alerts; DELETE FROM uploads; DELETE FROM flights;
    DELETE FROM blockers; DELETE FROM documents; DELETE FROM profiles; DELETE FROM users; DELETE FROM contractors;
    DELETE FROM destination_requirements; DELETE FROM destinations; DELETE FROM requirement_types;`); // audit_log is kept across resets

  const rt = db.prepare(`INSERT INTO requirement_types (name, category, has_expiry, min_validity_days, lead_days, instructions, keyword)
    VALUES (?,?,?,?,?,?,?)`);
  const R = {};
  [
    ['Passport', 'passport', 1, 180, 45, 'Must be valid 6 months past your return date. Renew via travel.state.gov — expedited service ~2-3 weeks.', 'passport'],
    ['Iraq Work Visa', 'visa', 1, 0, 30, 'Company sponsors the visa. Send passport scan + photo to the deployment office.', 'iraq'],
    ['Kuwait Work Visa', 'visa', 1, 0, 30, 'Company sponsors the visa. Send passport scan + photo to the deployment office.', 'kuwait'],
    ['Djibouti Entry Visa', 'visa', 1, 0, 21, 'Apply through the deployment office; e-visa processing ~2-3 weeks.', 'djibouti'],
    ['Niger Visa', 'visa', 1, 0, 30, 'Embassy visa; requires yellow fever card and invitation letter.', 'niger'],
    ['Yellow Fever Vaccine', 'immunization', 0, 0, 14, 'Required for entry. Get it at a certified travel clinic at least 10 days before travel; bring your yellow card (ICVP).', 'yellow fever'],
    ['Hepatitis A', 'immunization', 0, 0, 14, 'Two-dose series. Upload your shot record.', 'hepatitis a'],
    ['Typhoid', 'immunization', 1, 0, 14, 'Injectable lasts 2 years. Any travel clinic or pharmacy.', 'typhoid'],
    ['Tdap (Tetanus)', 'immunization', 1, 0, 14, 'Booster every 10 years.', 'tdap'],
    ['Meningococcal ACWY', 'immunization', 1, 0, 14, 'Booster every 5 years for Sahel deployments.', 'mening'],
    ["Government ID / Driver's License", 'id', 1, 0, 30, 'Renew with your state DMV.', 'license'],
    ['Medical Fitness Clearance', 'clearance', 1, 0, 21, 'Annual deployment physical. Schedule with the company clinic.', 'medical'],
    ['Background Check', 'clearance', 1, 0, 30, 'Complete, up-to-date background check required for every deployment. Valid 1 year from completion. Upload your provider report; the office marks it cleared.', 'background'],
  ].forEach((r) => { R[r[0]] = Number(rt.run(...r).lastInsertRowid); });
  db.prepare("UPDATE requirement_types SET is_check = 1, validity_days = 365 WHERE name = 'Background Check'").run();

  const SITE_TARGET = { 'Erbil, Iraq': [8, 10], 'Camp Arifjan, Kuwait': [7, 9], 'Camp Lemonnier, Djibouti': [6, 8], 'Niamey, Niger': [4, 6] };
  const dest = db.prepare('INSERT INTO destinations (name, country, region, airport, notes) VALUES (?,?,?,?,?)');
  const dr = db.prepare('INSERT INTO destination_requirements VALUES (?,?)');
  const D = {};
  const common = ['Passport', 'Hepatitis A', 'Typhoid', "Government ID / Driver's License", 'Background Check'];
  [
    ['Erbil, Iraq', 'Iraq', 'Middle East', 'EBL', 'Kurdistan Region site', [...common, 'Iraq Work Visa', 'Tdap (Tetanus)', 'Medical Fitness Clearance']],
    ['Camp Arifjan, Kuwait', 'Kuwait', 'Middle East', 'KWI', 'Logistics hub', [...common, 'Kuwait Work Visa', 'Tdap (Tetanus)']],
    ['Camp Lemonnier, Djibouti', 'Djibouti', 'Africa', 'JIB', 'Horn of Africa site', [...common, 'Djibouti Entry Visa', 'Yellow Fever Vaccine']],
    ['Niamey, Niger', 'Niger', 'Africa', 'NIM', 'Sahel site', [...common, 'Niger Visa', 'Yellow Fever Vaccine', 'Meningococcal ACWY']],
  ].forEach(([n, c, r, a, notes, reqs]) => {
    const id = Number(dest.run(n, c, r, a, notes).lastInsertRowid); D[n] = id;
    const tgt = SITE_TARGET[n]; // on-rotation target per site (min) and overstaffed above (max); sums to the 25 overall target
    db.prepare('UPDATE destinations SET min_headcount = ?, max_headcount = ? WHERE id = ?').run(tgt[0], tgt[1], id);
    reqs.forEach((q) => dr.run(id, R[q]));
  });

  const ins = db.prepare(`INSERT INTO contractors (name, employee_no, phone, email, home_airport, alt_airport, destination_id, deploy_date, rotation_on, rotation_off, override_status, override_reason, notes)
    VALUES (?,?,?,?,?,?,?,?,60,30,?,?,?)`);
  const doc = db.prepare(`INSERT INTO documents (contractor_id, requirement_type_id, ref_last4, issued, expires, status, notes) VALUES (?,?,?,?,?,'valid','')`);
  const user = db.prepare('INSERT INTO users (email, password_hash, role, contractor_id) VALUES (?,?,?,?)');
  const prof = db.prepare('INSERT INTO profiles (contractor_id, data_enc, updated_by) VALUES (?,?,?)');
  const PW = demoPasswords();
  const pwHash = hashPassword(PW.contractor);
  user.run(ADMIN_EMAIL, hashPassword(PW.admin), 'admin', null);

  // Default "far-out" expiries; per-contractor overrides below.
  const GOOD = { 'Passport': 2200, 'Iraq Work Visa': 700, 'Kuwait Work Visa': 700, 'Djibouti Entry Visa': 600, 'Niger Visa': 600,
    'Yellow Fever Vaccine': null, 'Hepatitis A': null, 'Typhoid': 540, 'Tdap (Tetanus)': 2900, 'Meningococcal ACWY': 1500,
    "Government ID / Driver's License": 1400, 'Medical Fitness Clearance': 300, 'Background Check': 300 };
  const people = [
    // name, emp, scenario, destination, deploy offset, {req: expiry offset | 'missing'}, override, blocker, home
    ['Marcus Delgado', 'RT-1001', 'A · Green — cleared to deploy (departs tomorrow)', 'Erbil, Iraq', 1, {}, null, null, 'IAH', 'HOU'],
    ['Dana Whitfield', 'RT-1002', 'Yellow — background check renewal due; flying home in 2 days', 'Camp Arifjan, Kuwait', -58, { 'Background Check': 75 }, null, null, 'DFW', 'DAL'],
    ['Tyler Brandt', 'RT-1003', 'Green — Africa site, AI booking allowed', 'Camp Lemonnier, Djibouti', 35, {}, null, null, 'ATL', ''],
    ['Cody Ramirez', 'RT-1004', 'B · Yellow — passport expires before next rotation (departs in 3 days)', 'Erbil, Iraq', 3, { 'Passport': 300 }, null, null, 'MEM', 'BNA'],
    ['Brianna Holt', 'RT-1005', 'Yellow — typhoid shot lapses before next rotation (departs today)', 'Camp Arifjan, Kuwait', 0, { 'Typhoid': 120 }, null, null, 'DEN', 'COS'],
    ['Wes Calloway', 'RT-1006', 'Yellow — annual medical lapses; rotation in 6 days, no flight booked yet', 'Erbil, Iraq', 6, { 'Medical Fitness Clearance': 130 }, null, null, 'SAT', 'AUS'],
    ['John Doe', 'RT-1007', 'D · Red — missing yellow fever shot (live fix demo)', 'Camp Lemonnier, Djibouti', 30, { 'Yellow Fever Vaccine': 'missing' }, null, null, 'MEM', 'LIT'],
    ['Sam Kowalski', 'RT-1008', 'C · Red — expired passport + missing Iraq visa (booked to fly in 4 days!)', 'Erbil, Iraq', 4, { 'Passport': -10, 'Iraq Work Visa': 'missing' }, null, null, 'MSY', 'BTR'],
    ['Trent Vaughn', 'RT-1009', 'Red — background check in progress + HR hold', 'Camp Arifjan, Kuwait', 25, { 'Background Check': 'in_progress' }, 'red', 'Pending background re-investigation', 'OKC', 'TUL'],
    ['Ray Castillo', 'RT-1010', 'Green — deployed now (Erbil), checking in', 'Erbil, Iraq', -25, {}, null, null, 'ELP', 'ABQ'],
    ['Luis Fontaine', 'RT-1011', 'Green — deployed (Djibouti), flying home today', 'Camp Lemonnier, Djibouti', -60, {}, null, null, 'JAX', 'SAV'],
    ['Mike Brennan', 'RT-1012', 'Green — deployed now (Niger), check-in OVERDUE', 'Niamey, Niger', -10, {}, null, null, 'TUS', 'PHX'],
    ['David Tran', 'RT-1013', 'Showcase — green, fully complete profile, deployed Djibouti', 'Camp Lemonnier, Djibouti', -20, {}, null, null, 'SEA', 'PDX'],
  ];
  // ---- 67 more fictional crew (seed-assets/crew.json, one AI portrait each) -> ~80 total, ~25 on rotation, 5 swing ----
  // Rotational crew fly 60 on / 120 off (so ~1/3 are deployed on any day); phases are spread evenly per site.
  const CREW = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seed-assets', 'crew.json'), 'utf8'));
  const GEN = {};
  const SITES = ['Erbil, Iraq', 'Camp Arifjan, Kuwait', 'Camp Lemonnier, Djibouti', 'Niamey, Niger'];
  const PLAN = { 'Erbil, Iraq': 16, 'Camp Arifjan, Kuwait': 15, 'Camp Lemonnier, Djibouti': 11, 'Niamey, Niger': 10 }; // rotational crew per site
  const SITE_PHASE = { 'Erbil, Iraq': 3, 'Camp Arifjan, Kuwait': 9, 'Camp Lemonnier, Djibouti': 5, 'Niamey, Niger': 11 };
  const TITLE_MIX = ['Aircraft Maintenance Technician', 'A&P Mechanic', 'Aircraft Maintenance Technician', 'Avionics Technician', 'A&P Mechanic', 'Aircraft Maintenance Technician',
    'Crew Chief', 'A&P Mechanic', 'Inspector / QA', 'Aircraft Maintenance Technician', 'Avionics Technician', 'Lead', 'Aircraft Maintenance Technician', 'A&P Mechanic', 'Supervisor',
    'Avionics Technician', 'Aircraft Maintenance Technician', 'Crew Chief', 'A&P Mechanic', 'Site Manager'];
  const YELLOW_DOC = ['Typhoid', 'Passport', 'Tdap (Tetanus)', "Government ID / Driver's License"];
  let k = 0;
  const take = () => CREW[k++];
  // 5 swing / fill-in people: no fixed rotation; 3 green, 1 yellow, 1 red
  [['Erbil, Iraq', {}], ['Camp Arifjan, Kuwait', {}], ['Camp Lemonnier, Djibouti', {}], ['Camp Arifjan, Kuwait', { 'Passport': 300 }], ['Erbil, Iraq', { 'Iraq Work Visa': 'missing' }]]
    .forEach(([site, exc], j) => { const p = take(); GEN[p.name] = { ...p, kind: 'swing', site, title: ['A&P Mechanic', 'Aircraft Maintenance Technician', 'Avionics Technician', 'Crew Chief', 'A&P Mechanic'][j] };
      people.push([p.name, p.emp, `Swing / fill-in — ${Object.keys(exc).length ? (Object.values(exc)[0] === 'missing' ? 'RED (missing visa), not assignable' : 'YELLOW (passport renewal due)') : 'ready to fill gaps'}`, site, 7 + j, exc, null, null, p.home, p.alt]); });
  // rotational crew, evenly phased per site
  let g = 0;
  for (const site of SITES) for (let j = 0; j < PLAN[site]; j++) {
    const p = take(); const ph = (SITE_PHASE[site] + Math.round((j * 180) / PLAN[site])) % 180; const off = ph - 60; // -60..119
    const exc = { 'Medical Fitness Clearance': 330 + (g % 5) * 6, 'Background Check': 330 + (g % 6) * 5 }; if (g % 9 === 4) exc[YELLOW_DOC[g % 4]] = off + 200 > 0 ? Math.max(30, off + 150) : 30; if (g % 23 === 11) exc['Hepatitis A'] = 'missing';
    GEN[p.name] = { ...p, kind: 'rot', site, off, title: TITLE_MIX[g % TITLE_MIX.length] };
    people.push([p.name, p.emp, `Rotational crew — 60 on / 120 off (${site.split(',')[0]})`, site, off, exc, null, null, p.home, p.alt]); g++;
  }
  // everyone else: between rotations (next rotation 2-5 months out)
  while (k < CREW.length) { const p = take(); const site = SITES[k % 4]; const off = 40 + ((k * 23) % 60);
    GEN[p.name] = { ...p, kind: 'reserve', site, off, title: TITLE_MIX[(k * 7) % TITLE_MIX.length] };
    people.push([p.name, p.emp, 'Off — between rotations', site, off, { 'Medical Fitness Clearance': 340, 'Background Check': 345 }, null, null, p.home, p.alt]); }
  const LOOK = { // gender, age, hair, eyes, height ft/in, weight — matches the generated headshot in seed-assets/headshots/<emp>.jpg
    'Marcus Delgado': ['Male', 29, 'Black', 'Brown', '5', '10', '182'], 'Dana Whitfield': ['Female', 31, 'Blond', 'Blue', '5', '6', '138'],
    'Tyler Brandt': ['Male', 33, 'Brown', 'Hazel', '6', '1', '190'], 'Cody Ramirez': ['Male', 35, 'Black', 'Brown', '5', '9', '178'],
    'Brianna Holt': ['Female', 37, 'Black', 'Brown', '5', '5', '142'], 'Wes Calloway': ['Male', 39, 'Brown', 'Blue', '6', '0', '201'],
    'John Doe': ['Male', 41, 'Black', 'Brown', '5', '11', '188'], 'Sam Kowalski': ['Male', 43, 'Bald', 'Gray', '6', '2', '226'],
    'Trent Vaughn': ['Male', 45, 'Gray', 'Brown', '5', '11', '195'], 'Ray Castillo': ['Male', 47, 'Black', 'Brown', '5', '8', '184'],
    'Luis Fontaine': ['Male', 49, 'Gray', 'Brown', '5', '10', '190'], 'Mike Brennan': ['Male', 51, 'Brown', 'Hazel', '6', '0', '205'],
    'David Tran': ['Male', 38, 'Black', 'Brown', '5', '9', '168'] };
  const HOMEC = (a) => ({ IAH: ['Katy', 'TX', '77494'], DFW: ['Arlington', 'TX', '76010'], ATL: ['Peachtree City', 'GA', '30269'], MEM: ['Germantown', 'TN', '38138'],
    DEN: ['Aurora', 'CO', '80012'], SAT: ['New Braunfels', 'TX', '78130'], MSY: ['Mandeville', 'LA', '70448'], OKC: ['Norman', 'OK', '73069'], ELP: ['El Paso', 'TX', '79936'],
    JAX: ['Orange Park', 'FL', '32073'], TUS: ['Tucson', 'AZ', '85710'], SEA: ['Renton', 'WA', '98055'] })[a] || ['Katy', 'TX', '77494'];
  const reqsFor = db.prepare('SELECT rt.* FROM requirement_types rt JOIN destination_requirements dr ON dr.requirement_type_id = rt.id WHERE dr.destination_id = ?');
  const ids = {};
  people.forEach(([name, emp, scenario, dn, off, exc, ovr, ovrReason, home, alt], i) => {
    const first = name.split(' ')[0].toLowerCase();
    const email = `${first}@ffd.demo`;
    const phone = `(555) 01${String(i).padStart(2, '0')}-${2000 + i * 37}`;
    const cid = Number(ins.run(name, emp, phone, email, home, alt, D[dn], d(off), ovr, ovr ? ovrReason : null, scenario).lastInsertRowid);
    ids[name] = cid;
    user.run(email, pwHash, 'contractor', cid);
    const destReqs = GEN[name] && GEN[name].kind === 'swing' ? db.prepare('SELECT * FROM requirement_types').all() : reqsFor.all(D[dn]); // swing crew float, so they hold every site's visas/shots
    const G = GEN[name]; const hw = (G && G.gender === 'Female') ? [['5', '4', '132'], ['5', '6', '141'], ['5', '7', '150'], ['5', '3', '126']][i % 4] : [['5', '9', '176'], ['5', '11', '188'], ['6', '0', '196'], ['5', '10', '182'], ['6', '2', '210']][i % 5];
    const look = LOOK[name] || (G ? [G.gender, G.age, G.hair, G.eyes, ...hw] : ['Male', 29 + i * 2, 'Brown', 'Brown', '5', '10', '185']);
    const pp = {};
    for (const r of destReqs) {
      const e = r.name in exc ? exc[r.name] : GOOD[r.name];
      if (e === 'missing') continue;
      if (r.is_check) {
        const inProg = e === 'in_progress'; const exp = inProg ? null : d(e);
        db.prepare(`INSERT INTO documents (contractor_id, requirement_type_id, ref_last4, issued, expires, status, check_status, provider, reference, notes)
          VALUES (?,?,?,?,?,'valid',?,?,?,?)`).run(cid, r.id, '', inProg ? d(-20) : d(e - 365), exp, inProg ? 'in_progress' : 'cleared', 'Sterling (demo)', `BG-DEMO-${1000 + cid * 37}`,
          inProg ? 'Re-investigation opened by HR' : '');
        continue;
      }
      const last4 = String(1000 + ((cid * 7919 + r.id * 104729) % 9000));
      const expires = r.has_expiry ? d(e) : null;
      const issued = r.category === 'immunization' ? d(-400 - r.id * 20) : d(-(r.category === 'passport' ? 1800 : 300));
      doc.run(cid, r.id, last4, issued, expires);
      pp[r.name] = { last4, issued, expires };
    }
    const [fn, ...ln] = name.split(' ');
    const destCountry = dn.split(', ')[1];
    prof.run(cid, encJSON({
      personal: { legal_first: fn, legal_middle: '', legal_last: ln.join(' '), preferred_name: '', dob: fmt(addDays(T, -365 * look[1] - i * 41)),
        place_of_birth: ['Houston, TX', 'Fort Worth, TX', 'Macon, GA', 'El Paso, TX', 'Pueblo, CO', 'San Antonio, TX', 'Beaumont, TX', 'Slidell, LA', 'Tulsa, OK'][i % 9],
        citizenship: 'United States', second_citizenship: '', gender: look[0],
        phone, alt_phone: i % 2 ? '' : `(555) 01${String(i).padStart(2, '0')}-9${100 + i * 3}`, email: `${first}.${ln.join('').toLowerCase().replace(/[^a-z]/g, '')}@example.com`, address: { line1: `${100 + i * 111} Demo Ranch Rd`, line2: '', city: HOMEC(home)[0], state: HOMEC(home)[1], postal: HOMEC(home)[2], country: 'USA' } },
      travel: { home_airport: home, alt_airport: alt || '' },
      emergency_contacts: [
        { name: `${['Pat', 'Chris', 'Jordan', 'Maria', 'Sam', 'Lee', 'Jane', 'Alex', 'Kim'][i % 9]} ${ln.join(' ')}`, relationship: ['Spouse', 'Husband', 'Wife', 'Wife', 'Mother', 'Spouse', 'Wife', 'Brother', 'Wife'][i % 9],
          phone: `(555) 02${String(i).padStart(2, '0')}-3100`, alt_phone: `(555) 02${String(i).padStart(2, '0')}-3199`, email: `family${i + 1}@example.com`, address: `Same as contractor` },
        ...(i % 3 !== 2 ? [{ name: `${['Ron', 'Linda', 'Gary', 'Rosa', 'Tom', 'Deb', 'Carl', 'Nina', 'Walt'][i % 9]} ${ln.join(' ')}`,
          relationship: 'Parent', phone: `(555) 03${String(i).padStart(2, '0')}-4200`, alt_phone: '', email: `parent${i + 1}@example.com`, address: `${200 + i * 17} Example Ave, Springfield, ${['TX', 'TX', 'GA', 'TN', 'CO', 'TX', 'TN', 'LA', 'OK'][i % 9]} 00000` }] : []),
      ],
      passport: pp.Passport ? { number: `DEMO${pp.Passport.last4.padStart(5, '0')}`, country: 'United States', issued: pp.Passport.issued, expires: pp.Passport.expires, place_of_issue: 'U.S. Department of State' } : {},
      visas: Object.entries(pp).filter(([k]) => /Visa/.test(k)).map(([k, v]) => ({ country: destCountry, type: k, number: `V-DEMO-${v.last4}`, issued: v.issued, expires: v.expires, entries: i % 2 ? 'Single' : 'Multiple', upload: null })),
      physical: pp['Medical Fitness Clearance'] ? { last_exam: pp['Medical Fitness Clearance'].issued, expires: pp['Medical Fitness Clearance'].expires, provider: 'Company Clinic (demo)', upload: null }
        : { last_exam: d(-120 - i * 9), expires: d(245 - i * 9), provider: 'Company Clinic (demo)', upload: null },
      description: { height_ft: look[4], height_in: look[5], weight_lbs: look[6], eye_color: look[3], hair_color: look[2] },
      medications: [[{ name: 'Lisinopril', dose: '10 mg', frequency: 'Once daily' }], [], [{ name: 'Cetirizine', dose: '10 mg', frequency: 'As needed' }], [], [{ name: 'Levothyroxine', dose: '50 mcg', frequency: 'Once daily' }],
        [{ name: 'Atorvastatin', dose: '20 mg', frequency: 'Once daily' }, { name: 'Ibuprofen', dose: '400 mg', frequency: 'As needed' }], [], [{ name: 'Omeprazole', dose: '20 mg', frequency: 'Once daily' }], [{ name: 'Metformin', dose: '500 mg', frequency: 'Twice daily' }]][i % 9],
      gov_id: pp["Government ID / Driver's License"] ? { type: "Driver's License", number: `DL-DEMO-${pp["Government ID / Driver's License"].last4}`, state: 'TX', expires: pp["Government ID / Driver's License"].expires } : {},
      immunizations: Object.entries(pp).filter(([k]) => destReqs.find((r) => r.name === k && r.category === 'immunization'))
        .map(([k, v]) => ({ vaccine: k, dates: v.issued, expires: v.expires, notes: '' })),
      medical: { blood_type: ['O+', 'A+', 'B+', 'O-', 'A-', 'AB+', 'O+', 'B-', 'A+'][i % 9], allergies: ['Penicillin', 'None known', 'Seasonal pollen', 'Penicillin', 'Shellfish', 'None known', 'Penicillin, bee stings', 'Sulfa drugs', 'None known'][i % 9],
        conditions: ['Controlled hypertension', 'None', 'Mild seasonal allergies', 'None', 'Hypothyroidism (controlled)', 'High cholesterol', 'None', 'GERD', 'Type 2 diabetes (controlled)'][i % 9], medications: '', notes: '' },
      clearances: pp['Medical Fitness Clearance'] ? [{ type: 'Medical Fitness', level: 'Fit for deployment', granted: pp['Medical Fitness Clearance'].issued, expires: pp['Medical Fitness Clearance'].expires }] : [],
      employment: { employer: 'FFD Demo Services LLC', position: GEN[name] ? GEN[name].title : ['Crew Chief', 'Inspector / QA', 'Avionics Technician', 'A&P Mechanic', 'Aircraft Maintenance Technician', 'A&P Mechanic', 'Aircraft Maintenance Technician', 'Avionics Technician', 'Supervisor', 'Lead', 'Aircraft Maintenance Technician', 'Site Manager', 'Lead'][i] || 'Aircraft Maintenance Technician',
        employee_no: emp, supervisor: 'Ops Manager (Demo)', start_date: d(-700 - i * 90) },
    }), 'seed');
  });
  db.prepare("INSERT INTO blockers (contractor_id, description) VALUES (?, 'Background re-investigation pending — HR hold')").run(ids['Trent Vaughn']);
  // Crew schedule: 60/30 pattern laid out from ~3 months back to ~4 months ahead, plus training and leave in OFF time.
  const SCH = require('./schedule');
  const hist = db.prepare('INSERT INTO schedule_blocks (contractor_id, kind, start, end, destination_id, notes) VALUES (?,?,?,?,?,?)');
  people.forEach(([name, , , dn, off]) => {
    if (GEN[name]) { // generated crew: 60 on / 120 off from one cycle back; swing people just have an open availability window
      const G = GEN[name]; const cid = ids[name];
      db.prepare('UPDATE contractors SET rotation_off = ?, swing = ? WHERE id = ?').run(G.kind === 'swing' ? 30 : 120, G.kind === 'swing' ? 1 : 0, cid);
      if (G.kind === 'swing') { hist.run(cid, 'off', d(-60), d(120), null, 'Swing / fill-in pool — available to cover gaps'); return; }
      if (G.kind === 'reserve') { SCH.generate(cid, d(off - 240), 60, 120, D[dn], 1); db.prepare('UPDATE contractors SET deploy_date = ? WHERE id = ?').run(d(off), cid); return; } // last rotation done; next not scheduled yet
      SCH.generate(cid, d(off - 180), 60, 120, D[dn], 3);
      return;
    }
    // past rotations: step back 90 days per cycle; if one would still be running today the guy had an extended break instead
    let p = off - 90; while (p + 60 >= 0) p -= 15;
    const starts = [p - 90, p].filter((x) => x + 60 >= -100);
    starts.forEach((st, k) => {
      hist.run(ids[name], 'on', d(st), d(st + 60), D[dn], '');
      const nxt = k + 1 < starts.length ? starts[k + 1] : off;
      if (nxt - (st + 60) > 1) hist.run(ids[name], 'off', d(st + 61), d(nxt - 1), null, nxt - (st + 60) > 31 ? 'Extended break' : '');
    });
    SCH.generate(ids[name], d(off), 60, 30, D[dn], 3);
  });
  // Trent's last rotation ran long (held over until yesterday), so Arifjan's one clear coverage gap starts after Dana flies home
  db.prepare("UPDATE schedule_blocks SET end = ? WHERE contractor_id = ? AND kind = 'on' AND end = ?").run(d(-1), ids['Trent Vaughn'], d(-5));
  db.prepare("UPDATE schedule_blocks SET start = ? WHERE contractor_id = ? AND kind = 'off' AND start = ?").run(d(0), ids['Trent Vaughn'], d(-4));
  const extra = db.prepare('INSERT INTO schedule_blocks (contractor_id, kind, start, end, notes) VALUES (?,?,?,?,?)');
  extra.run(ids['Tyler Brandt'], 'training', d(9), d(11), 'Recurrent HAZMAT + egress training (Atlanta)');
  extra.run(ids['John Doe'], 'training', d(14), d(15), 'Pre-deployment brief — Africa sites');
  extra.run(ids['Trent Vaughn'], 'leave', d(2), d(8), 'Family leave (approved)');
  extra.run(ids['Mike Brennan'], 'leave', d(55), d(65), 'Holiday leave');
  extra.run(ids['Ray Castillo'], 'training', d(50), d(52), 'Avionics recurrent');
  // Titles (kept across resets so Leslie's real list survives the nightly reseed)
  const TITLES = ['Aircraft Maintenance Technician', 'A&P Mechanic', 'Avionics Technician', 'Crew Chief', 'Inspector / QA', 'Supervisor', 'Lead', 'Site Manager'];
  if (!db.prepare('SELECT COUNT(*) n FROM titles').get().n) TITLES.forEach((t, k) => db.prepare('INSERT INTO titles (name, sort) VALUES (?,?)').run(t, k));
  const pick = { 'Marcus Delgado': 'Crew Chief', 'Dana Whitfield': 'Inspector / QA', 'Tyler Brandt': 'Avionics Technician', 'Cody Ramirez': 'A&P Mechanic', 'Brianna Holt': 'Aircraft Maintenance Technician',
    'Wes Calloway': 'A&P Mechanic', 'John Doe': 'Aircraft Maintenance Technician', 'Sam Kowalski': 'Avionics Technician', 'Trent Vaughn': 'Supervisor', 'Ray Castillo': 'Lead',
    'Luis Fontaine': 'Aircraft Maintenance Technician', 'Mike Brennan': 'Site Manager', 'David Tran': 'Lead' };
  Object.values(GEN).forEach((G) => { pick[G.name] = G.title; });
  for (const [n, t] of Object.entries(pick)) db.prepare('UPDATE contractors SET title_id = (SELECT id FROM titles WHERE name = ?) WHERE id = ?').run(t, ids[n]);

  const flIns = db.prepare(`INSERT INTO flights (contractor_id, airline, flight_no, from_airport, to_airport, depart_at, arrive_at, confirmation, seat, notes, sent_at, seen_at, direction)
    VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now', ?),?,?)`);
  let dir = 'outbound';
  const fl = { run: (...a) => flIns.run(...a, dir) };
  const al = db.prepare("INSERT INTO alerts (contractor_id, kind, title, body, sent_by, created_at, read_at) VALUES (?,?,?,?,'admin',datetime('now', ?),?)");
  // Departures / returns spread over today + next 7 days for the Daily Deployment Report (one case per flag type)
  fl.run(ids['Marcus Delgado'], 'Qatar Airways', 'QR 714', 'IAH', 'DOH', `${d(1)}T19:45`, `${d(2)}T17:30`, 'QRDEMO1', '34C', 'Report to IAH Terminal D by 16:45. Bring passport + visa letter.', '-2 hours', null);
  fl.run(ids['Marcus Delgado'], 'Qatar Airways', 'QR 450', 'DOH', 'EBL', `${d(2)}T20:10`, `${d(2)}T22:40`, 'QRDEMO1', '18A', 'Site driver meets you at arrivals.', '-2 hours', null);
  db.prepare("UPDATE flights SET updated_at = datetime('now', '-3 hours') WHERE flight_no = 'QR 450' AND contractor_id = ?").run(ids['Marcus Delgado']); // flag: changed in last 24h
  fl.run(ids['Cody Ramirez'], 'Delta', 'DL 1123', 'MEM', 'ATL', `${d(3)}T06:10`, `${d(3)}T08:35`, 'TKDEMO4', '14C', 'Renew passport after this rotation!', '-1 days', d(0));
  fl.run(ids['Cody Ramirez'], 'Turkish Airlines', 'TK 32', 'ATL', 'IST', `${d(3)}T12:20`, `${d(4)}T06:05`, 'TKDEMO4', '27H', '', '-1 days', d(0));
  fl.run(ids['Cody Ramirez'], 'Turkish Airlines', 'TK 1092', 'IST', 'EBL', `${d(4)}T09:40`, `${d(4)}T12:55`, 'TKDEMO4', '9A', '', '-1 days', d(0));
  fl.run(ids['Brianna Holt'], 'United', 'UA 2210', 'DEN', 'IAD', `${d(0)}T07:00`, `${d(0)}T12:45`, 'UADEMO5', '22F', '', '-2 days', d(-1));
  fl.run(ids['Brianna Holt'], 'Kuwait Airways', 'KU 118', 'IAD', 'KWI', `${d(0)}T17:30`, `${d(1)}T13:20`, 'UADEMO5', '31A', 'Typhoid booster due before next rotation.', '-2 days', d(-1));
  fl.run(ids['Sam Kowalski'], 'Turkish Airlines', 'TK 8', 'MSY', 'IST', `${d(4)}T15:05`, `${d(5)}T10:40`, 'TKDEMO8', '', 'BOOKED BEFORE DOCS CLEARED — hold or cancel.', '-3 days', d(-2)); // flag: RED traveling
  fl.run(ids['Sam Kowalski'], 'Turkish Airlines', 'TK 1094', 'IST', 'EBL', `${d(5)}T13:15`, `${d(5)}T16:30`, 'TKDEMO8', '', '', '-3 days', d(-2));
  dir = 'return';
  fl.run(ids['Luis Fontaine'], 'Flydubai', 'FZ 622', 'JIB', 'DXB', `${d(0)}T03:15`, `${d(0)}T08:00`, 'FZDEMO2', '12A', 'End of rotation — turn in site badge.', '-4 days', d(-3));
  fl.run(ids['Luis Fontaine'], 'Emirates', 'EK 231', 'DXB', 'IAD', `${d(0)}T09:30`, `${d(0)}T15:20`, 'FZDEMO2', '40C', '', '-4 days', d(-3));
  fl.run(ids['Luis Fontaine'], 'American', 'AA 2741', 'IAD', 'JAX', `${d(0)}T18:05`, `${d(0)}T20:10`, 'FZDEMO2', '', '', '-4 days', d(-3));
  fl.run(ids['Dana Whitfield'], 'Emirates', 'EK 856', 'KWI', 'DXB', `${d(2)}T09:20`, `${d(2)}T11:55`, 'EKDEMO7', '22K', 'Return leg — end of rotation.', '-6 days', d(-5));
  fl.run(ids['Dana Whitfield'], 'Emirates', 'EK 221', 'DXB', 'DFW', `${d(2)}T14:30`, `${d(2)}T20:05`, 'EKDEMO7', '41A', '', '-6 days', d(-5));
  dir = 'outbound';
  al.run(ids['Marcus Delgado'], 'flight', 'Your flights are booked', 'IAH → DOH → EBL, confirmation QRDEMO1. Check the Flights tab.', '-2 hours', null);
  al.run(ids['Cody Ramirez'], 'readiness', 'Passport renewal needed', 'Your passport will not meet the 6-month rule for your next rotation. Start renewal after this trip.', '-1 days', null);
  al.run(ids['John Doe'], 'urgent', 'Yellow fever shot required', 'Djibouti requires a yellow fever vaccine. Upload your yellow card in the app as soon as you have it.', '-3 hours', null);
  // Mock check-ins for deployed contractors (consented). Mike Brennan is overdue (>12h).
  const { encJSON: enc } = require('./crypto');
  const ci = db.prepare("INSERT INTO checkins (contractor_id, kind, loc_enc, created_at) VALUES (?,?,?,datetime('now', ?))");
  [['Dana Whitfield', 29.1739, 48.0981, ['-26 hours', '-14 hours', '-2 hours']], ['Ray Castillo', 36.2380, 43.9631, ['-9 hours', '-1 hours']],
    ['Luis Fontaine', 11.5470, 43.1556, ['-11 hours', '-5 hours']], ['Mike Brennan', 13.4817, 2.1834, ['-40 hours', '-20 hours']]].forEach(([n, lat, lng, times], k) => {
    db.prepare("UPDATE contractors SET tracking_consent = 1, tracking_consent_at = datetime('now', '-9 days') WHERE id = ?").run(ids[n]);
    times.forEach((t, j) => ci.run(ids[n], j === times.length - 1 ? 'checkin' : 'auto', enc({ lat: lat + (j - 1) * 0.004 + k * 0.001, lng: lng + (j - 1) * 0.003, acc: 25 + j * 10 }), t));
  });
  // Generated crew: linked flights for the current / most recent rotation (outbound + return) and anything starting in the next 3 weeks
  const ROUTE = { EBL: [['Qatar Airways', 'QR 730', 'DOH', '16:25', '+1 15:50'], ['Qatar Airways', 'QR 450', 'EBL', '+1 20:10', '+1 22:40']],
    KWI: [['Qatar Airways', 'QR 730', 'DOH', '16:25', '+1 15:50'], ['Qatar Airways', 'QR 1072', 'KWI', '+1 19:05', '+1 20:10']],
    JIB: [['Emirates', 'EK 222', 'DXB', '19:55', '+1 18:35'], ['Flydubai', 'FZ 621', 'JIB', '+2 07:55', '+2 10:20']],
    NIM: [['Air France', 'AF 23', 'CDG', '15:30', '+1 07:10'], ['Air France', 'AF 516', 'NIM', '+1 10:35', '+1 15:05']] };
  const BACK = { EBL: [['Qatar Airways', 'QR 451', 'DOH', '23:55', '+1 01:45'], ['Qatar Airways', 'QR 731', 'DFW', '+1 08:20', '+1 15:05']],
    KWI: [['Qatar Airways', 'QR 1077', 'DOH', '07:40', '08:45'], ['Qatar Airways', 'QR 731', 'DFW', '+1 08:20', '+1 15:05']],
    JIB: [['Flydubai', 'FZ 622', 'DXB', '03:15', '08:00'], ['Emirates', 'EK 221', 'DFW', '09:30', '15:20']],
    NIM: [['Air France', 'AF 517', 'CDG', '23:50', '+1 06:20'], ['Air France', 'AF 22', 'DFW', '+1 10:40', '+1 14:05']] };
  const at = (day, hm) => { const m = /^\+(\d) (.*)$/.exec(hm); return `${plusD(day, m ? +m[1] : 0)}T${m ? m[2] : hm}`; };
  const plusD = (iso, n) => fmt(addDays(new Date(`${iso}T12:00:00`), n));
  const SEATS = 'ACDFHK';
  Object.values(GEN).forEach((G, j) => {
    const cid = ids[G.name]; const site = db.prepare('SELECT d.airport FROM contractors c JOIN destinations d ON d.id = c.destination_id WHERE c.id = ?').get(cid).airport;
    const tday = d(0); const ons = db.prepare("SELECT * FROM schedule_blocks WHERE contractor_id = ? AND kind = 'on' ORDER BY start").all(cid);
    const pastOrNow = ons.filter((b) => b.start <= tday).pop(); const soon = ons.find((b) => b.start > tday && b.start <= d(5)); // 6-30 days out are left for the ticket approval queue
    const conf = (n) => `${G.emp.slice(3)}${'QRZXKM'[n % 6]}${String.fromCharCode(65 + (j % 26))}`;
    const trip = (day, legs, dirn, n, seenOffset) => {
      dir = dirn; const code = `FF${conf(n)}`;
      const first = dirn === 'outbound' ? (G.home === 'DFW' ? [] : [['American', `AA ${1100 + (j * 13) % 800}`, 'DFW', '06:15', '08:40']]) : [];
      const tail = dirn === 'return' && G.home !== 'DFW' ? [['American', `AA ${2100 + (j * 17) % 800}`, G.home, '+1 17:30', '+1 19:45']] : [];
      let from = dirn === 'outbound' ? G.home : site;
      [...first, ...legs, ...tail].forEach(([al, no, to, dep, arr], q) => {
        const seen = seenOffset === null ? null : d(seenOffset);
        fl.run(cid, al, no, from, to, at(day, dep), at(day, arr), code, `${10 + ((j * 7 + q * 5) % 30)}${SEATS[(j + q) % 6]}`, q === 0 ? (dirn === 'outbound' ? 'Report 3 hours before departure. Passport + visa letter.' : 'End of rotation — turn in site badge.') : '', '-5 days', seen);
        from = to;
      });
    };
    if (pastOrNow) { trip(pastOrNow.start, ROUTE[site], 'outbound', 1, -6); if (pastOrNow.end <= d(21)) trip(pastOrNow.end, BACK[site], 'return', 2, pastOrNow.end < tday ? -1 : null); }
    if (soon) trip(soon.start, ROUTE[site], 'outbound', 3, j % 3 ? -1 : null);
    if (pastOrNow && pastOrNow.end >= tday && j % 2 === 0) { // on site now: a couple of check-ins on the map
      const C0 = { EBL: [36.237, 43.963], KWI: [28.94, 48.09], JIB: [11.547, 43.155], NIM: [13.48, 2.17] }[site];
      db.prepare("UPDATE contractors SET tracking_consent = 1, tracking_consent_at = datetime('now', '-10 days') WHERE id = ?").run(cid);
      ci.run(cid, 'checkin', enc({ lat: C0[0] + (j % 7) * 0.003, lng: C0[1] + (j % 5) * 0.003, acc: 25 }), `-${2 + (j % 9)} hours`);
    }
  });
  dir = 'outbound';
  // AI-generated portraits of fictional people (seed-assets/headshots/<employee #>.jpg) -> encrypted uploads, pre-approved
  const HS = path.join(__dirname, '..', 'seed-assets', 'headshots'); fs.mkdirSync(UP, { recursive: true });
  for (const [n, cid] of Object.entries(ids)) {
    const emp = people.find((x) => x[0] === n)[1]; const f = path.join(HS, `${emp}.jpg`); if (!fs.existsSync(f)) continue;
    const buf = fs.readFileSync(f); const file = `${token()}.bin`; fs.writeFileSync(path.join(UP, file), encrypt(buf), { mode: 0o600 });
    const uid = Number(db.prepare("INSERT INTO uploads (contractor_id, label, mime, size, file, uploaded_by) VALUES (?, 'Headshot', 'image/jpeg', ?, ?, 'seed')").run(cid, buf.length, file).lastInsertRowid);
    db.prepare("UPDATE contractors SET headshot_upload_id = ?, headshot_status = 'approved', headshot_at = datetime('now', '-30 days') WHERE id = ?").run(uid, cid);
  }
  // Every profile has linked flights: past legs of the current/last rotation plus anything already booked ahead
  dir = 'outbound';
  fl.run(ids['Tyler Brandt'], 'Delta', 'DL 8', 'ATL', 'CDG', `${d(35)}T17:40`, `${d(36)}T07:30`, 'AFDEMO3', '31C', 'Booked early — Djibouti rotation.', '-1 days', d(0));
  fl.run(ids['Tyler Brandt'], 'Air France', 'AF 3640', 'CDG', 'JIB', `${d(36)}T10:15`, `${d(36)}T18:40`, 'AFDEMO3', '22A', '', '-1 days', d(0));
  fl.run(ids['Ray Castillo'], 'American', 'AA 2290', 'ELP', 'DFW', `${d(-25)}T06:05`, `${d(-25)}T09:00`, 'QRDEMO9', '12D', '', '-27 days', d(-26));
  fl.run(ids['Ray Castillo'], 'Qatar Airways', 'QR 730', 'DFW', 'DOH', `${d(-25)}T16:25`, `${d(-24)}T15:50`, 'QRDEMO9', '40A', '', '-27 days', d(-26));
  fl.run(ids['Ray Castillo'], 'Qatar Airways', 'QR 450', 'DOH', 'EBL', `${d(-24)}T20:10`, `${d(-24)}T22:40`, 'QRDEMO9', '19C', '', '-27 days', d(-26));
  fl.run(ids['Mike Brennan'], 'American', 'AA 1530', 'TUS', 'DFW', `${d(-10)}T07:15`, `${d(-10)}T11:50`, 'AFDEMO6', '9F', '', '-12 days', d(-11));
  fl.run(ids['Mike Brennan'], 'Air France', 'AF 23', 'DFW', 'CDG', `${d(-10)}T15:30`, `${d(-9)}T07:10`, 'AFDEMO6', '33K', '', '-12 days', d(-11));
  fl.run(ids['Mike Brennan'], 'Air France', 'AF 516', 'CDG', 'NIM', `${d(-9)}T10:35`, `${d(-9)}T15:05`, 'AFDEMO6', '18A', 'Site security escort at arrivals.', '-12 days', d(-11));
  fl.run(ids['David Tran'], 'Alaska', 'AS 340', 'SEA', 'SFO', `${d(-20)}T06:00`, `${d(-20)}T08:15`, 'EKDEMO5', '8A', '', '-22 days', d(-21));
  fl.run(ids['David Tran'], 'Emirates', 'EK 226', 'SFO', 'DXB', `${d(-20)}T15:50`, `${d(-19)}T19:45`, 'EKDEMO5', '44K', '', '-22 days', d(-21));
  fl.run(ids['David Tran'], 'Flydubai', 'FZ 621', 'DXB', 'JIB', `${d(-18)}T07:55`, `${d(-18)}T10:20`, 'EKDEMO5', '6C', 'Lemonnier transport desk meets you.', '-22 days', d(-21));
  dir = 'return';
  fl.run(ids['David Tran'], 'Flydubai', 'FZ 622', 'JIB', 'DXB', `${d(40)}T03:15`, `${d(40)}T08:00`, 'EKDEMO8', '7A', 'Return booked — end of rotation.', '-2 days', d(-1));
  fl.run(ids['David Tran'], 'Emirates', 'EK 229', 'DXB', 'SEA', `${d(40)}T09:05`, `${d(40)}T13:10`, 'EKDEMO8', '38C', '', '-2 days', d(-1));
  fl.run(ids['John Doe'], 'Flydubai', 'FZ 622', 'JIB', 'DXB', `${d(-13)}T03:15`, `${d(-13)}T08:00`, 'FZDEMO4', '14C', 'Last rotation home leg.', '-20 days', d(-19));
  fl.run(ids['John Doe'], 'Emirates', 'EK 211', 'DXB', 'IAH', `${d(-13)}T09:20`, `${d(-13)}T16:15`, 'FZDEMO4', '46A', '', '-20 days', d(-19));
  fl.run(ids['John Doe'], 'United', 'UA 4120', 'IAH', 'MEM', `${d(-13)}T19:00`, `${d(-13)}T20:40`, 'FZDEMO4', '', '', '-20 days', d(-19));
  fl.run(ids['Trent Vaughn'], 'Kuwait Airways', 'KU 117', 'KWI', 'JFK', `${d(-1)}T09:45`, `${d(-1)}T15:30`, 'KUDEMO1', '28H', 'Held over 4 days — home for HR review.', '-3 days', d(-2));
  fl.run(ids['Trent Vaughn'], 'American', 'AA 1123', 'JFK', 'OKC', `${d(-1)}T18:20`, `${d(-1)}T21:35`, 'KUDEMO1', '', '', '-3 days', d(-2));
  fl.run(ids['Wes Calloway'], 'Qatar Airways', 'QR 451', 'EBL', 'DOH', `${d(-24)}T23:55`, `${d(-23)}T01:45`, 'QRDEMO6', '20K', '', '-30 days', d(-29));
  fl.run(ids['Wes Calloway'], 'Qatar Airways', 'QR 713', 'DOH', 'IAH', `${d(-23)}T08:20`, `${d(-23)}T15:05`, 'QRDEMO6', '38D', 'Next rotation flights not booked yet.', '-30 days', d(-29));
  fl.run(ids['Wes Calloway'], 'United', 'UA 5540', 'IAH', 'SAT', `${d(-23)}T18:10`, `${d(-23)}T19:15`, 'QRDEMO6', '', '', '-30 days', d(-29));
  dir = 'outbound';
  db.prepare("UPDATE contractors SET tracking_consent = 1, tracking_consent_at = datetime('now', '-18 days') WHERE id = ?").run(ids['David Tran']);
  ['-7 hours', '-2 hours'].forEach((t, j) => ci.run(ids['David Tran'], j ? 'checkin' : 'auto', enc({ lat: 11.5432 + j * 0.002, lng: 43.1490 + j * 0.002, acc: 20 }), t));
  db.meta.set('seed_version', SEED_VERSION);
  return { ids };
}

const SEED_VERSION = '15'; // bump when demo data shape changes; demo servers reseed on boot
module.exports = { syncPasswords, seed, SEED_VERSION };
if (require.main === module) { seed(); console.log('Seeded.'); }

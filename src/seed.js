'use strict';
// Demo data — ALL names, numbers and people are fictional. Dates are relative to "today" so scenarios stay valid.
const db = require('./db');
const { hashPassword, encJSON } = require('./crypto');
const { today, fmt, addDays } = require('./status');

const ADMIN = { email: 'admin@ffd.demo', password: 'FFD!Admin2026' };
const CONTRACTOR_PW = 'Deploy!2026';

function seed() {
  const T = today();
  const d = (n) => fmt(addDays(T, n));
  db.exec(`DELETE FROM sessions; DELETE FROM push_subs; DELETE FROM alerts; DELETE FROM uploads; DELETE FROM flights;
    DELETE FROM blockers; DELETE FROM documents; DELETE FROM profiles; DELETE FROM users; DELETE FROM contractors;
    DELETE FROM destination_requirements; DELETE FROM destinations; DELETE FROM requirement_types; DELETE FROM audit_log;`);

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
  ].forEach((r) => { R[r[0]] = Number(rt.run(...r).lastInsertRowid); });

  const dest = db.prepare('INSERT INTO destinations (name, country, region, airport, notes) VALUES (?,?,?,?,?)');
  const dr = db.prepare('INSERT INTO destination_requirements VALUES (?,?)');
  const D = {};
  const common = ['Passport', 'Hepatitis A', 'Typhoid', "Government ID / Driver's License"];
  [
    ['Erbil, Iraq', 'Iraq', 'Middle East', 'EBL', 'Kurdistan Region site', [...common, 'Iraq Work Visa', 'Tdap (Tetanus)', 'Medical Fitness Clearance']],
    ['Camp Arifjan, Kuwait', 'Kuwait', 'Middle East', 'KWI', 'Logistics hub', [...common, 'Kuwait Work Visa', 'Tdap (Tetanus)']],
    ['Camp Lemonnier, Djibouti', 'Djibouti', 'Africa', 'JIB', 'Horn of Africa site', [...common, 'Djibouti Entry Visa', 'Yellow Fever Vaccine']],
    ['Niamey, Niger', 'Niger', 'Africa', 'NIM', 'Sahel site', [...common, 'Niger Visa', 'Yellow Fever Vaccine', 'Meningococcal ACWY']],
  ].forEach(([n, c, r, a, notes, reqs]) => {
    const id = Number(dest.run(n, c, r, a, notes).lastInsertRowid); D[n] = id;
    reqs.forEach((q) => dr.run(id, R[q]));
  });

  const ins = db.prepare(`INSERT INTO contractors (name, employee_no, phone, email, home_airport, destination_id, deploy_date, rotation_on, rotation_off, override_status, override_reason, notes)
    VALUES (?,?,?,?,?,?,?,60,30,?,?,?)`);
  const doc = db.prepare(`INSERT INTO documents (contractor_id, requirement_type_id, ref_last4, issued, expires, status, notes) VALUES (?,?,?,?,?,'valid','')`);
  const user = db.prepare('INSERT INTO users (email, password_hash, role, contractor_id) VALUES (?,?,?,?)');
  const prof = db.prepare('INSERT INTO profiles (contractor_id, data_enc, updated_by) VALUES (?,?,?)');
  const pwHash = hashPassword(CONTRACTOR_PW);
  user.run(ADMIN.email, hashPassword(ADMIN.password), 'admin', null);

  // Default "far-out" expiries; per-contractor overrides below.
  const GOOD = { 'Passport': 2200, 'Iraq Work Visa': 700, 'Kuwait Work Visa': 700, 'Djibouti Entry Visa': 600, 'Niger Visa': 600,
    'Yellow Fever Vaccine': null, 'Hepatitis A': null, 'Typhoid': 540, 'Tdap (Tetanus)': 2900, 'Meningococcal ACWY': 1500,
    "Government ID / Driver's License": 1400, 'Medical Fitness Clearance': 300 };
  const people = [
    // name, emp, scenario, destination, deploy offset, {req: expiry offset | 'missing'}, override, blocker, home
    ['Marcus Delgado', 'RT-1001', 'A · Green — cleared to deploy', 'Erbil, Iraq', 12, {}, null, null, 'IAH'],
    ['Dana Whitfield', 'RT-1002', 'Green — currently deployed', 'Camp Arifjan, Kuwait', -20, {}, null, null, 'DFW'],
    ['Tyler Brandt', 'RT-1003', 'Green — Africa site, AI booking allowed', 'Camp Lemonnier, Djibouti', 35, {}, null, null, 'ATL'],
    ['Cody Ramirez', 'RT-1004', 'B · Yellow — passport expires before next rotation', 'Erbil, Iraq', 10, { 'Passport': 300 }, null, null, 'IAH'],
    ['Brianna Holt', 'RT-1005', 'Yellow — typhoid shot lapses before next rotation', 'Camp Arifjan, Kuwait', 5, { 'Typhoid': 120 }, null, null, 'DEN'],
    ['Wes Calloway', 'RT-1006', 'Yellow — annual medical lapses before next rotation', 'Erbil, Iraq', 20, { 'Medical Fitness Clearance': 130 }, null, null, 'SAT'],
    ['John Doe', 'RT-1007', 'D · Red — missing yellow fever shot (live fix demo)', 'Camp Lemonnier, Djibouti', 32, { 'Yellow Fever Vaccine': 'missing' }, null, null, 'IAH'],
    ['Sam Kowalski', 'RT-1008', 'C · Red — expired passport + missing Iraq visa', 'Erbil, Iraq', 15, { 'Passport': -10, 'Iraq Work Visa': 'missing' }, null, null, 'MSY'],
    ['Trent Vaughn', 'RT-1009', 'Red — manual hold (admin override)', 'Camp Arifjan, Kuwait', 25, {}, 'red', 'Pending background re-investigation', 'OKC'],
  ];
  const reqsFor = db.prepare('SELECT rt.* FROM requirement_types rt JOIN destination_requirements dr ON dr.requirement_type_id = rt.id WHERE dr.destination_id = ?');
  const ids = {};
  people.forEach(([name, emp, scenario, dn, off, exc, ovr, ovrReason, home], i) => {
    const first = name.split(' ')[0].toLowerCase();
    const email = `${first}@ffd.demo`;
    const phone = `(555) 01${String(i).padStart(2, '0')}-${2000 + i * 37}`;
    const cid = Number(ins.run(name, emp, phone, email, home, D[dn], d(off), ovr, ovr ? ovrReason : null, scenario).lastInsertRowid);
    ids[name] = cid;
    user.run(email, pwHash, 'contractor', cid);
    const destReqs = reqsFor.all(D[dn]);
    const pp = {};
    for (const r of destReqs) {
      const e = r.name in exc ? exc[r.name] : GOOD[r.name];
      if (e === 'missing') continue;
      const last4 = String(1000 + ((cid * 7919 + r.id * 104729) % 9000));
      const expires = r.has_expiry ? d(e) : null;
      const issued = r.category === 'immunization' ? d(-400 - r.id * 20) : d(-(r.category === 'passport' ? 1800 : 300));
      doc.run(cid, r.id, last4, issued, expires);
      pp[r.name] = { last4, issued, expires };
    }
    const [fn, ...ln] = name.split(' ');
    const destCountry = dn.split(', ')[1];
    prof.run(cid, encJSON({
      personal: { legal_first: fn, legal_middle: '', legal_last: ln.join(' '), preferred_name: '', dob: fmt(addDays(T, -365 * (29 + i * 2) - i * 41)),
        place_of_birth: ['Houston, TX', 'Fort Worth, TX', 'Macon, GA', 'El Paso, TX', 'Pueblo, CO', 'San Antonio, TX', 'Beaumont, TX', 'Slidell, LA', 'Tulsa, OK'][i],
        citizenship: 'United States', second_citizenship: '', gender: name === 'Dana Whitfield' || name === 'Brianna Holt' ? 'Female' : 'Male',
        phone, email, address: { line1: `${100 + i * 111} Demo Ranch Rd`, line2: '', city: ['Katy', 'Arlington', 'Warner Robins', 'Killeen', 'Colorado Springs', 'New Braunfels', 'Lake Charles', 'Mandeville', 'Norman'][i],
          state: ['TX', 'TX', 'GA', 'TX', 'CO', 'TX', 'LA', 'LA', 'OK'][i], postal: String(70000 + i * 1111), country: 'USA' } },
      emergency_contacts: [{ name: `Pat ${ln.join(' ')}`, relationship: 'Spouse', phone: `(555) 02${String(i).padStart(2, '0')}-3100`, email: '' }],
      passport: pp.Passport ? { number: `DEMO${pp.Passport.last4.padStart(5, '0')}`, country: 'United States', issued: pp.Passport.issued, expires: pp.Passport.expires, place_of_issue: 'U.S. Department of State' } : {},
      visas: Object.entries(pp).filter(([k]) => /Visa/.test(k)).map(([k, v]) => ({ country: destCountry, type: k, number: `V-DEMO-${v.last4}`, issued: v.issued, expires: v.expires })),
      gov_id: pp["Government ID / Driver's License"] ? { type: "Driver's License", number: `DL-DEMO-${pp["Government ID / Driver's License"].last4}`, state: 'TX', expires: pp["Government ID / Driver's License"].expires } : {},
      immunizations: Object.entries(pp).filter(([k]) => destReqs.find((r) => r.name === k && r.category === 'immunization'))
        .map(([k, v]) => ({ vaccine: k, dates: v.issued, expires: v.expires, notes: '' })),
      medical: { blood_type: ['O+', 'A+', 'B+', 'O-', 'A-', 'AB+', 'O+', 'B-', 'A+'][i], allergies: i % 3 === 0 ? 'Penicillin' : 'None known', conditions: '', medications: '', notes: '' },
      clearances: pp['Medical Fitness Clearance'] ? [{ type: 'Medical Fitness', level: 'Fit for deployment', granted: pp['Medical Fitness Clearance'].issued, expires: pp['Medical Fitness Clearance'].expires }] : [],
      employment: { employer: 'FFD Demo Services LLC', position: ['Security Specialist', 'Logistics Coordinator', 'Site Medic', 'Security Specialist', 'Supply Tech', 'Electrician', 'Generator Mechanic', 'Security Specialist', 'Team Lead'][i],
        employee_no: emp, supervisor: 'Ops Manager (Demo)', start_date: d(-700 - i * 90) },
    }), 'seed');
  });
  db.prepare("INSERT INTO blockers (contractor_id, description) VALUES (?, 'Background re-investigation pending — HR hold')").run(ids['Trent Vaughn']);

  const fl = db.prepare(`INSERT INTO flights (contractor_id, airline, flight_no, from_airport, to_airport, depart_at, arrive_at, confirmation, seat, notes, sent_at, seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now', ?),?)`);
  const al = db.prepare("INSERT INTO alerts (contractor_id, kind, title, body, sent_by, created_at, read_at) VALUES (?,?,?,?,'admin',datetime('now', ?),?)");
  fl.run(ids['Marcus Delgado'], 'Qatar Airways', 'QR 714', 'IAH', 'DOH', `${d(12)}T19:45`, `${d(13)}T17:30`, 'QRDEMO1', '34C', 'Report to IAH Terminal D by 16:45. Bring passport + visa letter.', '-2 hours', null);
  fl.run(ids['Marcus Delgado'], 'Qatar Airways', 'QR 450', 'DOH', 'EBL', `${d(13)}T20:10`, `${d(13)}T22:40`, 'QRDEMO1', '18A', 'Site driver meets you at arrivals.', '-2 hours', null);
  fl.run(ids['Dana Whitfield'], 'Emirates', 'EK 856', 'KWI', 'DXB', `${d(40)}T09:20`, `${d(40)}T11:55`, 'EKDEMO7', '22K', 'Return leg — end of rotation.', '-6 days', d(-5));
  fl.run(ids['Dana Whitfield'], 'Emirates', 'EK 221', 'DXB', 'DFW', `${d(40)}T14:30`, `${d(40)}T20:05`, 'EKDEMO7', '41A', '', '-6 days', d(-5));
  fl.run(ids['Cody Ramirez'], 'Turkish Airlines', 'TK 34', 'IAH', 'IST', `${d(10)}T21:00`, `${d(11)}T16:50`, 'TKDEMO4', '27H', 'Renew passport after this rotation!', '-1 days', d(0));
  al.run(ids['Marcus Delgado'], 'flight', 'Your flights are booked', 'IAH → DOH → EBL, confirmation QRDEMO1. Check the Flights tab.', '-2 hours', null);
  al.run(ids['Cody Ramirez'], 'readiness', 'Passport renewal needed', 'Your passport will not meet the 6-month rule for your next rotation. Start renewal after this trip.', '-1 days', null);
  al.run(ids['John Doe'], 'urgent', 'Yellow fever shot required', 'Djibouti requires a yellow fever vaccine. Upload your yellow card in the app as soon as you have it.', '-3 hours', null);
  return { ids };
}

module.exports = { seed, ADMIN, CONTRACTOR_PW };
if (require.main === module) { seed(); console.log('Seeded.'); }

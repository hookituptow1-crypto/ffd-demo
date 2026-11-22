'use strict';
// Minimal schema-driven validator: unknown keys dropped, strings trimmed & length-capped, formats enforced.
class VErr extends Error { constructor(m) { super(m); this.status = 400; } }
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function str(v, max = 200, { required = false, pattern, name = 'field', oneOf } = {}) {
  if (v === undefined || v === null || v === '') { if (required) throw new VErr(`${name} is required`); return ''; }
  if (typeof v !== 'string' && typeof v !== 'number') throw new VErr(`${name} must be text`);
  const s = String(v).trim().replace(/[\u0000-\u001f\u007f]/g, (c) => (c === '\n' ? c : ''));
  if (s.length > max) throw new VErr(`${name} is too long (max ${max})`);
  if (required && !s) throw new VErr(`${name} is required`);
  if (s && pattern && !pattern.test(s)) throw new VErr(`${name} has an invalid format`);
  if (s && oneOf && !oneOf.includes(s)) throw new VErr(`${name} must be one of ${oneOf.join(', ')}`);
  return s;
}
const date = (v, o = {}) => { const s = str(v, 10, { ...o, pattern: DATE }); if (s && isNaN(Date.parse(s))) throw new VErr(`${o.name} invalid date`); return s || null; };
const dt = (v, o = {}) => str(v, 16, { ...o, pattern: DT }) || null;
function int(v, min, max, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new VErr(`${name} must be a whole number ${min}-${max}`);
  return n;
}

// Profile schema: 's' string(max) | 'd' date | {obj} | [schema, maxItems]
const S = (n) => ['s', n], D = ['d'];
const PROFILE = {
  personal: { legal_first: S(80), legal_middle: S(80), legal_last: S(80), preferred_name: S(80), dob: D,
    place_of_birth: S(120), citizenship: S(80), second_citizenship: S(80), gender: S(30), phone: S(40), email: S(120),
    address: { line1: S(160), line2: S(160), city: S(80), state: S(80), postal: S(20), country: S(80) } },
  emergency_contacts: [{ name: S(120), relationship: S(60), phone: S(40), email: S(120) }, 4],
  passport: { number: S(30), country: S(80), issued: D, expires: D, place_of_issue: S(120) },
  visas: [{ country: S(80), type: S(80), number: S(40), issued: D, expires: D }, 12],
  gov_id: { type: S(60), number: S(40), state: S(80), expires: D },
  immunizations: [{ vaccine: S(80), dates: S(160), expires: D, notes: S(200) }, 25],
  medical: { blood_type: ['s', 5, ['', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Unknown']], allergies: S(500),
    conditions: S(500), medications: S(500), notes: S(1000) },
  clearances: [{ type: S(80), level: S(80), granted: D, expires: D }, 10],
  employment: { employer: S(120), position: S(120), employee_no: S(40), supervisor: S(120), start_date: D },
};

function apply(schema, v, name) {
  if (Array.isArray(schema) && schema[0] === 's') return str(v, schema[1], { name, oneOf: schema[2] });
  if (Array.isArray(schema) && schema[0] === 'd') return date(v, { name });
  if (Array.isArray(schema)) {
    const arr = Array.isArray(v) ? v : [];
    if (arr.length > schema[1]) throw new VErr(`${name}: max ${schema[1]} entries`);
    return arr.map((x, i) => apply(schema[0], x, `${name}[${i + 1}]`))
      .filter((o) => Object.values(o).some((x) => x));
  }
  const o = v && typeof v === 'object' ? v : {};
  const out = {};
  for (const k of Object.keys(schema)) out[k] = apply(schema[k], o[k], `${name ? name + '.' : ''}${k}`);
  return out;
}
const profile = (v) => apply(PROFILE, v, '');

module.exports = { VErr, str, date, dt, int, profile, DATE };

'use strict';
// Shared client helpers. No secrets live on the client: auth is an HttpOnly cookie + per-session CSRF token held in memory.
const DRS = { csrf: null, me: null };
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(method, url, body) {
  const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(DRS.csrf ? { 'X-CSRF-Token': DRS.csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !url.includes('/login')) { location.href = '/'; throw new Error('Sign in required'); }
  if (r.status === 403 && data.must_change && !location.pathname.startsWith('/reset')) { location.href = '/reset.html#change'; throw new Error(data.error); }
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}
async function requireRole(role) {
  try { DRS.me = await api('GET', '/api/me'); } catch { return null; }
  DRS.csrf = DRS.me.csrf;
  if (DRS.me.must_change) { location.href = '/reset.html#change'; return null; }
  if (DRS.me.role !== role) { location.href = DRS.me.role === 'admin' ? '/admin.html' : '/app.html'; return null; }
  return DRS.me;
}
function toast(msg, err) {
  const t = document.createElement('div'); t.className = `toast${err ? ' err' : ''}`; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
async function guard(fn) { try { return await fn(); } catch (e) { toast(e.message, true); } }
function modal(html, onMount) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">${html}</div>`;
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) bg.remove(); });
  document.body.appendChild(bg); if (onMount) onMount(bg.firstChild, () => bg.remove());
  return bg;
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fdate(s) { if (!s) return '—'; const [y, m, d] = s.slice(0, 10).split('-'); return `${MON[+m - 1]} ${+d}, ${y}`; }
function fdt(s) { if (!s) return '—'; return `${fdate(s)} · ${s.slice(11, 16)}`; }
const STATUS_TXT = { green: 'Green', yellow: 'Yellow', red: 'Red' };
const pill = (s, txt) => `<span class="pill ${s}"><span class="dot ${s}"></span>${esc(txt || STATUS_TXT[s] || s)}</span>`;
function fileToPayload(file, label) {
  return new Promise((res, rej) => {
    if (file.size > 5 * 1024 * 1024) return rej(new Error('File too large (max 5 MB)'));
    const fr = new FileReader(); fr.onload = () => res({ label, mime: file.type, data: fr.result }); fr.onerror = () => rej(new Error('Could not read file')); fr.readAsDataURL(file);
  });
}
async function logout() { await api('POST', '/api/logout').catch(() => {}); location.href = '/'; }

// ---- Intake / profile form (shared by contractor + admin) ----
// ---- Airport type-ahead picker: <input data-airport> ; matches IATA code, city or airport name ----
function airportLabel(code) { const a = (window.AIRPORTS || []).find((x) => x[0] === code); return a ? `${a[0]} — ${a[1]}` : (code || ''); }
function attachAirportPickers(root) {
  $$('input[data-airport]', root).forEach((inp) => {
    if (inp.dataset.ready) return; inp.dataset.ready = '1';
    const wrap = document.createElement('div'); wrap.className = 'ap-wrap'; inp.parentNode.insertBefore(wrap, inp); wrap.appendChild(inp);
    const list = document.createElement('div'); list.className = 'ap-list hidden'; wrap.appendChild(list);
    const hidden = document.createElement('input'); hidden.type = 'hidden'; wrap.appendChild(hidden);
    // the visible input shows "MEM — Memphis, TN"; the code lives in data-code and in the field value used by forms
    inp.dataset.code = (inp.value || '').slice(0, 3).toUpperCase(); inp.value = airportLabel(inp.dataset.code);
    const show = () => {
      const q = inp.value.trim().toLowerCase(); if (!q) { list.classList.add('hidden'); return; }
      const hits = window.AIRPORTS.filter((a) => a[0].toLowerCase().startsWith(q) || a[1].toLowerCase().includes(q) || a[2].toLowerCase().includes(q))
        .sort((a, b) => (b[0].toLowerCase() === q) - (a[0].toLowerCase() === q)).slice(0, 8);
      list.innerHTML = hits.map((a) => `<button type="button" data-code="${a[0]}"><b>${a[0]}</b> ${esc(a[1])} <span class="mut">· ${esc(a[2])}</span></button>`).join('') || '<div class="small mut">No match — type a 3-letter code</div>';
      list.classList.remove('hidden');
    };
    inp.addEventListener('input', () => { const v = inp.value.trim(); inp.dataset.code = /^[A-Za-z]{3}$/.test(v) ? v.toUpperCase() : ''; if (!v) inp.dataset.code = ''; show(); });
    inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('blur', () => setTimeout(() => { list.classList.add('hidden'); inp.value = airportLabel(inp.dataset.code); }, 150));
    list.addEventListener('mousedown', (e) => { const b = e.target.closest('[data-code]'); if (!b) return; e.preventDefault(); inp.dataset.code = b.dataset.code; inp.value = airportLabel(b.dataset.code); list.classList.add('hidden'); });
  });
}
const airportVal = (inp) => (inp && inp.dataset.code) || '';

const EYES = ['', 'Brown', 'Blue', 'Green', 'Hazel', 'Gray', 'Amber', 'Other'];
const HAIR = ['', 'Black', 'Brown', 'Blond', 'Red', 'Gray', 'White', 'Bald', 'Other'];
const PROFILE_FORM = [
  { key: 'travel', title: 'Home / preferred airport', icon: '🛫', fields: [['home_airport', 'Primary home airport', 'airport'], ['alt_airport', 'Alternate airport (optional)', 'airport']] },
  { key: 'personal', sec: 'personal', title: 'Personal information', icon: '🪪', fields: [['legal_first', 'Legal first name'], ['legal_middle', 'Middle name'], ['legal_last', 'Legal last name'],
    ['preferred_name', 'Preferred name'], ['dob', 'Date of birth', 'date', true], ['place_of_birth', 'Place of birth'], ['citizenship', 'Citizenship'],
    ['second_citizenship', 'Second citizenship'], ['gender', 'Gender', ['', 'Male', 'Female', 'Other', 'Prefer not to say']]] },
  { key: 'personal', sec: 'contact', title: 'Contact info', icon: '📇', fields: [['email', 'Personal email', 'email'], ['phone', 'Mobile phone', 'tel'], ['alt_phone', 'Alternate phone', 'tel']],
    sub: { key: 'address', title: 'Home mailing address', fields: [['line1', 'Street address'], ['line2', 'Apt / unit'], ['city', 'City'], ['state', 'State'], ['postal', 'ZIP'], ['country', 'Country']] } },
  { key: 'emergency_contacts', title: 'Emergency contacts', icon: '☎️', list: true, max: 2, itemTitle: (i) => (i === 0 ? 'Primary contact (required)' : 'Secondary contact (optional)'),
    fields: [['name', 'Full name'], ['relationship', 'Relationship'], ['phone', 'Mobile phone', 'tel'], ['alt_phone', 'Alternate phone', 'tel'], ['email', 'Email', 'email'], ['address', 'Address']] },
  { key: 'gov_id', title: "Government ID / driver's license", icon: '🚗', fields: [['type', 'ID type', ['', "Driver's License", 'State ID', 'Military ID', 'Other']], ['number', 'ID number', 'text', true], ['state', 'State / issuer'], ['expires', 'Expiration date', 'date'],
    ['front_upload', 'Front of ID', 'upload'], ['back_upload', 'Back of ID', 'upload']] },
  { key: 'passport', title: 'Passport', icon: '🛂', fields: [['number', 'Passport number', 'text', true], ['country', 'Issuing country'], ['issued', 'Issue date', 'date'], ['expires', 'Expiration date', 'date'], ['place_of_issue', 'Issuing authority'], ['photo_upload', 'Photo page', 'upload']] },
  { key: 'visas', title: 'Visas (one per country)', icon: '📄', list: true, max: 12, fields: [['country', 'Country'], ['type', 'Visa type'], ['number', 'Visa number', 'text', true], ['entries', 'Entries', ['', 'Single', 'Double', 'Multiple']], ['issued', 'Issue date', 'date'], ['expires', 'Expiration date', 'date'], ['upload', 'Visa page / letter', 'upload']] },
  { key: 'immunizations', title: 'Immunization records', icon: '💉', list: true, max: 25, fields: [['vaccine', 'Vaccine'], ['dates', 'Dose date(s) (YYYY-MM-DD, comma separated)'], ['expires', 'Valid until (if any)', 'date'], ['notes', 'Notes']] },
  { key: 'physical', title: 'Physical / medical exam', icon: '🩺', note: 'Feeds the Medical Fitness Clearance requirement where your site needs it.', fields: [['last_exam', 'Date of last physical', 'date'], ['expires', 'Expiration date', 'date'], ['provider', 'Clinic / provider'], ['upload', 'Exam form', 'upload']] },
  { key: 'description', title: 'Physical description', icon: '🧍', fields: [['height_ft', 'Height (ft)', ['', '4', '5', '6', '7']], ['height_in', 'Height (in)', ['', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']], ['weight_lbs', 'Weight (lbs)', 'number'], ['eye_color', 'Eye color', EYES], ['hair_color', 'Hair color (optional)', HAIR]] },
  { key: 'medical', title: 'Confidential medical', icon: '🔒', confidential: true, note: 'Confidential medical — visible only to you and the deployment office admin. Encrypted at rest.',
    fields: [['conditions', 'Medical conditions', 'textarea'], ['allergies', 'Allergies', 'textarea'], ['blood_type', 'Blood type (optional)', ['', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Unknown']], ['notes', 'Other medical notes', 'textarea']] },
  { key: 'medications', title: 'Confidential medical — current medications', icon: '💊', confidential: true, list: true, max: 15, fields: [['name', 'Medication'], ['dose', 'Dose (e.g. 10 mg)'], ['frequency', 'How often']] },
  { key: 'clearances', title: 'Clearances', icon: '🛡️', list: true, max: 10, fields: [['type', 'Clearance type'], ['level', 'Level / result'], ['granted', 'Granted', 'date'], ['expires', 'Expires', 'date']] },
  { key: 'employment', title: 'Employment', icon: '🏢', fields: [['employer', 'Company / employer'], ['position', 'Position'], ['employee_no', 'Employee #'], ['supervisor', 'Supervisor'], ['start_date', 'Start date', 'date']] },
];
function fieldHtml(path, [k, label, type = 'text', sensitive], val) {
  const id = `f_${path.replace(/[^a-z0-9]/gi, '_')}_${k}`;
  const name = `${path}.${k}`;
  let input;
  if (Array.isArray(type)) input = `<select id="${id}" data-f="${esc(name)}">${type.map((o) => `<option ${o === val ? 'selected' : ''} value="${esc(o)}">${esc(o || '—')}</option>`).join('')}</select>`;
  else if (type === 'upload') input = `<input type="hidden" data-f="${esc(name)}" value="${esc(val || '')}"><div class="up-slot"><span class="up-cur">${val ? `<a href="/api/uploads/${esc(val)}" target="_blank" rel="noopener">📎 View file</a>` : '<span class="mut small">No file yet</span>'}</span>
    <input id="${id}" type="file" data-up="${esc(name)}" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment"></div>`;
  else if (type === 'airport') input = `<input id="${id}" data-f="${esc(name)}" data-airport value="${esc(val)}" placeholder="Type code or city, e.g. MEM or Memphis" autocomplete="off">`;
  else if (type === 'textarea') input = `<textarea id="${id}" rows="2" data-f="${esc(name)}">${esc(val)}</textarea>`;
  else input = `<input id="${id}" type="${type}" data-f="${esc(name)}" value="${esc(val)}" ${sensitive ? 'autocomplete="off"' : ''}>`;
  return `<div><label for="${id}">${esc(label)}${sensitive ? ' 🔒' : ''}</label>${input}</div>`;
}
function renderProfileForm(el, profile, { open, uploadUrl } = {}) {
  const p = JSON.parse(JSON.stringify(profile || {}));
  const draw = () => {
    el.innerHTML = PROFILE_FORM.map((s) => {
      let body;
      if (s.list) {
        const arr = p[s.key] = p[s.key] && p[s.key].length ? p[s.key] : [{}];
        body = arr.map((item, i) => `<div class="rep">${s.itemTitle ? `<h3 class="mt">${esc(s.itemTitle(i))}</h3>` : ''}<button type="button" class="btn sm x" data-del="${s.key}:${i}">✕</button><div class="grid2">${s.fields.map((f) => fieldHtml(`${s.key}.${i}`, f, item[f[0]])).join('')}</div></div>`).join('')
          + (arr.length < s.max ? `<button type="button" class="btn sm mt" data-add="${s.key}">+ Add ${esc(s.title.toLowerCase().replace(/s$/, '').replace(' record', ''))}</button>` : '');
      } else {
        const o = p[s.key] = p[s.key] || {};
        body = `<div class="grid2">${s.fields.map((f) => fieldHtml(s.key, f, o[f[0]])).join('')}</div>`;
        if (s.sub) { const so = o[s.sub.key] = o[s.sub.key] || {}; body += `<h3 class="mt">${s.sub.title}</h3><div class="grid2">${s.sub.fields.map((f) => fieldHtml(`${s.key}.${s.sub.key}`, f, so[f[0]])).join('')}</div>`; }
      }
      const sid = s.sec || s.key;
      return `<details class="sec ${s.confidential ? 'conf' : ''}" ${open === sid || open === true ? 'open' : ''} data-sec="${sid}"><summary><span>${s.icon}</span>${esc(s.title)}${s.confidential ? ' <span class="pill red">Confidential</span>' : ''}</summary><div class="body">${s.note ? `<p class="small mut">${esc(s.note)}</p>` : ''}${body}</div></details>`;
    }).join('');
  };
  const collect = () => {
    $$('[data-f]', el).forEach((inp) => {
      const parts = inp.dataset.f.split('.'); let o = p;
      for (let i = 0; i < parts.length - 1; i++) { const k = /^\d+$/.test(parts[i]) ? +parts[i] : parts[i]; o[k] = o[k] || {}; o = o[k]; }
      o[parts[parts.length - 1]] = inp.hasAttribute('data-airport') ? airportVal(inp) : inp.value;
    });
    return p;
  };
  el.addEventListener('change', (e) => {
    const f = e.target.closest('input[data-up]'); if (!f || !f.files[0]) return;
    guard(async () => {
      const label = f.closest('div').parentNode.querySelector('label')?.textContent.replace(' 🔒', '') || 'Document';
      const r = await api('POST', uploadUrl, await fileToPayload(f.files[0], label));
      const hidden = $(`input[type=hidden][data-f="${f.dataset.up}"]`, el); hidden.value = r.id;
      f.parentNode.querySelector('.up-cur').innerHTML = `<a href="/api/uploads/${r.id}" target="_blank" rel="noopener">📎 View file</a> <span class="pill green">uploaded</span>`;
      toast('File uploaded (encrypted) — remember to Save');
    });
  });
  el.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]'), del = e.target.closest('[data-del]');
    if (!add && !del) return;
    collect(); const openSecs = $$('details[open]', el).map((d) => d.dataset.sec);
    if (add) p[add.dataset.add].push({});
    if (del) { const [k, i] = del.dataset.del.split(':'); p[k].splice(+i, 1); }
    draw(); attachAirportPickers(el); openSecs.forEach((s) => { const d = $(`details[data-sec="${s}"]`, el); if (d) d.open = true; });
  });
  const draw0 = draw;
  const drawAll = () => { draw0(); attachAirportPickers(el); };
  drawAll();
  return { collect };
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
// CSP forbids inline style attributes; dynamic layout (Gantt positions etc.) is written as data-style and applied via CSSOM.
function applyDS(root) { (root.querySelectorAll ? root.querySelectorAll('[data-style]') : []).forEach((e) => { e.style.cssText = e.dataset.style; e.removeAttribute('data-style'); }); if (root.dataset && root.dataset.style) { root.style.cssText = root.dataset.style; root.removeAttribute('data-style'); } }
new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.nodeType === 1 && applyDS(n)))).observe(document.documentElement, { childList: true, subtree: true });

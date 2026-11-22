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
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}
async function requireRole(role) {
  try { DRS.me = await api('GET', '/api/me'); } catch { return null; }
  DRS.csrf = DRS.me.csrf;
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
const PROFILE_FORM = [
  { key: 'personal', title: 'Personal information', icon: '🪪', fields: [['legal_first', 'Legal first name'], ['legal_middle', 'Middle name'], ['legal_last', 'Legal last name'],
    ['preferred_name', 'Preferred name'], ['dob', 'Date of birth', 'date', true], ['place_of_birth', 'Place of birth'], ['citizenship', 'Citizenship'],
    ['second_citizenship', 'Second citizenship'], ['gender', 'Gender', ['', 'Male', 'Female', 'Other', 'Prefer not to say']], ['phone', 'Phone', 'tel'], ['email', 'Email', 'email']],
    sub: { key: 'address', title: 'Home address', fields: [['line1', 'Street address'], ['line2', 'Apt / unit'], ['city', 'City'], ['state', 'State'], ['postal', 'ZIP / postal'], ['country', 'Country']] } },
  { key: 'emergency_contacts', title: 'Emergency contacts', icon: '☎️', list: true, max: 4, fields: [['name', 'Name'], ['relationship', 'Relationship'], ['phone', 'Phone', 'tel'], ['email', 'Email', 'email']] },
  { key: 'passport', title: 'Passport', icon: '🛂', fields: [['number', 'Passport number', 'text', true], ['country', 'Issuing country'], ['issued', 'Issue date', 'date'], ['expires', 'Expiration date', 'date'], ['place_of_issue', 'Issuing authority']] },
  { key: 'visas', title: 'Visas', icon: '📄', list: true, max: 12, fields: [['country', 'Country'], ['type', 'Visa type'], ['number', 'Visa number', 'text', true], ['issued', 'Issued', 'date'], ['expires', 'Expires', 'date']] },
  { key: 'gov_id', title: "Government ID / driver's license", icon: '🚗', fields: [['type', 'ID type'], ['number', 'ID number', 'text', true], ['state', 'State / issuer'], ['expires', 'Expires', 'date']] },
  { key: 'immunizations', title: 'Immunization records', icon: '💉', list: true, max: 25, fields: [['vaccine', 'Vaccine'], ['dates', 'Dose date(s) (YYYY-MM-DD, comma separated)'], ['expires', 'Valid until (if any)', 'date'], ['notes', 'Notes']] },
  { key: 'medical', title: 'Medical', icon: '🩺', fields: [['blood_type', 'Blood type', ['', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Unknown']], ['allergies', 'Allergies', 'textarea'],
    ['conditions', 'Medical conditions', 'textarea'], ['medications', 'Current medications', 'textarea'], ['notes', 'Other medical notes', 'textarea']] },
  { key: 'clearances', title: 'Clearances', icon: '🛡️', list: true, max: 10, fields: [['type', 'Clearance type'], ['level', 'Level / result'], ['granted', 'Granted', 'date'], ['expires', 'Expires', 'date']] },
  { key: 'employment', title: 'Employment', icon: '🏢', fields: [['employer', 'Company / employer'], ['position', 'Position'], ['employee_no', 'Employee #'], ['supervisor', 'Supervisor'], ['start_date', 'Start date', 'date']] },
];
function fieldHtml(path, [k, label, type = 'text', sensitive], val) {
  const id = `f_${path.replace(/[^a-z0-9]/gi, '_')}_${k}`;
  const name = `${path}.${k}`;
  let input;
  if (Array.isArray(type)) input = `<select id="${id}" data-f="${esc(name)}">${type.map((o) => `<option ${o === val ? 'selected' : ''} value="${esc(o)}">${esc(o || '—')}</option>`).join('')}</select>`;
  else if (type === 'textarea') input = `<textarea id="${id}" rows="2" data-f="${esc(name)}">${esc(val)}</textarea>`;
  else input = `<input id="${id}" type="${type}" data-f="${esc(name)}" value="${esc(val)}" ${sensitive ? 'autocomplete="off"' : ''}>`;
  return `<div><label for="${id}">${esc(label)}${sensitive ? ' 🔒' : ''}</label>${input}</div>`;
}
function renderProfileForm(el, profile, { open } = {}) {
  const p = JSON.parse(JSON.stringify(profile || {}));
  const draw = () => {
    el.innerHTML = PROFILE_FORM.map((s) => {
      let body;
      if (s.list) {
        const arr = p[s.key] = p[s.key] && p[s.key].length ? p[s.key] : [{}];
        body = arr.map((item, i) => `<div class="rep"><button type="button" class="btn sm x" data-del="${s.key}:${i}">✕</button><div class="grid2">${s.fields.map((f) => fieldHtml(`${s.key}.${i}`, f, item[f[0]])).join('')}</div></div>`).join('')
          + (arr.length < s.max ? `<button type="button" class="btn sm mt" data-add="${s.key}">+ Add ${esc(s.title.toLowerCase().replace(/s$/, '').replace(' record', ''))}</button>` : '');
      } else {
        const o = p[s.key] = p[s.key] || {};
        body = `<div class="grid2">${s.fields.map((f) => fieldHtml(s.key, f, o[f[0]])).join('')}</div>`;
        if (s.sub) { const so = o[s.sub.key] = o[s.sub.key] || {}; body += `<h3 class="mt">${s.sub.title}</h3><div class="grid2">${s.sub.fields.map((f) => fieldHtml(`${s.key}.${s.sub.key}`, f, so[f[0]])).join('')}</div>`; }
      }
      return `<details class="sec" ${open === s.key || open === true ? 'open' : ''} data-sec="${s.key}"><summary><span>${s.icon}</span>${esc(s.title)}</summary><div class="body">${body}</div></details>`;
    }).join('');
  };
  const collect = () => {
    $$('[data-f]', el).forEach((inp) => {
      const parts = inp.dataset.f.split('.'); let o = p;
      for (let i = 0; i < parts.length - 1; i++) { const k = /^\d+$/.test(parts[i]) ? +parts[i] : parts[i]; o[k] = o[k] || {}; o = o[k]; }
      o[parts[parts.length - 1]] = inp.value;
    });
    return p;
  };
  el.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]'), del = e.target.closest('[data-del]');
    if (!add && !del) return;
    collect(); const openSecs = $$('details[open]', el).map((d) => d.dataset.sec);
    if (add) p[add.dataset.add].push({});
    if (del) { const [k, i] = del.dataset.del.split(':'); p[k].splice(+i, 1); }
    draw(); openSecs.forEach((s) => { const d = $(`details[data-sec="${s}"]`, el); if (d) d.open = true; });
  });
  draw();
  return { collect };
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

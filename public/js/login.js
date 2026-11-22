'use strict';
(async () => {
  try { const me = await (await fetch('/api/me')).json(); if (me.role) location.href = me.role === 'admin' ? '/admin.html' : '/app.html'; } catch {}
  const info = await (await fetch('/api/demo-info')).json().catch(() => ({}));
  if (info.demo) {
    const d = $('#demo'); d.classList.remove('hidden');
    d.innerHTML = `<div class="card"><h3>🎬 Demo accounts <span class="pill yellow">fictional data</span></h3>
      <p class="small mut">Tap an account to fill the login. Contractor password: <b>${esc(info.contractor_password)}</b></p>
      <button class="demo-acct" data-e="${esc(info.admin.email)}" data-p="${esc(info.admin.password)}"><span>🛠️</span><div class="grow"><b>Admin dashboard</b><div class="small mut">${esc(info.admin.email)}</div></div></button>
      ${info.contractors.map((c) => `<button class="demo-acct" data-e="${esc(c.email)}" data-p="${esc(info.contractor_password)}"><span class="dot ${c.status}"></span><div class="grow"><b>${esc(c.name)}</b><div class="small mut">${esc(c.notes)}</div></div></button>`).join('')}</div>`;
    d.addEventListener('click', (e) => { const b = e.target.closest('.demo-acct'); if (!b) return; $('#email').value = b.dataset.e; $('#pw').value = b.dataset.p; $('#f').requestSubmit(); });
  }
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault(); const err = $('#err'); err.classList.add('hidden');
    try { const r = await api('POST', '/api/login', { email: $('#email').value, password: $('#pw').value }); location.href = r.role === 'admin' ? '/admin.html' : '/app.html'; }
    catch (x) { err.textContent = x.message; err.classList.remove('hidden'); err.style.color = 'var(--red)'; }
  });
})();

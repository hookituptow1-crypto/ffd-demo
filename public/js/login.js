'use strict';
(async () => {
  try { const me = await (await fetch('/api/me')).json(); if (me.role) location.href = me.role === 'admin' ? '/admin.html' : '/app.html'; } catch {}
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault(); const err = $('#err'); err.classList.add('hidden');
    try { const r = await api('POST', '/api/login', { email: $('#email').value, password: $('#pw').value }); location.href = r.role === 'admin' ? '/admin.html' : '/app.html'; }
    catch (x) { err.textContent = x.message; err.classList.remove('hidden'); err.style.color = 'var(--red)'; }
  });
})();

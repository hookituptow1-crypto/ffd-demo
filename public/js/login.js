'use strict';
// Attach the submit handler first (before any network call) so a fast click can never fall through to a native form submit.
$('#f').addEventListener('submit', async (e) => {
  e.preventDefault(); const err = $('#err'); err.classList.add('hidden');
  try { const r = await api('POST', '/api/login', { email: $('#email').value, password: $('#pw').value }); location.href = r.must_change ? '/reset.html#change' : r.role === 'admin' ? '/admin.html' : '/app.html'; }
  catch (x) { err.textContent = x.message; err.classList.remove('hidden'); err.style.color = 'var(--red)'; }
});
// App launch: ask the server whether this is the demo environment (it also makes sure the demo data is in place).
(async () => { try { const c = await (await fetch('/api/config', { cache: 'no-store' })).json(); if (c.demo) $('#demoTag').classList.remove('hidden'); } catch {} })();
(async () => { if (new URLSearchParams(location.search).has('signedout')) return; try { const me = await (await fetch('/api/me')).json(); if (me.must_change) location.href = '/reset.html#change'; else if (me.role) location.href = me.role === 'admin' ? '/admin.html' : '/app.html'; } catch {} })();

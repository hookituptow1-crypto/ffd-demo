'use strict';
// Three modes: #forgot (request a link), #t=<token> (choose a new password from an emailed link), #change (required change after a temporary password)
const V = $('#view');
const RULES = [['12+ characters', (p) => p.length >= 12], ['3 of: lowercase, UPPERCASE, number, symbol', (p) => [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length >= 3],
  ['Not a common word, your email name or "FFD"', (p) => p.length > 0 && !/ffd|password|qwerty|letmein|changeme/i.test(p)]];
const pwFields = (withCurrent) => `${withCurrent ? '<label for="cur">Current (temporary) password</label><input id="cur" type="password" autocomplete="current-password" required>' : ''}
  <label for="np">New password</label><input id="np" type="password" autocomplete="new-password" required minlength="12" maxlength="200">
  <ul class="rules small" id="rules">${RULES.map(([t]) => `<li>${esc(t)}</li>`).join('')}</ul>
  <label for="np2">Confirm new password</label><input id="np2" type="password" autocomplete="new-password" required>
  <button class="btn pri block mt" id="go" disabled>Save new password</button><p id="err" class="small hidden"></p>`;
function wireRules() {
  const upd = () => { const p = $('#np').value; let all = true;
    $$('#rules li').forEach((li, i) => { const ok = RULES[i][1](p); li.className = ok ? 'ok' : ''; all = all && ok; });
    $('#go').disabled = !(all && p === $('#np2').value); };
  $('#np').addEventListener('input', upd); $('#np2').addEventListener('input', upd);
}
const showErr = (m) => { const e = $('#err'); e.textContent = m; e.classList.remove('hidden'); e.style.color = 'var(--red)'; };
const done = (msg) => { V.innerHTML = `<h2>Password updated</h2><p class="small">${esc(msg)}</p><a class="btn pri block mt" href="/">Sign in</a>`; };
async function forgot() {
  V.innerHTML = `<h2>Forgot password?</h2><p class="small mut">Enter your sign-in email. If it has an FFD account we'll email a link that works once, for 30 minutes.</p>
    <form id="f"><label for="em">Email</label><input id="em" type="email" autocomplete="username" required maxlength="120"><button class="btn pri block mt">Email me a reset link</button><p id="err" class="small hidden"></p></form>`;
  $('#f').addEventListener('submit', async (e) => { e.preventDefault();
    try { const r = await api('POST', '/api/password/forgot', { email: $('#em').value });
      V.innerHTML = `<h2>Check your email</h2><p class="small">${esc(r.message)}</p><p class="small mut">Didn't get it? Check spam, or ask your FFD administrator to send a new link.</p>`; }
    catch (x) { showErr(x.message); } });
}
async function withToken(tok) {
  history.replaceState(null, '', '/reset.html'); // keep the token out of history / screenshots
  const c = await api('POST', '/api/password/check', { token: tok }).catch(() => ({ valid: false }));
  if (!c.valid) { V.innerHTML = '<h2>Link expired</h2><p class="small">This reset link is invalid, already used or more than 30 minutes old.</p><a class="btn pri block mt" href="/reset.html#forgot">Request a new link</a>'; return; }
  V.innerHTML = `<h2>Choose a new password</h2><p class="small mut">For ${esc(c.email)}. You'll be signed out on every device.</p>${pwFields(false)}`; wireRules();
  $('#go').addEventListener('click', async () => { try { await api('POST', '/api/password/reset', { token: tok, password: $('#np').value }); done('All devices were signed out. Sign in with your new password.'); } catch (x) { showErr(x.message); } });
}
async function change() {
  let me; try { me = await api('GET', '/api/me'); DRS.csrf = me.csrf; } catch { location.href = '/'; return; }
  V.innerHTML = `<h2>Set a new password</h2><p class="small mut">${me.must_change ? 'Your administrator gave you a temporary password. Choose your own to continue.' : 'Change the password for'} ${esc(me.email)}.</p>${pwFields(true)}`; wireRules();
  $('#go').addEventListener('click', async () => { try { const r = await api('POST', '/api/password/change', { current: $('#cur').value, password: $('#np').value });
    location.href = r.role === 'admin' ? '/admin.html' : '/app.html'; } catch (x) { showErr(x.message); } });
}
function route() { const h = location.hash.slice(1); if (h.startsWith('t=')) withToken(h.slice(2)); else if (h === 'change') change(); else forgot(); }
window.addEventListener('hashchange', route); route();

'use strict';
// Permanent owner admin account (break-glass). It always lets the owner in, independent of other auth state:
//  - the password lives only in the server env (OWNER_ADMIN_PASSWORD, 24+ chars); the DB keeps just a scrypt hash of it,
//    re-synced on every boot, reseed and Reset demo, so resets / nightly reseeds / admin actions can't remove or change it;
//  - it is exempt from login lockouts (brute force is not practical against a long random secret; the per-IP request
//    rate limit still applies) and cannot use forgot-password, password change or admin password overrides;
//  - every login (good or bad) and every state-changing action in an owner session is written to the audit log.
// If the env var is missing or too short the owner login is disabled (fails closed) — there is never a default password.
const db = require('./db');
const C = require('./crypto');

const USERNAME = (process.env.OWNER_USERNAME || 'owner').trim().toLowerCase();
const EMAIL = (process.env.OWNER_EMAIL || 'owner@ffd.internal').trim().toLowerCase();
const secret = () => process.env.OWNER_ADMIN_PASSWORD || '';
const enabled = () => secret().length >= 24;

function ensure() {
  const row = db.prepare("SELECT * FROM users WHERE kind = 'owner'").get();
  if (!enabled()) {
    if (row) { db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(C.hashPassword(C.token()), row.id); db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id); }
    console.warn('Owner admin account disabled: OWNER_ADMIN_PASSWORD is not set (or shorter than 24 characters).');
    return false;
  }
  // free the username / email if some other account holds them (owner always wins)
  db.prepare("UPDATE users SET username = NULL WHERE kind != 'owner' AND username = ?").run(USERNAME);
  if (!row) {
    const clash = db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL);
    if (clash) db.prepare('DELETE FROM users WHERE id = ?').run(clash.id);
    db.prepare("INSERT INTO users (email, username, password_hash, role, kind, must_change, must_setup) VALUES (?,?,?,'admin','owner',0,0)").run(EMAIL, USERNAME, C.hashPassword(secret()));
    db.prepare("INSERT INTO audit_log (user_id, action, details, ip) VALUES (NULL, 'owner_account_created', ?, '')").run(USERNAME);
    return true;
  }
  const fix = row.role !== 'admin' || row.must_change || row.must_setup || row.contractor_id || row.username !== USERNAME || row.email !== EMAIL;
  if (fix) db.prepare("UPDATE users SET role = 'admin', must_change = 0, must_setup = 0, contractor_id = NULL, username = ?, email = ?, temp_expires_at = NULL, temp_used_at = NULL WHERE id = ?").run(USERNAME, EMAIL, row.id);
  if (!C.verifyPassword(secret(), row.password_hash)) {
    db.prepare("UPDATE users SET password_hash = ?, pw_changed_at = datetime('now') WHERE id = ?").run(C.hashPassword(secret()), row.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    db.prepare("INSERT INTO audit_log (user_id, action, details, ip) VALUES (?, 'owner_secret_rotated', 'synced from server env', '')").run(row.id);
  }
  return true;
}
module.exports = { ensure, enabled, USERNAME, EMAIL };

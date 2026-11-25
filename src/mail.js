'use strict';
// Outgoing email. Pluggable: no provider is configured yet.
//  - DEMO_MODE (or MAIL_OUTBOX=1): every message is also written to the admin-only Outbox page (outbox table).
//  - MAIL_PROVIDER=resend  + RESEND_API_KEY + MAIL_FROM        -> sent via Resend's HTTPS API
//  - MAIL_PROVIDER=webhook + MAIL_WEBHOOK_URL (+ MAIL_WEBHOOK_TOKEN) + MAIL_FROM -> JSON POST {from,to,subject,text} to your relay
//  - MAIL_PROVIDER=smtp    + SMTP_URL (smtps://user:pass@host:465) + MAIL_FROM -> needs `npm i nodemailer` (loaded only if present)
// Sending never throws into the request: failures are recorded on the outbox row and logged (without the body).
const db = require('./db');
const C = require('./crypto');
const DEMO_MODE = process.env.DEMO_MODE !== '0';
const FROM = process.env.MAIL_FROM || 'FFD <no-reply@ffd.demo>';
const provider = () => (process.env.MAIL_PROVIDER || '').toLowerCase();
async function deliver(msg) {
  const p = provider();
  if (p === 'resend') {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [msg.to], subject: msg.subject, text: msg.text }) });
    if (!r.ok) throw new Error(`resend ${r.status}`); return 'sent:resend';
  }
  if (p === 'webhook') {
    const r = await fetch(process.env.MAIL_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.MAIL_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.MAIL_WEBHOOK_TOKEN}` } : {}) },
      body: JSON.stringify({ from: FROM, to: msg.to, subject: msg.subject, text: msg.text }) });
    if (!r.ok) throw new Error(`webhook ${r.status}`); return 'sent:webhook';
  }
  if (p === 'smtp') {
    const nm = require('nodemailer'); // optional dependency
    await nm.createTransport(process.env.SMTP_URL).sendMail({ from: FROM, to: msg.to, subject: msg.subject, text: msg.text }); return 'sent:smtp';
  }
  return 'outbox-only';
}
// opts.sensitive: the Outbox copy is stored encrypted (AES-GCM, DATA_KEY) and can later be redacted via opts.ref
async function send(to, subject, text, kind = 'notice', opts = {}) {
  const keep = DEMO_MODE || process.env.MAIL_OUTBOX === '1';
  const body = opts.sensitive ? `enc:${C.encrypt(Buffer.from(text)).toString('base64')}` : text;
  const id = keep ? Number(db.prepare('INSERT INTO outbox (to_email, subject, body, kind, status, ref) VALUES (?,?,?,?,?,?)').run(to, subject, body, kind, provider() ? 'sending' : 'outbox-only', opts.ref || null).lastInsertRowid) : null;
  if (!provider()) return id;
  try { const s = await deliver({ to, subject, text }); if (id) db.prepare('UPDATE outbox SET status = ? WHERE id = ?').run(s, id); }
  catch (e) { console.error(`mail ${kind} to ${to} failed: ${e.message}`); if (id) db.prepare("UPDATE outbox SET status = 'failed' WHERE id = ?").run(id); }
}
const view = (m) => { if (typeof m.body === 'string' && m.body.startsWith('enc:')) { try { return { ...m, body: C.decrypt(Buffer.from(m.body.slice(4), 'base64')).toString() }; } catch { return { ...m, body: '[unreadable]' }; } } return m; };
const redact = (ref, why) => db.prepare("UPDATE outbox SET body = ? WHERE ref = ? AND body LIKE 'enc:%'").run(`[Temporary credentials ${why} — removed from the Outbox]`, ref).changes;
module.exports = { send, provider, view, redact };

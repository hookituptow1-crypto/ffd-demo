'use strict';
// Readiness logic.
// For each contractor we look at two trips:
//   1. CURRENT/UPCOMING rotation: deploy_date .. deploy_date + rotation_on
//   2. NEXT rotation: next_deploy_date (or deploy_date + on + off) .. + rotation_on
// Each requirement for the destination must be valid through the trip's RETURN date
// plus the requirement's min_validity_days (e.g. passport valid 6 months past return).
//   - fails for the current rotation   -> RED   (no-go)
//   - ok now but fails for next one    -> YELLOW (go now, fix before next rotation; countdown = next deploy - lead time)
//   - ok for both                      -> GREEN
// Missing / pending / rejected documents and any active blocker -> RED.
// Admin manual override replaces the computed overall status (reason required, shown to contractor).

const DAY = 86400000;
const toDate = (s) => (s ? new Date(s + 'T00:00:00Z') : null);
const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const diffDays = (a, b) => Math.round((a - b) / DAY);
const RANK = { green: 0, yellow: 1, red: 2 };

function today() {
  // "Today" is the office's calendar day (Leslie is on Pacific time), not the UTC day.
  if (process.env.DEMO_TODAY) return toDate(process.env.DEMO_TODAY);
  return toDate(new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TZ || 'America/Los_Angeles' }).format(new Date()));
}

function rotations(c) {
  const t = today();
  // Crew schedule is the source of truth when it has ON blocks: current/next ON block + the one after drive the yellow window.
  const on = (c._on || []).filter((b) => b.end >= fmt(t));
  if (on.length) {
    const start = toDate(on[0].start); const end = toDate(on[0].end);
    const nextStart = on[1] ? toDate(on[1].start) : addDays(end, c.rotation_off);
    const nextEnd = on[1] ? toDate(on[1].end) : addDays(nextStart, c.rotation_on);
    return { start, end, nextStart, nextEnd, source: 'schedule' };
  }
  const start = toDate(c.deploy_date) || t;
  const end = addDays(start, c.rotation_on);
  const nextStart = toDate(c.next_deploy_date) || addDays(end, c.rotation_off);
  const nextEnd = addDays(nextStart, c.rotation_on);
  return { start, end, nextStart, nextEnd, source: 'pattern' };
}

function evaluate(contractor, requirements, documents, blockers) {
  const t = today();
  const r = rotations(contractor);
  const docsByType = new Map(documents.map((d) => [d.requirement_type_id, d]));
  const items = requirements.map((req) => {
    const doc = docsByType.get(req.id);
    const base = { requirement_type_id: req.id, name: req.name, category: req.category,
      instructions: req.instructions, has_expiry: !!req.has_expiry, min_validity_days: req.min_validity_days,
      document: doc ? { id: doc.id, ref_last4: doc.ref_last4, issued: doc.issued, expires: doc.expires,
        status: doc.status, notes: doc.notes, verified: !!doc.verified, source: doc.source, upload_id: doc.upload_id, check_status: doc.check_status || null,
        provider: doc.provider || '', reference: doc.reference || '' } : null, is_check: !!req.is_check, validity_days: req.validity_days || 0 };
    if (!doc) return { ...base, status: 'red', message: req.is_check ? 'Not started — required for every deployment' : 'Missing — required for this destination' };
    if (req.is_check) {
      const cs = doc.check_status || 'not_started';
      const CHECK_MSG = { not_started: 'Not started', submitted: 'Submitted — waiting on the office to start it', in_progress: 'In progress — not cleared yet', failed: 'Failed — contact the deployment office' };
      if (cs !== 'cleared') return { ...base, status: 'red', message: CHECK_MSG[cs] || 'Not cleared' };
      if (!doc.expires) return { ...base, status: 'red', message: 'Cleared, but no renewal date on file' };
    }
    if (doc.status === 'pending') return { ...base, status: 'red', message: 'Submitted, awaiting approval' };
    if (doc.status === 'rejected') return { ...base, status: 'red', message: 'Rejected — resubmit' };
    if (!req.has_expiry || !doc.expires) return { ...base, status: 'green', message: doc.verified ? 'On file' : 'On file · self-reported, awaiting admin check' };
    const exp = toDate(doc.expires);
    const needNow = addDays(r.end, req.min_validity_days);
    const needNext = addDays(r.nextEnd, req.min_validity_days);
    const extra = req.min_validity_days ? ` (+${req.min_validity_days}d validity rule)` : '';
    if (exp < t) return { ...base, status: 'red', message: `Expired ${doc.expires}` };
    if (exp < needNow) return { ...base, status: 'red',
      message: `Not valid long enough for this rotation${extra}` };
    if (exp < needNext) {
      const fixBy = addDays(r.nextStart, -req.lead_days);
      return { ...base, status: 'yellow', fix_by: fmt(fixBy), days_left: diffDays(fixBy, t),
        message: `Expires before next rotation${extra} — renew by ${fmt(fixBy)}` };
    }
    return { ...base, status: 'green', message: `Valid until ${doc.expires}${doc.verified ? '' : ' · self-reported, awaiting admin check'}` };
  });
  const activeBlockers = blockers.filter((b) => b.active);
  let computed = 'green';
  for (const i of items) if (RANK[i.status] > RANK[computed]) computed = i.status;
  if (activeBlockers.length) computed = 'red';
  const status = contractor.override_status || computed;
  const yellowItems = items.filter((i) => i.status === 'yellow');
  const fixBy = yellowItems.length ? yellowItems.map((i) => i.fix_by).sort()[0] : null;
  return {
    status, computed_status: computed,
    overridden: !!contractor.override_status, override_reason: contractor.override_reason || null,
    rotation: { start: fmt(r.start), end: fmt(r.end), next_start: fmt(r.nextStart), next_end: fmt(r.nextEnd),
      days_to_deploy: diffDays(r.start, t), on: contractor.rotation_on, off: contractor.rotation_off, source: r.source },
    fix_by: fixBy, days_left: fixBy ? diffDays(toDate(fixBy), t) : null,
    items, blockers: activeBlockers.map((b) => ({ id: b.id, description: b.description })),
  };
}

module.exports = { evaluate, today, fmt, addDays, toDate };

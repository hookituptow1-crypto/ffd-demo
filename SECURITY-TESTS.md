# FFD security tests

Target: **https://ffd-demo-tyop.onrender.com** (commit `46c4d10`, demo seed v14). Run on Sun Nov 22, 2026, 4:30–4:55 PM PST from the box.
Re-run with `BASE=<url> node tools/sectest.js`, `tools/xss-check.js`, `tools/pw-test.js`, `tools/e2e-ops.js` and `tools/e2e.js`. They read the demo passwords from `private/creds.env`, which is gitignored and never printed. Each suite resets the demo data when it finishes.

**Summary:** security sweep 63/63 pass (one item was blocked at the edge before reaching the app; see the note). XSS render check 1/1. Password flows 33/33. Ops click-through 67/67. Core click-through 41/41.

## 1. Security sweep (`tools/sectest.js`, live)
| Area | Check | Result | Detail |
|---|---|---|---|
| Headers | Content-Security-Policy (no unsafe-inline/eval scripts) | ✅ PASS | default-src 'self'; img-src 'self' data: blob: https://tile.openstreetmap.org; style-src 'self'; script-src 'self'; object-src 'none'; frame |
| Headers | HSTS 2y + includeSubDomains + preload | ✅ PASS | max-age=63072000; includeSubDomains; preload |
| Headers | X-Frame-Options DENY + frame-ancestors none | ✅ PASS |  |
| Headers | nosniff, Referrer-Policy, Permissions-Policy, COOP, CORP | ✅ PASS |  |
| Headers | No X-Powered-By / server version leak | ✅ PASS | cloudflare |
| Exposure | Login page shows no demo accounts or passwords | ✅ PASS |  |
| Exposure | login.js has no credentials / tap-to-fill | ✅ PASS |  |
| Exposure | /api/demo-info is admin-only | ✅ PASS |  |
| Robustness | /health returns ok | ✅ PASS |  |
| Auth | Same error for unknown user and wrong password (no enumeration) | ✅ PASS | Email or password is incorrect, or too many attempts. Wait 5 minutes and try again. |
| Auth | Similar timing for unknown user vs wrong password | ✅ PASS | 724 ms vs 728 ms (random 300–600 ms delay on every failure) |
| Auth | SQL injection in login email is rejected | ✅ PASS |  |
| Auth | Account+IP lockout after 10 failures in 5 min (correct password refused; admin can unlock) | ✅ PASS |  |
| Auth | Session fixation: new random token issued at login | ✅ PASS |  |
| Auth | Cookie flags: HttpOnly, SameSite=Strict, Secure, __Host- prefix | ✅ PASS | __Host-ffd_sid=…; HttpOnly; Path=/; SameSite=Strict; Max-Age=43200; Secure |
| Auth | Logout invalidates the session server-side (old cookie rejected) | ✅ PASS |  |
| Setup | Admin + contractor logins work | ✅ PASS |  |
| Access control | Contractor blocked from /api/admin/contractors | ✅ PASS |  |
| Access control | Contractor blocked from /api/admin/contractors/1 | ✅ PASS |  |
| Access control | Contractor blocked from /api/admin/tracking | ✅ PASS |  |
| Access control | Contractor blocked from /api/admin/audit | ✅ PASS |  |
| Access control | Contractor blocked from /api/admin/reports/daily | ✅ PASS |  |
| Access control | Contractor blocked from /api/admin/schedule | ✅ PASS |  |
| Access control | Contractor blocked from /api/admin/titles | ✅ PASS |  |
| Access control | Contractor blocked from /api/admin/outbox | ✅ PASS |  |
| Access control | Contractor blocked from /api/admin/crew | ✅ PASS |  |
| Access control | Contractor blocked from /api/admin/contractors/1/account | ✅ PASS |  |
| Setup | Admin upload for another contractor | ✅ PASS | 1 |
| Access control (IDOR) | Contractor can't read another contractor's upload | ✅ PASS |  |
| Access control (IDOR) | Contractor can't read another contractor's headshot | ✅ PASS |  |
| Access control (IDOR) | /api/my/* is scoped to the session (no id parameter to tamper) | ✅ PASS |  |
| Access control (IDOR) | Medical data only via own profile (admin detail needs admin) | ✅ PASS |  |
| CSRF | Write without CSRF token is refused | ✅ PASS |  |
| CSRF | Write with wrong CSRF token is refused | ✅ PASS |  |
| CSRF | Cross-site Origin is refused even with a token | ✅ PASS |  |
| CSRF | Admin reset needs CSRF | ✅ PASS |  |
| Injection | XSS payload accepted as plain text (rendered escaped; CSP blocks inline script) | ✅ PASS | status 200 |
| Injection | SQL metacharacters in search/ids are rejected | ✅ PASS (edge) | Live: Render/Cloudflare WAF answers 403 before the request reaches the app (stricter than expected). Locally the app itself returns 404 (ids must be positive integers). Not an app bug. |
| Injection | Path traversal on uploads | ✅ PASS |  |
| Injection | No file served at /../data/data.key | ✅ PASS | 404 |
| Injection | No file served at /%2e%2e/data/ffd.db | ✅ PASS | 404 |
| Injection | No file served at /data/ffd.db | ✅ PASS | 404 |
| Injection | No file served at /private/creds.env | ✅ PASS | 404 |
| Injection | No file served at /.git/config | ✅ PASS | 404 |
| Injection | No file served at /src/server.js | ✅ PASS | 404 |
| Injection | No file served at /package.json | ✅ PASS | 404 |
| Uploads | Content that does not match its type is refused | ✅ PASS |  |
| Uploads | Disallowed type (HTML/SVG) refused | ✅ PASS |  |
| Uploads | Oversize upload (9 MB) refused | ✅ PASS |  |
| Uploads | Served as attachment, nosniff, sandbox CSP, no-store | ✅ PASS |  |
| Uploads | Headshot must be a real square JPEG | ✅ PASS |  |
| Robustness | Oversize JSON body refused (413) without stack trace | ✅ PASS | {"error":"Request too large"} |
| Robustness | Malformed JSON -> generic 400, no internals | ✅ PASS | {"error":"Invalid request body"} |
| Robustness | Unknown route -> plain 404 page, no stack | ✅ PASS |  |
| Rate limits | SOS spam limited (max 3 / 10 min per user) | ✅ PASS | 200,200,200,429 |
| Rate limits | Login spraying from one IP is throttled | ✅ PASS | blocked at attempt 11 |
| Report token | Token reads the daily report | ✅ PASS |  |
| Report token | Token refused on /api/admin/contractors | ✅ PASS |  |
| Report token | Token refused on /api/admin/reports/daily.csv | ✅ PASS |  |
| Report token | Token refused on /api/my/status | ✅ PASS |  |
| Report token | Token refused on /api/admin/schedule | ✅ PASS |  |
| Report token | Wrong token refused | ✅ PASS |  |
| Cleanup | Demo data reset after sweep | ✅ PASS |  |

## 2. Stored-XSS render check (`tools/xss-check.js`, live)
| Area | Check | Result | Detail |
|---|---|---|---|
| Injection (render) | Alert, intake fields and assistant prompt render as text (no script ran, no dialogs) | ✅ PASS | payload visible as text: true; dialogs: 0 |

## 3. Password flows (`tools/pw-test.js`, live, API level)
Covers forgot/reset (same answer for any email, Origin check, single-use links, a new link invalidates the old one, strength rules, sessions ended, notice sent, audit log), admin temporary password (CSRF, admin-only, shown once, forced change), force reset, lockout and unlock.
- PASS  Admin signs in with restored demo password
- PASS  Forgot: identical response for existing vs unknown email
- PASS  Forgot: response is no-store
- PASS  Forgot: cross-site POST blocked
- PASS  Demo outbox has the reset email with a one-time link (admin-only page)
- PASS  Outbox not readable by anonymous users
- PASS  Outbox not readable by a contractor
- PASS  Outbox stores no unknown-account email
- PASS  New request invalidates the earlier link
- PASS  Reset with garbage token rejected
- PASS  Reset enforces strength (length, mix, no email name)
- PASS  Reset with a valid link + strong password succeeds
- PASS  Reset killed the contractor's existing sessions
- PASS  Reset link is single-use
- PASS  Old password no longer works; new one does
- PASS  "Your password was changed" notice sent
- PASS  Audit log: reset requested + completed
- PASS  Temp password needs CSRF token
- PASS  Contractor cannot use admin password override
- PASS  Admin sets auto-generated temp password (returned once, no-store)
- PASS  Temp password ended the contractor's sessions
- PASS  Temp password signs in but flags must_change
- PASS  Until changed, the app API is blocked (403 must_change)
- PASS  Required change rejects a weak password
- PASS  Required change with strong password works and unlocks the app
- PASS  Admin-typed temp password must be strong
- PASS  Force password reset: link sent, sessions ended
- PASS  Repeated failures lock the account (admin sees LOCKED)
- PASS  Locked: even the right password is refused
- PASS  Admin unlock clears the lockout
- PASS  Audit log: temp password, forced change, force reset, unlock
- PASS  Audit log never contains the temp password
- PASS  After demo reset, restored demo logins work again

Not tested automatically: the 30-minute expiry (the code checks `expires_at` against now; testing it would mean waiting 30 minutes or faking the clock). Rate limits on the forgot form are 5 per 15 minutes per IP and 3 per hour per email; the email limit is silent.

## 4. Feature click-throughs (live, Playwright)
- `tools/e2e-ops.js`: report, schedule (paged, site filter, drag), titles, headshot/badge, crew & coverage + assign swing, forgot password → Outbox → reset page, admin temporary password → forced change → unlock. Screenshots are in `screens/live-*.png`.
- `tools/e2e.js`: core app (board with 80 people, filters, alerts, intake, uploads, check-in/SOS, assistant). Its screenshots are in `screens/01-…56-*.png`, taken on live in this run.

<details><summary>Ops click-through results</summary>

- PASS  Board shows titles
- PASS  Board shows headshot thumbnails (25 per page)
- PASS  Board paginates 80 crew
- PASS  Every demo person has an approved JPEG headshot
- PASS  Board click opens profile with photo at top (David)
- PASS  David is green and fully complete (docs, background check, description, contacts, flights, schedule)
- PASS  Title filter narrows board to A&P Mechanics (20)
- PASS  Report: today group has Brianna outbound + Luis return
- PASS  Report: flag no flight (Wes)
- PASS  Report: flag RED traveling (Sam)
- PASS  Report: flag YELLOW traveling
- PASS  Report: flag changed in last 24h (Marcus QR 450)
- PASS  Report: legs with PNR, seat and connections
- PASS  Report summary counts match the data — 6,4,7,1,5,1,1
- PASS  EC quick view opens
- PASS  CSV export downloads with rows
- PASS  Date picker shows a single day (Dana return)
- PASS  Report JSON requires auth (anon 401)
- PASS  Schedule: 25 rows per page, 80 people
- PASS  Schedule: titles on rows
- PASS  Schedule: training + leave blocks
- PASS  Schedule: site filter (Erbil only)
- PASS  Schedule: coverage gap at Arifjan
- PASS  Schedule: overstaffing at Erbil
- PASS  Schedule: conflict Sam (RED overlaps rotation)
- PASS  Schedule: conflict blocks outlined
- PASS  Drag moves a rotation (+3 days) — ON · Erbil 2026-11-28 → 2027-01-27 -> 2026-12-01
- PASS  Schedule change audit-logged
- PASS  Crew page: total crew vs headcount setting (80 / 80)
- PASS  Crew page: on rotation today vs target 25
- PASS  Crew page: swing pool of 5 listed
- PASS  Swing suggestions: ready (green) + available first
- PASS  Swing suggestions: red swing person cannot be assigned
- PASS  One-click assign swing: Aaron Mitchell → Erbil
- PASS  Swing assignment audit-logged
- PASS  Crew settings save (target on rotation 26)
- PASS  Board: swing filter shows the 5 swing people
- PASS  Login page has "Forgot password?"
- PASS  Admin Outbox shows the reset email
- PASS  Reset page hides the token from the address bar
- PASS  Reset via emailed link works (UI)
- PASS  Admin "Set temporary password" shows it once
- PASS  Temporary password can be hidden
- PASS  Temp password forces a new password at sign-in
- PASS  After the forced change the app opens
- PASS  Admin "Unlock account" works
- PASS  Add title
- PASS  Reorder title
- PASS  Rename title
- PASS  Deactivate title
- PASS  Phone home shows ID badge canvas
- PASS  Intake title dropdown excludes inactive title
- PASS  Camera capture input uses capture=user
- PASS  Headshot pending approval after upload
- PASS  Contractor changed own title
- PASS  Server rejects a non-JPEG headshot — Headshot must be a JPEG image
- PASS  Contractor cannot read another headshot (IDOR)
- PASS  My Schedule shows rotation + linked flights
- PASS  .ics download is a calendar with events + flights
- PASS  Board flags photo to approve
- PASS  Admin approved headshot
- PASS  Detail shows title
- PASS  Badge PNG download
- PASS  Badge PDF download is a PDF
- PASS  Contractor got headshot-approved alert
- PASS  Wes alerted about the schedule move
- PASS  Delete unused title
</details>
<details><summary>Core click-through results</summary>

- PASS  A green: Marcus shows CLEARED TO DEPLOY
- PASS  Marcus has NEW flight badge
- PASS  Flights tab lists QR 714
- PASS  B yellow: Cody shows CLEARED THIS ROTATION with countdown
- PASS  C red: Sam shows NO-GO
- PASS  Admin board shows 80 contractors
- PASS  Board counts 59 green / 13 yellow / 8 red
- PASS  Red filter shows 8 rows
- PASS  Flight sent appears in admin itinerary
- PASS  Admin profile shows full passport number
- PASS  Alert to all RED sent (8)
- PASS  Assistant BLOCKS red John Doe
- PASS  Assistant offers bookable fares for green Tyler
- PASS  Tyler booked
- PASS  Server refuses booking for RED contractor — Booking blocked: John Doe is RED for Camp Lemonnier, Djibout
- PASS  John starts RED
- PASS  John flips to GREEN after upload
- PASS  Admin sees self-reported badge + Verify
- PASS  Assistant now ALLOWS John
- PASS  John has new flights + alert
- PASS  John's booked trip departs from his home airport (MEM) or alternate (LIT)
- PASS  Marcus got auto "Flight changed" alert
- PASS  Contractor blocked from admin API (403)
- PASS  Contractor can't read another's upload (404)
- PASS  CSRF token required (403)
- PASS  Dana YELLOW from background check
- PASS  Trent RED with background check in progress
- PASS  Admin renewal (completion + 365d default) turns Dana GREEN
- PASS  Tyler home airport saved as MEM — Memphis
- PASS  Admin detail shows Tyler home airport
- PASS  Assistant searches from Tyler home MEM + alternate BNA
- PASS  Confidential medical section labelled
- PASS  ID front/back uploads saved to profile
- PASS  Admin detail shows emergency contacts
- PASS  Admin sees contractor edits (eye color Hazel, alt phone)
- PASS  Deployed contractor sees check-in card
- PASS  Check-in recorded
- PASS  Non-deployed contractor has no check-in card
- PASS  Admin SOS banner shows
- PASS  Map shows 4 deployed pins
- PASS  Mike Brennan flagged overdue
</details>

## 5. Ticket approval queue + password change (live, commit b847a86, 2026-11-22)
- Old demo passwords rejected on live (401 for admin and a contractor); new ones accepted (200). New values are only in Render env vars and private files on the box.
- `tools/e2e-tickets.js` on live: 26/26 — banner + badge in full and compact view, report section (API + page), 8 proposals incl. John Doe at exactly 30 days, First class on the company preferred airline, swap, reject, bulk confirm (RED skipped), "Confirmed by admin → Booking" → "Booked", itinerary email in Outbox, contractor notification + My Schedule itinerary with airline seat/check-in link, RED single confirm needs explicit override (audited), confirm without CSRF token refused (403), contractor blocked from admin ticket routes (403).
- `tools/sectest.js` now also checks contractor access to `/api/admin/tickets`, `/tickets/summary`, `/travel/settings` and POST `/tickets/confirm` (all 403). Live: 66 PASS + the known SQL-metacharacter row blocked at Render's edge (403, see section 1).
- Live re-runs after the change: xss 1/1, pw-test 33/33, ops 67/67, main e2e 41/41, phone 34/34.

## Known limits / follow-ups
- Demo passwords were changed on 2026-11-22 (new values live only in Render env vars and private files on the box). The old ones are still in git history but no longer work. Purge history before any real data goes in if that matters.
- In demo mode the admin can read reset links in the Outbox. That is by design for demos; turn it off by connecting a mail provider and setting `DEMO_MODE=0`.
- Rate-limit and lockout counters live in memory on one instance, so a restart clears them. Moving them to Redis/Key Value would make them survive restarts and work across several instances.

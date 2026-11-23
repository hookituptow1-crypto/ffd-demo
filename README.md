# FFD · Fit For Deployment — prototype

Deployment-readiness app for private contractors on overseas rotations (typically 60 on / 30 off).
Two sides in one secure web app:

* **Contractor phone app** (`/app.html`, installable PWA, iPhone + Android): big red/yellow/green light, every requirement with its own status and expiry, a countdown when something must be fixed before the next rotation, "Fix now" to submit a document + photo, flights/itinerary with NEW badges, alerts inbox (+ web push), and a full intake sheet ("My info").
* **Admin dashboard** (`/admin.html`): readiness board with filters, contractor records (requirements, verify self-reported docs, override with reason, blockers), full intake profile (view/edit), flight send/edit/cancel (auto-alerts), bulk alerts, AI booking assistant (demo), destinations & requirement types, audit log, demo scenarios + reset.

All people, numbers and documents in the seed data are **fictional**.

## Run

```bash
npm install
npm start               # http://localhost:4300  (PORT env to change)
npm run seed            # wipe + reseed demo data (or "Reset demo data" in admin)
npx playwright install chromium && npm run e2e   # full click-through test + screenshots in ./screens
```

Demo logins: admin `admin@ffd.demo`, contractors `<firstname>@ffd.demo`. **Passwords are not in this repo** — set `ADMIN_PASSWORD` and `CONTRACTOR_PASSWORD` in the host's environment (otherwise random ones are generated into `data/demo-credentials.json` on the server). The login page never shows demo accounts.

`DEMO_MODE=1` enables the demo scenario page, the admin "Reset demo data" button and an automatic reseed every night at 03:00 Pacific. See `SECURITY-TESTS.md` for the security test results.

## How the light is computed (`src/status.js`)

For each contractor we know the **current/upcoming rotation** (`deploy_date` → +days on) and the **next rotation** (`next_deploy_date`, or end + days off). Each destination has its own list of requirement types; each type has:
* `min_validity_days` — must stay valid this many days past the rotation's *return* date (passport = 180, the 6-month rule),
* `lead_days` — how long renewal usually takes (sets the "fix by" deadline),
* `has_expiry` — e.g. yellow fever / Hep A are lifetime.

Per requirement:
* **RED** — missing, pending/rejected, expired, or not valid long enough for the *current* rotation.
* **YELLOW** — fine for this rotation, but lapses before the *next* rotation ends. Fix-by = next rotation start − lead time; the app shows a days-left countdown.
* **GREEN** — valid through the next rotation.

**Background check** (required for every destination) uses a status workflow: not started / submitted / in progress / cleared / failed, plus completion date, renewal date (defaults to completion + the type's validity, 365 days, editable per requirement type), provider, reference # and an encrypted report upload. Anything but *cleared*, or expired → RED; cleared but lapsing before the next rotation ends → YELLOW with fix-by countdown; otherwise GREEN. Contractors can submit a check for review but only the office can mark it cleared.

**Home airports**: each contractor has a primary + optional alternate home airport (type-ahead picker by IATA code, city or airport name in the intake sheet and admin). The booking assistant searches mock fares from both and labels each fare's origin.

**Intake sheet** sections: home/alternate airport · personal info · contact info (personal email, mobile, alternate phone, full mailing address) · emergency contacts (primary required, secondary optional: name, relationship, mobile, alternate phone, email, address) · government ID (type, number, expiry, front/back upload) · passport (number, country, dates, photo-page upload) · visas per country (type, number, entries, dates, upload) · immunizations · physical exam (date, expiry, provider, form upload → feeds Medical Fitness Clearance) · physical description (height, weight, eye color, hair color) · **Confidential medical** (conditions, allergies, blood type, medications with dose) · clearances · employment. The whole profile is AES-256-GCM encrypted at rest; every upload is encrypted on disk; only the contractor and admins can read them.

**Deployed check-in & location (optional module, admin can switch off):** opt-in consent toggle, active only while the contractor is on rotation; "Check in now" shares browser geolocation; while the app is open it shares every 15 min (a web app cannot track in the background; that needs the native Capacitor app with background-location permission). SOS sends a high-priority admin alert (banner on every admin page) with location; works even without consent. Admin "Deployed map" (Leaflet + OpenStreetMap tiles; CSP allows `tile.openstreetmap.org`) shows a pin per deployed contractor, last check-in, and an OVERDUE flag when there's no check-in within the configurable window (default 12 h). Locations are encrypted, purged after 30 days (configurable), and every map view is audit-logged. For production, use a commercial tile provider or self-hosted tiles (OSM's public tile servers are for light use only).

Overall = worst item. Any active **blocker** (HR hold, medical review…) → RED. An admin **manual override** replaces the computed light; a reason is required and is shown to the contractor. Contractor-submitted documents count immediately but are flagged *self-reported* until an admin clicks **Verify** (decision for Leslie: require verification before they count?).

## Booking assistant (demo)
Admin types e.g. "John Doe needs to go to Africa". The assistant matches the contractor and destination (region words like "Africa" map to sites in that region; their assigned site wins), re-runs the readiness check **against that destination's requirements**, applies a **30-day advance booking window**, and lists fares ranked by price. **Fares are deterministic mock data**, clearly labelled. Approving books the legs into the contractor's Flights tab and sends an alert. RED contractors are blocked in the UI *and* the server refuses the booking. Production: swap the rule parser for an LLM call and the mock fares for a fare API (Duffel, Amadeus, Sabre) or the company's travel agency.

## Planned: booking inbox (not built)
Leslie creates a dedicated mailbox (e.g. bookings@company). Forward or BCC airline/agency confirmations to it; a worker polls it (Gmail API / Microsoft Graph), parses confirmations (schema.org FlightReservation markup when present, otherwise an LLM extractor over the email text), matches the passenger name to a contractor, and creates draft flights the admin approves with one click (and that then alert the contractor). Unmatched emails land in a review queue.

## Crew schedule (`src/schedule.js`, admin › Schedule)
- One row per contractor, Gantt by month (3 months at a time): ON blocks colored by site, OFF, ✈ travel days (first/last day of each ON block), training, leave.
- Pattern defaults to 60 on / 30 off, editable per person (⚙ on the row). Drag a block to move it, click to edit, click an empty day to add. Every change is audit-logged and alerts the contractor.
- **Readiness uses the schedule**: the current/next ON block and the one after it are the "this rotation / next rotation" that drive RED/YELLOW. Contractors without a schedule fall back to the deploy date + pattern.
- Coverage: ON headcount per site per day vs each site's min/max target (Targets button). Gaps red, overstaffing amber.
- Conflicts: RED contractor with a scheduled rotation, or YELLOW contractor scheduled for the rotation their lapsing item blocks.
- Contractor app › Schedule: upcoming blocks, travel dates, linked flights, and an `.ics` calendar download.

## Daily Deployment Report (admin › Report)
- Departing / returning grouped Today, Tomorrow, Next 7 days, or any single day; title filter. Movements come from schedule ON-block start/end plus any booked trip in range.
- Each row: headshot, name, title, stoplight, site, direction, every leg (airline, flight, airports, local times, seat), PNR, connections, home airport, ☎️ emergency-contact quick view, flags (RED/YELLOW traveling, no flight booked for a scheduled change, flight change pushed in the last 24h).
- Print / Save-as-PDF stylesheet, CSV export (`/api/admin/reports/daily.csv`, CSV-injection safe), JSON at `/api/admin/reports/daily?date=YYYY-MM-DD[&days=N]` (admin session **or** the read-only report token).
- **Report token**: `Authorization: Bearer <token>`; the server only knows its SHA-256 (`REPORT_TOKEN_SHA256` env var), it works only on `GET /api/admin/reports/daily`, and the nightly reseed doesn't touch it. `scripts/daily-report.sh [date]` reads the token from `/home/box/.ffd/report-token` (chmod 600, outside the repo). Rotate: write a new token there and update the env var.

## Titles, headshots and ID badge
- Admin › Titles: add, rename, reorder, deactivate (or delete if unused). Titles survive demo resets. Contractors pick theirs on the intake sheet; admin can change it; shown on board (filterable), detail, schedule, report and badge.
- Headshot: camera (`capture=user`) or upload → face oval guide → pan/zoom square crop → 512 px JPEG. Server re-checks JPEG magic bytes, ≤1 MB and square 256–1024 px, stores it AES-256-GCM encrypted, status *pending* until admin approves/rejects (contractor is alerted). Contractors can only fetch their own photo. Demo contractors use generated silhouette/initial placeholders (no real photos).
- ID badge (canvas): headshot (approved only), name, title, FFD patch, stoplight color band, site, ID number, valid-through (end of current/next scheduled rotation capped by the earliest expiring document; RED = NOT VALID). On the contractor home screen and admin detail › ID badge; PNG or PDF download.

## Crew size, coverage and swing / fill-in (admin › Crew & coverage)
- **Settings:** total crew headcount (default 80) and target on rotation (default 25) — kept across demo resets. Per-site targets (the minimum on site) are edited per site; demo defaults Erbil 8 · Arifjan 7 · Lemonnier 6 · Niamey 4 = 25.
- **Coverage:** on rotation today vs target, per site, plus the next gap in the next 90 days (same data as the Schedule coverage rows).
- **Swing / fill-in:** a flag per contractor (Edit contractor → “Swing / fill-in”). **Assign swing** on a short site lists swing people checked against *that site's* requirements for the chosen dates — ready (green) and available first; RED can't be assigned, YELLOW needs a confirm. Assigning carves an ON block out of their OFF time, moves them to that site, alerts them and is audit-logged.
- **Demo data (seed v14):** 80 fictional people (22 women), each with an AI-generated portrait of a fictional person (`seed-assets/headshots/RT-1001…1080.jpg`), full profile, documents, background check, linked flights. 13 named scenario people (incl. David Tran, the green showcase) + 52 rotational crew on **60 on / 120 off** (≈ ⅓ deployed on any day → ~25), 5 swing (3 green, 1 yellow, 1 red), 10 between rotations. Board and Schedule page 25 people at a time and filter by status, site, title, on/off rotation and swing.

## Passwords: forgot / reset, temporary passwords, unlock
- **Forgot password?** on the sign-in page → same answer whether or not the email exists; rate-limited per IP (5 / 15 min) and per email (3 / hour, silent). A random 256-bit single-use token is emailed as `/reset.html#t=…` (fragment, so it never reaches server logs); only its SHA-256 is stored, it expires after 30 minutes and a new request (or any password change) invalidates older links.
- **Reset page** enforces strength (12+ chars, 3 of 4 character classes, no common words / email name / “FFD”). A completed reset ends every session for the account, clears its lockout, writes the audit log and sends a “your password was changed” notice (email + in-app alert).
- **Admin (contractor → App login):** *Set temporary password* (typed or auto-generated, shown once, must be changed at next sign-in — the API refuses everything else until then), *Send reset link*, *Force password reset* (ends sessions + requires a new password), *Unlock account*. All admin-only, CSRF-protected, end the contractor's sessions and are audit-logged (never with the password).
- **Lockout:** 10 failed sign-ins per account+IP or 20 per IP within 5 minutes (50 per account per hour from anywhere). Counters live in memory, so a deploy/restart clears them; admins can also unlock.
- **Email delivery:** no provider yet. With `DEMO_MODE` (or `MAIL_OUTBOX=1`) every message is written to the admin-only **Outbox** page. To send for real set `MAIL_PROVIDER=resend` + `RESEND_API_KEY`, or `MAIL_PROVIDER=webhook` + `MAIL_WEBHOOK_URL` (+ `MAIL_WEBHOOK_TOKEN`), or `MAIL_PROVIDER=smtp` + `SMTP_URL` (needs `npm i nodemailer`), plus `MAIL_FROM` and `APP_URL` (links are never built from the Host header). See `src/mail.js`.
- **Demo logins:** in demo mode the seeded `@ffd.demo` accounts are re-synced to `ADMIN_PASSWORD` / `CONTRACTOR_PASSWORD` (Render env vars) on every boot and every reset, so a demoed password change never breaks the shared demo logins for long.

## Security in this prototype
* Passwords: salted **scrypt** hashes; generic login errors; per-IP rate limit; account lockout after 8 failures.
* Sessions: random 256-bit token in an **HttpOnly, SameSite=Strict** cookie (Secure over HTTPS); only a SHA-256 of the token is stored; 12 h expiry; logout deletes it.
* **CSRF** token required on every state-changing request.
* **Role separation** on every API route: contractors only ever see `/api/my/*` (their own record); uploads are checked against owner; admin routes require the admin role. Verified by the e2e test.
* **Encryption at rest** (AES-256-GCM) for the whole intake profile (DOB, passport/ID numbers, medical) and for every uploaded document photo. Key is server-only (`DATA_KEY` env or `data/data.key`, mode 600). Requirement records keep only the last 4 of document numbers. Sensitive fields are masked in lists.
* Server-side validation of every input (types, lengths, formats, enums; unknown fields dropped). File uploads: type allow-list + magic-byte check, 5 MB cap.
* Strict security headers (CSP with no inline script, frame-ancestors none, nosniff, no-referrer, HSTS on HTTPS). No secrets in client code. Service worker never caches API/personal data.
* **Audit log** of logins, failed logins, every change, booking, alert.

## Production hardening (next steps)
* **2FA** (TOTP / passkeys) for admins at minimum, ideally contractors too; SSO for office staff.
* Managed Postgres with encryption at rest + KMS-held keys (AWS KMS / GCP KMS) and key rotation; object storage (S3) with SSE-KMS for document photos; backups + tested restore.
* Hosting on AWS/GCP/Azure (GovCloud if a customer requires it) behind a WAF, TLS everywhere, secrets in a secrets manager, separate staging/prod.
* Invite flow + password reset by email/SMS, password policy and breached-password check, session/device management, auto-logout on phone.
* Append-only / exported audit log, alerting on suspicious logins, data-retention and deletion policy (PII + medical data: consider HIPAA-style handling and state privacy laws), signed contractor consent.
* **App Store / Play Store**: wrap this PWA with **Capacitor** for native push (APNs/FCM), Face ID / biometric unlock, camera document capture, secure storage; or keep as PWA (iOS web push only works after "Add to Home Screen", iOS 16.4+).
* Real fare search / agency integration, booking-inbox parser, SMS fallback for alerts (Twilio).
* Third-party penetration test before go-live; dependency scanning (npm audit / Dependabot) in CI.

## Deploying a shareable demo
The box this was built on can't open public tunnels (outbound tunnel traffic is blocked), so a public link needs a host:
* **Render / Railway / Fly.io**: `Dockerfile` + `render.yaml` included. Mount a persistent disk at `/app/data`, set `DATA_KEY` (`openssl rand -hex 32`) and keep `DEMO_MODE=1` for the demo. HTTPS is provided by the host (needed for PWA install + push).
* Not a fit for Vercel/serverless as-is (SQLite file + long-running server).

## Layout
```
src/server.js     API, auth, roles, CSRF, headers, uploads, alerts/push, admin routes
src/status.js     red/yellow/green logic
src/assistant.js  booking assistant (rule-based parser + mock fares)
src/validate.js   input validation + intake schema
src/crypto.js     scrypt, AES-256-GCM, tokens
src/seed.js       fictional demo data (dates relative to today)
public/           login, contractor PWA, admin dashboard (vanilla JS, no build step)
tools/e2e.js      Playwright click-through of every scenario (writes ./screens)
```

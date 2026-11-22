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

Demo logins (also shown as tap-to-fill buttons on the login page while `DEMO_MODE` is on):

| Who | Email | Password |
|---|---|---|
| Admin | admin@ffd.demo | FFD!Admin2026 |
| Any contractor | `<firstname>@ffd.demo` (marcus, dana, tyler, cody, brianna, wes, john, sam, trent) | Deploy!2026 |

Set `DEMO_MODE=0` in real use: it hides the demo accounts and disables reset.

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

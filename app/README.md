# Free Food Map PWA

This is the serverless replacement for the Flask/PostgreSQL application. One Cloudflare Worker serves the installable web app and its API, while D1 stores locations and review workflow data.

## Included workflow

- On-demand ZIP or nearby search; the full dataset loads only after an explicit **Show all** action
- Full-text search, service, listed-hours, and conservatively normalized **Open now** filters
- Lazy-loaded, self-hosted Leaflet map with marker clustering
- Installable PWA shell with cached location searches for intermittent connectivity
- PWA shortcuts and operating-system share target for sending source links into a suggestion
- Public location suggestions with duplicate flagging
- Public issue reports for published locations
- Twenty-four-hour community visit updates for open, available, temporarily closed, or long-wait signals
- Admin review queue with edit-before-approve, reject, resolve, location editing, and automated verification evidence
- Hourly geocoding for missing coordinates using the U.S. Census Geocoder
- Scheduled Cloudflare Workflow verification with direct fetch and Browser Rendering fallback
- Verification runs Monday and Thursday at 03:15 UTC (06:15 Riyadh); hourly geocoding remains separate. Only due locations are checked, with a retry cooldown. Manual checks remain available.
- Dated verification evidence, source links, and explicit verified/partial/review states
- Shareable server-rendered location pages, Schema.org JSON-LD, sitemap, robots file, and cached aggregate stats
- HSDS-inspired open-data export at `/api/open-data/hsds`
- Optional Turnstile abuse protection and Cloudflare Access authentication for the review queue
- Repeatable Pennsylvania 211 and listing-website verification audit with CSV reporting
- Existing FFM_data.csv converted into a versioned D1 migration
- Automated tests, database migrations, and deployment through GitHub Actions

## Local development

Install Node.js 24 and pnpm, then run:

~~~powershell
cd app
pnpm install
pnpm db:local
pnpm dev
~~~

Copy .dev.vars.example to .dev.vars and replace both values before starting. Open http://127.0.0.1:8787 and use your configured ADMIN_TOKEN to access review tools. Configure an explicit key: the hostname-based fallback is unreliable under Wrangler's production-domain routing.

The first page intentionally does not fetch location records. Search with a ZIP code, use the location button, or click **Show all**.

ZIP and device-location searches default to a **5-mile radius**, with 1, 5, 10, 25, 50, and 100-mile distance choices. ZIP searches use an approximate ZIP center from Zippopotam.us, so results can include resources across ZIP boundaries; displayed distances are straight-line estimates, not driving distances. Successful ZIP-coordinate lookups are cached for 30 days. If that service is unavailable, exact-ZIP search still works and the interface explains that distance filtering could not be applied. **Show all** searches statewide and preserves the other filters.

Regenerate the CSV seed migration after changing the source data:

~~~powershell
pnpm seed:sql -- --geocode
pnpm db:local
~~~

Audit every active production location without changing the database:

~~~powershell
pnpm verification:audit
~~~

Review the dated files in `reports/`, then publish the same evidence rules to D1:

~~~powershell
pnpm verification:apply
~~~

The audit confirms only fields that agree with a current Pennsylvania 211 record or the listing's own website. Conflicts and records without enough evidence are dated and marked `needs_review`; they are not silently treated as verified.

Discover a balanced batch of additional Pennsylvania locations without publishing it:

~~~powershell
pnpm locations:discover
~~~

This writes a review CSV and a versioned D1 migration. It excludes existing physical locations and directory-only services, requires current phone and hours data, and accepts coordinates only when the U.S. Census geocoder returns the same ZIP code. After reviewing the generated report, publish the migration with:

~~~powershell
pnpm locations:add
~~~

Regenerate conservative weekly schedules after changing location hours:

~~~powershell
pnpm hours:normalize
pnpm db:local
~~~

The generated report in `reports/structured-hours.md` lists every record that was not promoted. Monthly, seasonal, appointment-only, mixed-purpose, and unclear hour strings never drive the **Open now** badge.

## One-time Cloudflare setup

Authenticate Wrangler and create the production database:

~~~powershell
pnpm exec wrangler login
pnpm exec wrangler d1 create free-food-map-db
~~~

Replace the placeholder database_id in wrangler.jsonc with the ID returned by Cloudflare. Then set two long, random secrets:

~~~powershell
pnpm exec wrangler secret put ADMIN_TOKEN
pnpm exec wrangler secret put SUBMISSION_SALT
pnpm exec wrangler d1 migrations apply free-food-map-db --remote
pnpm deploy
~~~

ADMIN_TOKEN protects the review queue. SUBMISSION_SALT prevents stored abuse-control identifiers from containing visitor IP addresses.

`wrangler.jsonc` also provisions the verification Workflow and Browser Rendering binding. Optional production hardening can be enabled without code changes:

~~~powershell
pnpm exec wrangler secret put TURNSTILE_SITE_KEY
pnpm exec wrangler secret put TURNSTILE_SECRET
pnpm exec wrangler secret put CF_ACCESS_TEAM_DOMAIN
pnpm exec wrangler secret put CF_ACCESS_AUD
~~~

When the two Turnstile values are absent, community forms continue to use the honeypot and rate limit. When the two Access values are absent, the existing admin token remains the authentication method.

## Automatic deployments

The GitHub Actions workflow runs tests, applies unapplied D1 migrations, and deploys every change to main. Add this repository secret once:

- CLOUDFLARE_API_TOKEN

The account ID is a non-secret value stored in `wrangler.jsonc`. The API token should be scoped to this Cloudflare account and limited to Workers and D1 edits. `ADMIN_TOKEN` and `SUBMISSION_SALT` remain encrypted Worker secrets in Cloudflare and are not replaced during routine deployments.

## Data model

- locations: approved public records with field-level verification evidence and review dates
- suggestions: pending, approved, and rejected community submissions
- reports: open and resolved data-quality issues
- workflow_events: lightweight audit history for admin decisions
- location_operating_hours and location_events: machine-readable schedules without discarding original display text
- location_evidence and verification_jobs: auditable automated source checks
- location_confirmations: short-lived community visit signals
- location_search: D1 FTS5 index for public search

The legacy Flask source remains at the repository root during the transition. It can be archived after the Cloudflare deployment and production data are verified.

## Audit fixes and review queue

Verification is grouped by reason, with 50 locations per page and one latest check per active location. Completed checks are separated from actionable work; older jobs remain stored for audit history. Saving a location with **Mark information verified today** resolves its latest verification job.

Migrations 0009–0011 correct stale seed schedules conservatively, deactivate three exact duplicate listings without deleting their history, and prevent repeat location submissions. Uncertain monthly, mixed-purpose, and split schedules remain text-only. Location edits regenerate safe schedules and invalidate verification claims for changed fields.

Discovery now excludes all existing locations and suggestion history, checks duplicates again when applying its batch, and refuses to overwrite an unreviewed discovery migration. The server also rejects repeated pending submissions atomically.

Mutable search, stats, detail, and export responses use fresh server data. Offline searches still use the service worker's last successful response; metadata is precached with the app shell.

The legacy Flask reference now requires `APP_SECRET_KEY`, Flask-WTF, and POST requests with CSRF tokens for mutations. Before running it against an existing PostgreSQL installation, review and apply `../legacy-security-migration.sql` to support modern password hashes. Existing SHA-1 passwords are upgraded on successful login. PostgreSQL migration execution is separate from D1 deployment.

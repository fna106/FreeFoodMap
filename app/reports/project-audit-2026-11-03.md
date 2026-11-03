# Free Food Map audit — November 3, 2026

This is an audit of the checked-out source and its seeded local database, not a certification of production data. Application code and existing migrations were left unchanged. Only audit reports and a reproduction script were added.

The app builds and its existing tests pass, but those checks miss important behavior and data errors. The highest priority is the accuracy of Open now and verification claims. IDs below are stable so the user's observations can be merged into this list.

## Checks completed

| Check | Result |
| --- | --- |
| `pnpm check` | TypeScript passed; 15/15 Vitest tests passed |
| Wrangler deployment build | `deploy --dry-run` passed; nothing deployed |
| Production dependency audit | `pnpm audit --prod --json`: zero reported advisories across 3 production dependencies |
| Full dependency audit | 36 advisories: 14 high, 18 moderate, 4 low; 0 critical, in development dependency paths |
| Frontend syntax | `node --check` passed for app.js and sw.js |
| All eight SQL migrations | Applied successfully both to in-memory SQLite and Wrangler's local D1 |
| Database integrity | `integrity_check=ok`; no foreign-key errors |
| Seed inventory | 448 active records; 409 with coordinates; 172 with structured schedules, totaling 499 schedule rows |
| Local API smoke checks | Metadata, stats, ZIP, nearby, scoped full-text search, HSDS export, sitemap, robots, location redirect, and missing-page response checked |
| Browser checks | Home, map, ZIP 19104 (3 results), Show all (448 results), filter reset, desktop layout, 390×844 mobile layout, admin rejection and explicit-key login checked |
| Additional reproduction harness | Exercises actual Worker functions against in-memory SQLite; client search functions and service-worker handlers run with controlled mocks |

Run the additional checks from `app/`:

```powershell
node reports/audit-reproduce-2026-11-03.mjs
```

The reproduction script intentionally asserts the current faulty behavior. It is evidence for this audit, not a regression suite that should remain green after fixes. Its database is disposable and in memory; external verification and browser APIs are mocked.

## High priority

### A01 — Stored schedules contradict current location hours

**Confirmed by SQL and current normalizer comparison.** `migrations/0008_structured_hours.sql` contains schedules incompatible with the corresponding location records. Of 172 scheduled locations, 26 differ from the output of the current normalizer. That count measures inconsistency, not 26 independently verified real-world closures.

Concrete contradictions:

| Location ID | Displayed hours | Stored weekly schedule |
| --- | --- | --- |
| 319 — Feeding the Flock Cupboard | Thursday 10am–1pm and 3pm–6pm | Thursday 9am–3pm |
| 324 — West Deer TECH | First and third Wednesday, 10am–noon | Every Thursday, 10am–1pm |
| 410 — Darlington Food Pantry | Specific dates from November 2025 through January 2026 | Every day, 9am–2pm, without an expiry |
| 143 — Back Mountain Food Pantry | Office/donation hours Tuesday/Thursday/Friday; food distribution Friday | Tuesday/Thursday/Friday all treated as food-access hours |

The Open now filter and availability badges use these rows. A user can be sent to a pantry on the wrong day or during a break. IDs with normalizer mismatches: 314, 319, 324, 378, 383, 388, 389, 391, 393, 398, 399, 400, 403, 408, 409, 410, 411, 418, 420, 421, 423, 428, 433, 438, 446, 448. ID 143 demonstrates that agreement with the parser alone is not proof of correctness.

**Fix direction:** reconcile schedules against their current records and sources, then publish a new migration. Restrict automatic promotion of mixed office/donation/distribution text.

### A02 — Editing hours does not update the schedule used by Open now

**Reproduced.** `src/index.ts:849–901` updates `locations.hours` without modifying `location_operating_hours`. Changing a weekly location to “By appointment only” leaves all old machine-readable hours intact. Newly approved suggestions also get no structured hours, even when their weekly hours are clear.

**Fix direction:** synchronize or invalidate structured schedules transactionally when hours change. Approval should follow the same conservative schedule pipeline.

### A03 — Editing verified fields preserves old verified claims

**Reproduced.** `src/index.ts:868–877` preserves verification status, checked-field list, source, and verification date unless the admin explicitly checks “Mark information verified today.” Changing hours, address, or phone therefore leaves new values presented as verified by evidence for the previous values. The UI offers no explicit way to revoke that verification.

**Fix direction:** invalidate evidence for changed fields and recalculate the status; keep prior evidence as history.

### A04 — A failed source comparison does not change the public verification status

**Reproduced with a source containing no matching fields.** `src/index.ts:1035–1055` records a `needs_review` job, but updates the location only when the identity check succeeds. An already verified location remains verified even after none of its name/address/ZIP/phone/hours can be confirmed. On successful checks, public `verified_fields` and `verification_source_url` are also not refreshed from the new evidence.

**Fix direction:** distinguish source unavailability from conflicting/missing evidence, expose review state appropriately, and synchronize public evidence summaries.

### A05 — Repeated verification failures can starve the rest of the queue

**Source-confirmed consequence of A04.** `src/index.ts:1080–1096` always selects the first five due records, ordered by due date and ID. Completed failures/review results do not advance `verification_due_at` or set a retry time. The same earliest failures can occupy every hourly batch indefinitely. `needs_review` also bypasses the due-date check.

**Fix direction:** persist retry scheduling/backoff separately from verification freshness, and ensure a failed batch does not prevent later locations from being checked.

## Medium priority

### A06 — Workflow creation failure leaves a permanently queued job

**Reproduced with a simulated Workflow outage.** `src/index.ts:1071–1076` inserts a queued job before creating the Workflow. If creation throws, that job remains queued without a Workflow ID. A second request finds the queued row and never retries creation; scheduled selection excludes it too.

**Fix direction:** mark creation failure explicitly and allow retry/reconciliation of orphaned jobs.

### A07 — Nearby and statewide search scopes are lost when filters are submitted

**Nearby behavior reproduced; Show all behavior confirmed in browser.** `public/app.js:400–435, 824–843` accepts search scope only as one-call options. After a nearby search, selecting a service or Open now and pressing Search demands a ZIP instead of reusing the nearby area. After Show all, Search likewise requires a ZIP. Clicking Show all to work around it resets the whole form, including selected filters and text.

**Fix direction:** store the search mode and coordinates independently of the form filters; apply filters to the current mode.

### A08 — A slower previous search can overwrite the latest search

**Reproduced using two requests resolved in reverse order.** `public/app.js:424–428` assigns every response to shared state without cancellation or a request sequence check. The results can show ZIP A while the form and `lastLocationQuery` refer to ZIP B. Clearing search while a request is pending has the same risk.

**Fix direction:** abort superseded requests or ignore responses whose request ID is no longer current.

### A09 — First-visit offline reload can lose metadata and form choices

**Source path and offline cache-miss handler reproduced; complete browser offline transition not exercised.** `public/app.js:1080–1092` loads metadata before registering the service worker. `public/sw.js:2` does not precache `/api/meta`. On an initial visit without an existing controller, that metadata request bypasses the worker. After going offline and reloading, there may be no cached service types or report categories; `loadMeta()` catches the failure and leaves them empty. This can also break the service dropdown in an otherwise cached search experience.

**Fix direction:** explicitly cache required metadata with the shell or retain safe local defaults.

### A10 — Admins cannot clear incorrect coordinates

**Reproduced.** `src/index.ts:170–175, 857–858` treats blank coordinate fields as “reuse existing.” Deleting both values in the edit form silently retains the old map position. Out-of-range or nonnumeric values are silently converted to null instead of returning a field error, and independently valid fields can leave an incomplete coordinate pair.

**Fix direction:** distinguish omitted, explicitly cleared, and invalid coordinates; validate the pair.

### A11 — The seed contains duplicate location records

**Confirmed by grouping normalized name, address, and ZIP.** At least three exact duplicate groups remain:

| IDs | Name | Address |
| --- | --- | --- |
| 116, 293 | Central Pennsylvania Food Bank | 3301 Wahoo Drive, 17701 |
| 107, 210 | Helping Harvest Food Bank | 117 Morgan Drive, 19608 |
| 96, 150 | Westmoreland Food Bank | 100 Devonshire Drive, 15626 |

Additional shared-address/name variants appear in the browser but require review before merging, because separate programs can legitimately share a building. The displayed 448 is a record count, not a verified count of distinct physical resources.

**Fix direction:** review these groups, preserve useful program differences, and reconcile references before merging.

### A12 — The documented hours regeneration workflow rewrites an already-applied migration

**Source-confirmed.** `scripts/normalize-hours.mjs` always writes `migrations/0008_structured_hours.sql`. The README then instructs running `pnpm db:local`. D1 tracks applied migration names, so rewriting 0008 does not update a database that already applied it. Fresh and existing environments can diverge.

**Fix direction:** generate a new numbered migration or use an explicit, reviewed schedule-update command.

### A13 — Turnstile widgets are not reset for later submissions

**Source-confirmed conditional integration gap; live Turnstile was not configured or tested.** `public/app.js:513–520, 894–946` renders the widgets once but never calls the widget reset API. Forms are reset after success or when reopened. A consumed, cleared, or expired token can make later submissions fail until a reload or widget refresh occurs, including retry after a server-side validation failure that already consumed the token.

**Fix direction:** track widget IDs and reset/reacquire tokens after submissions and when reopening forms.

### A14 — Documented local admin fallback fails in the actual dev server

**Observed in browser and direct local HTTP requests.** With no `.dev.vars` present, both `127.0.0.1` and `localhost` rejected `local-admin` with 401. Restarting with an explicit temporary `--var ADMIN_TOKEN:audit-only` made admin login and the review dashboard work. The fallback depends on the request URL hostname (`src/index.ts:692–701`); the precise reason it is not recognized under the current Wrangler configuration was not instrumented.

**Fix direction:** test the documented no-vars setup under Wrangler, or document an explicit local development key configuration.

### A15 — Location detail pages omit the appointment requirement

**Source-confirmed.** `src/index.ts:427–477` renders eligibility, hours, accessibility, and contact details but never renders `appointment_required`. The interactive result card does display it (`public/app.js:335`). A shared/crawlable detail page can therefore omit a condition needed before visiting when that requirement exists only in its dedicated field.

**Fix direction:** include appointment requirements in the public detail page.

### A19 — The locked development dependency tree has 36 reported advisories

**Confirmed by `pnpm audit --json`.** The full scan reports 14 high, 18 moderate, and 4 low advisories, with none critical. The production-only scan covers only 3 declared dependencies and reports none. The full tree includes Wrangler/Miniflare/Vitest tooling and Puppeteer's transitive packages, including reported issues in `undici`, `sharp`, `extract-zip`, `@vitest/mocker`, `ip-address`, and `zod`.

`@cloudflare/puppeteer` is declared in devDependencies but imported by the Worker, so package classification alone does not prove that all flagged code is absent from the deployed bundle. The audit did not establish an exploit or reachability of the affected functions. Review the dependency paths and upgrade compatible direct packages, then repeat behavioral checks. Do not blindly force dependency overrides.

The raw results are saved in `dependency-audit-2026-11-03.json` alongside this report.

## Lower priority

### A16 — Invalid JSON produces an internal-server-error response

**Reproduced.** A body containing `{` sent to `/api/reports` returns 500. `readBody()` errors fall through to the catch-all at `src/index.ts:1184–1188`, exposing parser/internal messages as well. Invalid bodies and oversized requests should return 400/413 with controlled errors.

### A17 — ZIP input is truncated before validation

**Reproduced.** `/api/locations?zip=19104garbage` returns 200 and searches 19104. `clean(..., 5)` runs before ZIP validation (`src/index.ts:277`); suggestions use the same pattern at line 191. Overlong values can silently become a different accepted value. Browser maxlength limits do not protect direct API requests.

### A18 — A 24/7 location is marked closed during the final minute of each day

**Source-confirmed.** The normalizer encodes 24/7 as 00:00–23:59, while the Open now query uses an exclusive closing boundary. At 23:59 Eastern, a 24/7 resource is classified closed. Store a full-day representation and test midnight boundaries.

## User observations merged after the initial audit

### A20 — Clicking a map marker does not reliably expose its full details

**User-reported; mobile visibility gap confirmed in source.** The marker handler calls `selectResult(location.id, false)` (`public/app.js:265–267`). That expands the corresponding result card, but on mobile the search/results pane remains hidden while the map view is selected. The marker popup contains only name, service, and address, so full details remain out of view. On desktop, card expansion is intended; the reported failure there still requires reproduction. The search input itself is not populated by marker clicks.

**Expected behavior:** selecting a marker should visibly show the selected location's full information. On mobile, open a detail panel or switch to the selected result; retain the search filters unless the user explicitly changes them. On desktop, expand and reveal the corresponding card without losing the map selection.

### A21 — ZIP 16803 returns no results despite nearby resources

**Confirmed in the seeded database, query implementation, and live public API; user supplied ZIP 16803.** The live request to `/api/locations?zip=16803` returned HTTP 200 with `locations: []` and `meta.count: 0`. There are no seeded records with ZIP 16803. The backend adds `l.zip_code = ?`, so nearby records in 16801 and 16802 are excluded. Examples include State College Food Bank (ID 46, ZIP 16801), Housing Transitions (ID 47, ZIP 16801), and Lion's Pantry at University Park (ID 83, ZIP 16802). This is a search coverage/behavior gap, not evidence that every ZIP query is broken; ZIP 19104 returned three results during the original audit.

**Expected behavior:** use the entered ZIP as a geographic search origin and return nearby resources, or clearly explain the exact-ZIP limitation and offer nearby results. Distances must be computed from a resolved ZIP location; do not silently substitute an unrelated ZIP. The user's exact device and filter state remain unknown.

### A22 — Discovery does not exclude locations already awaiting review

**User-reported repeated queue entries; omission confirmed in the repository discovery script.** `scripts/discover-pa211-locations.mjs` loads only active `locations`; it never queries `suggestions`. It deduplicates against that published set and the current candidate batch, but has no durable cross-run exclusion for pending review entries. Its generated migration also checks only `locations`. Furthermore, the public suggestion endpoint flags published duplicates rather than rejecting them and does not compare pending suggestions.

The repository discovery script generates review files and a location migration; it does not itself submit suggestions into the admin queue. The identity/instructions of the separate agent that actually creates the reported queue entries have not been identified, so that agent's exact duplicate path is not yet proven.

**User requirement:** discover only genuinely new physical locations, absent from both the map and the pending queue. An existing location with updated details belongs in an update/report workflow, not another new-location review entry.

**Acceptance criteria:**

- Load published and pending records before discovery; account for previously reviewed/rejected entries so the same rejected candidate is not automatically reintroduced without new evidence.
- Match stable source IDs/URLs and normalized physical addresses, with sensible street abbreviation and phone normalization; do not rely only on display names.
- Deduplicate within a batch and across runs; reserve/check identity atomically when enqueueing so concurrent agents cannot create the same pending candidate.
- Recheck immediately before insertion, skip known candidates, and count skipped duplicates in the run report.
- Preserve distinct branches at distinct addresses; treat uncertain same-address programs conservatively for the user's goal of avoiding repeated physical-location review.
- A second run against unchanged source data should add zero already-known candidates and leave existing review entries intact.

A20–A22 extend the original audit to 22 numbered findings. No application fixes have been applied yet; this pass merges and diagnoses the user's observations.

**Implementation follow-up:** A21 is now addressed in the working tree: ZIP searches resolve an approximate ZIP center and return resources within the selected radius (5 miles by default), across ZIP boundaries. Distance choices are 1, 5, 10, 25, 50, and 100 miles and also apply to device-location searches. The UI explains approximate straight-line distances and falls back to explicitly labeled exact-ZIP results if coordinate lookup fails. A07's lost nearby/statewide scope is also addressed as part of making the new distance filter usable. Browser verification found four listings within 5 miles of 16803. These changes have not been deployed; the original findings above describe the pre-fix behavior.

## Other evaluation notes

- **39 seeded active records have no coordinates.** They remain searchable by ZIP but disappear from nearby search and map markers. This is a coverage limitation rather than proof the geocoder is broken. Review the unresolved addresses and make the missing coverage clear to users.
- The stored `schedule_timezone` field is editable, but the Open now calculation always uses `America/New_York`. Current PA coverage makes this less urgent; it becomes a correctness problem when expanding to other time zones.
- Cached search responses can remain unchanged for five minutes; location pages for an hour; HSDS exports for a day. There is no mutation-triggered invalidation. Admin edits and community visit updates may therefore not appear immediately after the UI reloads data.
- The main name/address/organization searchbox has no visible text label and appeared as an unnamed searchbox in the DOM snapshot. Give it an explicit accessible name.
- Admin lists have fixed caps (500 locations, 250 suggestions/reports/jobs) without pagination. This is not truncating the current 448-location seed, but it will hide records as the project grows.
- The README still lists volunteer accounts, organization management, and event workflows from Flask, but those flows are not implemented in the active PWA. Confirm whether their removal was intentional before treating them as migration regressions.

## Legacy Flask review

The root README identifies Flask as a retained migration reference. These findings matter if it is still reachable anywhere; they are not claims about the active Worker:

- `main.py:9` falls back to a known `dev-secret` for signed sessions. If deployed without `APP_SECRET_KEY`, session claims can be forged.
- `main.py:79–90` uses a single salted SHA-1 pass for passwords, rather than a password-specific slow hash.
- Multiple state-changing admin actions use GET, including user approval/deletion and location/event deletion; forms lack a CSRF protection layer. An authenticated legacy administrator can be induced to invoke an unintended action.
- The direct-run entry point enables Flask debug mode.

Legacy PostgreSQL routes were reviewed statically only. A working Python interpreter and a configured PostgreSQL test instance were not available; the system `python` alias failed to launch. No legacy runtime-pass claim is made.

## Why the existing tests did not catch this

The 15 tests mostly check validators, unauthorized access, static response text, manifests, and redirects. Several frontend tests only assert that a string exists in app.js. They do not exercise successful DB-backed search, approval, editing, report resolution, schedule changes, verification outcomes, concurrent search requests, or offline reload.

Add meaningful behavioral coverage around A01–A08 first, including migration-to-record schedule consistency and failed Workflow creation. Keep the audit harness's limitations in mind: it does not reproduce Cloudflare edge caching, Workflow retries, Turnstile, or browser rendering faithfully.

## Boundaries and comparison worksheet

The original audit did not query the production database. The follow-up made only a read-only request to the public ZIP-search API for 16803; no direct production database access or mutation was performed. No location was contacted, verified against a live source website, or published. No deployment was performed. External verification results in the reproduction script are controlled fixtures. No claim is made that this finite audit found every bug.

For the next comparison, attach each user observation to an A-number above, or add a new entry with: screen/URL, steps, expected behavior, actual behavior, device, and frequency. Fix schedule accuracy and verification trust first, then queue reliability and search behavior.


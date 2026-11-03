# Audit remediation status

Implemented in the working tree; no production deployment or remote data mutation has occurred.

| Findings | Resolution |
| --- | --- |
| A01, A11 | New corrective D1 migrations rebuild conservative schedules and deactivate three exact duplicate listings while retaining history. Schedule inserts check that current text still matches the seed; changed production text is not promoted automatically. |
| A02, A03 | Approval generates safe schedules; edits rebuild them and invalidate changed verification claims. Explicitly verifying a record resolves its latest job. |
| A04–A06 | Source mismatches enter review; confirmed fields and sources are updated; failed Workflow creation is retryable; due-job selection has a cooldown and no five-record starvation bottleneck. |
| A07, A08, A21 | Distance search, persistent search scope, and stale-response protection implemented. |
| A09 | App shell precaches metadata for offline form choices. |
| A10 | Coordinates can be cleared; invalid values and incomplete pairs are rejected. |
| A12 | Hours normalization creates a new numbered migration and refuses to overwrite an existing file. |
| A13 | Explicit Turnstile widget IDs and token callbacks; widgets reset after attempts. Live challenge configuration is not available for end-to-end verification. |
| A14 | Removed the unreliable default admin key; documented explicit local configuration. |
| A15–A18 | Detail pages show appointment requirements; JSON parsing is bounded and returns 400/413; ZIP validation rejects overlong values; 24/7 schedules cover the final minute. |
| A19 | Dependency updates reduce advisories from 36 to 2. The remaining two high advisories are in extract-zip 2.0.1 via Puppeteer's browser installer, with no published patched version in the registry audit. No exploit/reachability claim is made. They remain unresolved upstream. |
| A20 | Marker selection opens the corresponding details and reveals the results pane on mobile. |
| A22 | Discovery checks locations and suggestion history; database guards prevent repeated submissions, including common street suffix variants. Discovery never overwrites an unreviewed batch. |

## Verification queue and schedule

The default queue includes only the latest actionable job for each active location. Tabs separate name/address, hours, contact, other changes, failed source checks, in-progress checks, and completed checks. Counts cover all matching locations, with 50 rows per page. Prior jobs remain in the database rather than being deleted.

Automated verification runs **twice weekly: Monday and Thursday, 03:15 UTC / 06:15 Asia/Riyadh**. Hourly geocoding is unchanged. The repository contains no deployed recurring discovery automation: its scheduled Worker performs verification and geocoding; PA 211 discovery is a separate CLI script. No unrelated external agent or cloud automation was modified.

## Legacy source

Flask requires an explicit signing secret, CSRF protection and POST mutations. New passwords use Werkzeug's slow password hashing; old hashes upgrade after successful authentication. Debug mode is off. The separate PostgreSQL migration must be applied before using these legacy changes against existing data; it has not been executed here.

## Boundaries

Validation: 30 Cloudflare/Vitest tests plus four client tests pass; four legacy Flask security tests pass using an isolated dependency folder, without PostgreSQL. All corrective D1 migrations apply locally and the deployment dry run succeeds. The verification tabs were inspected in the browser. New source schedules are deliberately conservative rather than inventing missing intervals.

The 39 unmapped records and uncertain same-address programs still need source/data review; coordinates or merge decisions were not invented. The remaining extract-zip advisories cannot be resolved through a published patched version today. The historical audit reproducer describes the old faulty behavior and is superseded for regression verification by the tests in `app/test/`.

Real production queue counts, external source verification and live Turnstile challenges were not exercised. All migration and UI checks used local data. Review corrective migrations before deployment, especially if production hours have been edited since the seed.

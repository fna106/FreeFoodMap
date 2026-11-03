# Final user-flow and missing-marker check

## Changes deployed

Final Worker version: `f306b5f7-58e3-486f-9c59-93d5b6b4784c`; app/service-worker cache version 14. Live mobile verification confirmed KleinLife's formerly missing marker and automatic expansion of its three shared-address markers with the selected popup visible. Browser console reported no errors during that flow.

- Replaced circle paths with accessible standard Leaflet markers compatible with clustering. Marker titles expose location names to keyboard and assistive-technology users.
- Mobile **View map** now waits for lazy map initialization. Selecting a shared-address location reveals overlapping markers and opens the chosen popup; clicking a marker reveals its full result card.
- Failed map-script downloads can be retried instead of poisoning the map-loading promise for the rest of the session.
- Fixed geocoding ZIP extraction: five-digit street numbers are not mistaken for ZIP codes.
- Added an eight-second Census request timeout and tracked attempts. Failed addresses rotate with a daily cooldown rather than blocking later IDs forever. Partial coordinate pairs are also retried.
- Missing-coordinate listings remain in exact-ZIP search results with unknown distance; no zero-distance or invented marker is assigned.
- Added a **Map positions** verification sub-tab, including locations with no verification job.
- Applied 23 guarded, evidence-backed production coordinate repairs and retained source evidence. Addresses and ZIPs were rechecked before updates; directory points far from their stated ZIP were rejected.

## Validation

- 33 Cloudflare/Vitest tests and four client tests pass.
- Four legacy Flask security checks pass without connecting to PostgreSQL.
- Schema migration 0013 applied to production; no migrations remain pending.
- Local mobile browser: first-use lazy loading, View map, selected popup, and marker-to-details transitions checked, including overlapping State College Food Bank listings.
- Live public APIs: homepage and service worker current; 16803 returns four mapped listings within five miles; KleinLife now returns a real point; Basic Needs Hub remains searchable with unknown distance rather than disappearing.
- Production coverage improved from 413/445 mapped listings to **436/445**. Nine uncertain addresses remain visible in the Map positions review tab.

## Outstanding address review

IDs 33, 35, 38, 39, 42, 51, 79, 82, and 94 lack a sufficiently supported exact position. These include rural addresses, a campus room address, and directory records whose coordinates appear geographically inconsistent. They were not silently assigned ZIP centroids or unrelated map points. Public listing evidence and accepted/rejected repair records are in `missing-coordinate-repair-2026-11-03.json`.

The pre-existing two upstream extract-zip advisories remain; no published patched release was available. Live Turnstile challenges were not exercised because production configuration was not supplied for a dedicated challenge test. No test suggestions or reports were inserted into production.

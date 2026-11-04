# Search outage and recovery

Production logs showed D1 rejecting scoped location queries because the account's free-tier daily row-read allowance was exhausted. Earlier unindexed history diagnostics performed millions of reads; previous validation contributed to the quota pressure. Repeated probes were stopped after the error was identified. No billing or plan change was made.

Recovery deployed in Worker version `24b92b13-7956-4442-b571-11ad5735a94b`:

- Restored edge caching, with a 60-second search TTL, to reduce repeated reads.
- Packaged 445 already-public listings in a static outage snapshot; no private tables were exported.
- Live D1 failures fall back to server-filtered snapshot results, preserving ZIP/geolocation scope, distance, service, text and conservative opening-hour filters. Saved-data responses identify their source and snapshot timestamp.
- Recomputed opening state from conservative schedules rather than freezing snapshot badges; expired community signals are dropped.
- Location detail pages can also use the snapshot. Database write failures return a temporary-unavailability response rather than claiming changes were saved.
- Updated app/service-worker cache version to 15.

Validation: 36 Worker tests and four client tests passed, including forced D1 quota failure, ZIP filtering, unmapped listings, and request validation. Live requests returned HTTP 200 for ZIP 19104 at five miles (17 results), ZIP 16803 (four results), device-location search (four results), ZIP 19104 at one mile (three results), and KleinLife's detail page. Browser verification showed 17 results replacing the error state in the reported ZIP search.

The snapshot is an outage fallback, not a substitute for live database writes. Live edits/submissions can remain limited until the account's read allowance resets. The existing latest-job lookup index and restored caching reduce ongoing quota pressure.

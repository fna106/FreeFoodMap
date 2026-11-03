# Production deployment — November 3, 2026

- Worker version: `3289f8f5-ee48-49b2-9f88-052e79f7681f`
- Published to `https://freefoodmap.org` and the existing Workers domain.
- D1 migrations 0009–0012 applied successfully.
- Verification cron: Monday/Thursday 03:15 UTC (06:15 Asia/Riyadh).
- Hourly geocoding remains on its own cron; it does not dispatch verification.

Live checks: homepage and service-worker version 12 served successfully; ZIP 16803 returned four results within five miles (1.3, 2.2, 4.6, 4.6 miles), and zero within one mile. Public stats reported 445 active records. Latest actionable verification jobs represented eight distinct active locations, compared with thousands of historical jobs. History was retained.

The latest-job lookup index reduced the measured queue query from 7,566,653 rows read / 527 ms to 13,386 rows / 9.5 ms.

An optional complete local database export was rejected by automatic approval review because it could copy sensitive production data locally. No export file was created; the authorized migrations and deployment proceeded without that optional export.

The retained legacy Flask/PostgreSQL source and its security migration were not deployed; the active production service is the Cloudflare Worker/D1 app. Repository changes remain uncommitted locally.

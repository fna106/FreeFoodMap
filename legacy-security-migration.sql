-- Apply only to an existing legacy PostgreSQL installation before using the updated Flask source.
ALTER TABLE freefoodmap.appuser ALTER COLUMN password_hash TYPE TEXT;
ALTER TABLE freefoodmap.appuser ALTER COLUMN salt TYPE TEXT;
ALTER TABLE freefoodmap.ContributorRequest ALTER COLUMN password_hash TYPE TEXT;
ALTER TABLE freefoodmap.ContributorRequest ALTER COLUMN salt TYPE TEXT;

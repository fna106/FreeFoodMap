-- Latest-job queue lookups must not scan every historical check for each row.
CREATE INDEX IF NOT EXISTS idx_verification_jobs_location_id_desc ON verification_jobs(location_id, id DESC);

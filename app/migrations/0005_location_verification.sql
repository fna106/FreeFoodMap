ALTER TABLE locations ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified'
  CHECK (verification_status IN ('unverified', 'partial', 'verified', 'needs_review'));
ALTER TABLE locations ADD COLUMN verified_fields TEXT;
ALTER TABLE locations ADD COLUMN verification_source_url TEXT;
ALTER TABLE locations ADD COLUMN verification_notes TEXT;
ALTER TABLE locations ADD COLUMN last_reviewed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_locations_verification_status
  ON locations(status, verification_status);

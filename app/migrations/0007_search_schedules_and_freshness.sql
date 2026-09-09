ALTER TABLE locations ADD COLUMN eligibility TEXT;
ALTER TABLE locations ADD COLUMN accessibility TEXT;
ALTER TABLE locations ADD COLUMN languages TEXT;
ALTER TABLE locations ADD COLUMN appointment_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE locations ADD COLUMN schedule_timezone TEXT NOT NULL DEFAULT 'America/New_York';
ALTER TABLE locations ADD COLUMN verification_due_at TEXT;

ALTER TABLE suggestions ADD COLUMN eligibility TEXT;
ALTER TABLE suggestions ADD COLUMN accessibility TEXT;
ALTER TABLE suggestions ADD COLUMN languages TEXT;
ALTER TABLE suggestions ADD COLUMN appointment_required INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS location_operating_hours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  opens_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  valid_from TEXT,
  valid_through TEXT,
  source_url TEXT,
  last_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(location_id, day_of_week, opens_at, closes_at, valid_from)
);

CREATE TABLE IF NOT EXISTS location_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Food distribution',
  starts_at TEXT,
  ends_at TEXT,
  recurrence_rule TEXT,
  description TEXT,
  source_url TEXT,
  last_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS location_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  observed_value TEXT,
  source_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'conflict', 'missing', 'proposed')),
  note TEXT,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO location_evidence (location_id, field_name, observed_value, source_url, status, note, checked_at)
SELECT id, 'record', verified_fields, verification_source_url,
  CASE WHEN verification_status IN ('verified', 'partial') THEN 'confirmed' ELSE 'conflict' END,
  verification_notes,
  COALESCE(last_reviewed_at, last_verified_at, updated_at)
FROM locations
WHERE verification_status != 'unverified';

CREATE TABLE IF NOT EXISTS location_confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  signal TEXT NOT NULL CHECK (signal IN ('open', 'hours_correct', 'food_available', 'temporary_closed', 'long_wait')),
  note TEXT,
  client_hash TEXT NOT NULL,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS verification_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'proposed', 'confirmed', 'needs_review', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT,
  error_message TEXT,
  workflow_instance_id TEXT,
  scheduled_for TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE VIRTUAL TABLE IF NOT EXISTS location_search USING fts5(
  name,
  organization_name,
  address,
  service_type,
  notes,
  content='locations',
  content_rowid='id'
);

INSERT INTO location_search(rowid, name, organization_name, address, service_type, notes)
SELECT id, name, COALESCE(organization_name, ''), address, service_type, COALESCE(notes, '')
FROM locations;

CREATE TRIGGER IF NOT EXISTS location_search_insert AFTER INSERT ON locations BEGIN
  INSERT INTO location_search(rowid, name, organization_name, address, service_type, notes)
  VALUES (new.id, new.name, COALESCE(new.organization_name, ''), new.address, new.service_type, COALESCE(new.notes, ''));
END;

CREATE TRIGGER IF NOT EXISTS location_search_delete AFTER DELETE ON locations BEGIN
  INSERT INTO location_search(location_search, rowid, name, organization_name, address, service_type, notes)
  VALUES ('delete', old.id, old.name, COALESCE(old.organization_name, ''), old.address, old.service_type, COALESCE(old.notes, ''));
END;

CREATE TRIGGER IF NOT EXISTS location_search_update AFTER UPDATE OF name, organization_name, address, service_type, notes ON locations BEGIN
  INSERT INTO location_search(location_search, rowid, name, organization_name, address, service_type, notes)
  VALUES ('delete', old.id, old.name, COALESCE(old.organization_name, ''), old.address, old.service_type, COALESCE(old.notes, ''));
  INSERT INTO location_search(rowid, name, organization_name, address, service_type, notes)
  VALUES (new.id, new.name, COALESCE(new.organization_name, ''), new.address, new.service_type, COALESCE(new.notes, ''));
END;

CREATE INDEX IF NOT EXISTS idx_locations_status_coordinates ON locations(status, latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_locations_verification_due ON locations(status, verification_due_at);
CREATE INDEX IF NOT EXISTS idx_operating_hours_lookup ON location_operating_hours(location_id, day_of_week, opens_at, closes_at);
CREATE INDEX IF NOT EXISTS idx_location_events_location ON location_events(location_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_location_evidence_location_checked ON location_evidence(location_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_confirmations_location_submitted ON location_confirmations(location_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_confirmations_client_submitted ON location_confirmations(client_hash, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_verification_jobs_status_scheduled ON verification_jobs(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_verification_jobs_location ON verification_jobs(location_id, created_at DESC);

UPDATE locations
SET verification_due_at = datetime(COALESCE(last_verified_at, last_reviewed_at, updated_at), '+90 days')
WHERE verification_due_at IS NULL;

PRAGMA optimize;

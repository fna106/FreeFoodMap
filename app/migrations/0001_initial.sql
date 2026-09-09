CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  address TEXT NOT NULL,
  normalized_address TEXT NOT NULL,
  zip_code TEXT NOT NULL,
  service_type TEXT NOT NULL,
  organization_name TEXT,
  hours TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  contact_web TEXT,
  notes TEXT,
  source_url TEXT,
  latitude REAL,
  longitude REAL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  last_verified_at TEXT,
  source_suggestion_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  address TEXT NOT NULL,
  normalized_address TEXT NOT NULL,
  zip_code TEXT NOT NULL,
  service_type TEXT NOT NULL,
  organization_name TEXT,
  hours TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  contact_web TEXT,
  notes TEXT,
  source_url TEXT,
  submitter_email TEXT,
  verified_recently INTEGER NOT NULL DEFAULT 0,
  latitude REAL,
  longitude REAL,
  duplicate_of_location_id INTEGER REFERENCES locations(id),
  client_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  review_notes TEXT,
  published_location_id INTEGER REFERENCES locations(id),
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  contact_email TEXT,
  client_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution_notes TEXT,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS workflow_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_locations_status_zip ON locations(status, zip_code);
CREATE INDEX IF NOT EXISTS idx_locations_service_type ON locations(service_type);
CREATE INDEX IF NOT EXISTS idx_locations_normalized_address ON locations(normalized_address);
CREATE INDEX IF NOT EXISTS idx_suggestions_status_submitted ON suggestions(status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_suggestions_client_time ON suggestions(client_hash, submitted_at);
CREATE INDEX IF NOT EXISTS idx_reports_status_submitted ON reports(status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_reports_client_time ON reports(client_hash, submitted_at);
CREATE INDEX IF NOT EXISTS idx_reports_location ON reports(location_id);

PRAGMA optimize;

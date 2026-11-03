ALTER TABLE locations ADD COLUMN geocode_attempted_at TEXT;
ALTER TABLE suggestions ADD COLUMN geocode_attempted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_locations_geocode_retry ON locations(status,geocode_attempted_at,id);
CREATE INDEX IF NOT EXISTS idx_suggestions_geocode_retry ON suggestions(status,geocode_attempted_at,id);

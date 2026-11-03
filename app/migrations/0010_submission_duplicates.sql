-- Preserve review history, but retire repeated pending entries before enforcing uniqueness.
UPDATE suggestions SET status='rejected', review_notes='Duplicate pending physical location; retained for history', reviewed_at=CURRENT_TIMESTAMP
WHERE status='pending' AND id NOT IN (SELECT MIN(id) FROM suggestions WHERE status='pending' GROUP BY normalized_address,zip_code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_suggestion_address ON suggestions(normalized_address,zip_code) WHERE status='pending';
CREATE TRIGGER IF NOT EXISTS prevent_known_suggestion BEFORE INSERT ON suggestions
WHEN EXISTS (
 SELECT 1 FROM locations l WHERE
 (l.zip_code=NEW.zip_code AND
 replace(replace(replace(replace(lower(trim(substr(l.address,1,instr(l.address||',',',')-1))),'.',''),' street',' st'),' road',' rd'),' avenue',' ave') =
 replace(replace(replace(replace(lower(trim(substr(NEW.address,1,instr(NEW.address||',',',')-1))),'.',''),' street',' st'),' road',' rd'),' avenue',' ave'))
 OR (NEW.source_url IS NOT NULL AND l.source_url=NEW.source_url)
) OR EXISTS (
 SELECT 1 FROM suggestions s WHERE
 (s.zip_code=NEW.zip_code AND
 replace(replace(replace(replace(lower(trim(substr(s.address,1,instr(s.address||',',',')-1))),'.',''),' street',' st'),' road',' rd'),' avenue',' ave') =
 replace(replace(replace(replace(lower(trim(substr(NEW.address,1,instr(NEW.address||',',',')-1))),'.',''),' street',' st'),' road',' rd'),' avenue',' ave'))
 OR (NEW.source_url IS NOT NULL AND s.source_url=NEW.source_url)
) BEGIN SELECT RAISE(IGNORE); END;

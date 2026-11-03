-- Split daily intervals need manual review; never advertise a partial or invented opening interval.
DELETE FROM location_operating_hours WHERE location_id IN (
 SELECT id FROM locations WHERE lower(hours) LIKE '%pm and %' OR lower(hours) LIKE '%am and %'
);

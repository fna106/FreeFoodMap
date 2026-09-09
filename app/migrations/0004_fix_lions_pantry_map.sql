UPDATE locations
SET zip_code = '16802', latitude = 40.810513, longitude = -77.8669855,
  updated_at = CURRENT_TIMESTAMP
WHERE id = 83 AND normalized_address = '133 bluebell road university park pa';

PRAGMA optimize;

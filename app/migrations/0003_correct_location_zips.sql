UPDATE locations
SET zip_code = '17764', updated_at = CURRENT_TIMESTAMP
WHERE id = 19 AND normalized_address = '127 7th street renovo pa';

UPDATE locations
SET zip_code = '16651', updated_at = CURRENT_TIMESTAMP
WHERE id = 53 AND normalized_address = '76 emery avenue houtzdale pa';

UPDATE locations
SET zip_code = '16601', updated_at = CURRENT_TIMESTAMP
WHERE id = 57 AND normalized_address = '1520 11th street altoona pa';

UPDATE locations
SET name = 'The Christian Food Bank', normalized_name = 'the christian food bank',
  zip_code = '15857', updated_at = CURRENT_TIMESTAMP
WHERE id = 81 AND normalized_address = '817 south michael road saint marys pa';

PRAGMA optimize;

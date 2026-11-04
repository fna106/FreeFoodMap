import { execFileSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const scope = process.argv[2];
if (!['--local', '--remote'].includes(scope) || process.argv.length !== 3) {
	throw new Error('Choose --local or --remote explicitly.');
}
const sql = `SELECT id, name, address, zip_code, service_type, organization_name, hours,
	contact_phone, contact_email, contact_web, notes, latitude, longitude, eligibility,
	accessibility, languages, appointment_required, schedule_timezone, verification_status,
	verified_fields, last_verified_at, last_reviewed_at, verification_due_at, updated_at
	FROM locations WHERE status = 'active' ORDER BY id`;
const output = execFileSync(process.execPath, [
	resolve(root, 'node_modules/wrangler/bin/wrangler.js'),
	'd1', 'execute', 'free-food-map-db', scope, '--json', '--command', sql,
], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const [result] = JSON.parse(output);
if (!result?.success || !result.results?.length) throw new Error('Snapshot export returned no active locations.');
const target = resolve(root, 'public/location-snapshot.json');
writeFileSync(target + '.tmp', JSON.stringify({
	locations: result.results,
	snapshot_at: new Date().toISOString(),
}) + '\n');
renameSync(target + '.tmp', target);
console.log(`Exported ${result.results.length} public listings.`);

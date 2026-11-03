import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { normalizeRecord } from '../src/hours.js';

const root = resolve(import.meta.dirname, '..');
const runner = process.env.npm_execpath ? process.execPath : (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
const runnerArgs = process.env.npm_execpath ? [process.env.npm_execpath, 'exec'] : ['exec'];
const output = execFileSync(runner, [...runnerArgs, 'wrangler', 'd1', 'execute', 'free-food-map-db', '--local', '--json',
	'--command', "SELECT id, name, hours, COALESCE(verification_source_url, source_url, contact_web) AS source_url, COALESCE(last_verified_at, last_reviewed_at) AS last_verified_at FROM locations WHERE status = 'active' AND hours IS NOT NULL AND trim(hours) != '' ORDER BY id",
], { cwd: root, encoding: 'utf8' });
const records = JSON.parse(output)[0].results;

function quote(value) {
	if (value == null || value === '') return 'NULL';
	return `'${String(value).replaceAll("'", "''")}'`;
}

const accepted = [];
const rejected = [];
for (const record of records) {
	const parsed = normalizeRecord(record);
	if (parsed.rows.length) accepted.push({ ...record, rows: parsed.rows });
	else rejected.push({ ...record, reason: parsed.reason });
}

const sql = [
	'DELETE FROM location_operating_hours;',
	...accepted.flatMap((record) => record.rows.map((row) =>
		`INSERT INTO location_operating_hours (location_id, day_of_week, opens_at, closes_at, source_url, last_verified_at) VALUES (${record.id}, ${row.day}, '${row.opens}', '${row.closes}', ${quote(record.source_url)}, ${quote(record.last_verified_at)});`,
	)),
	'PRAGMA optimize;',
	'',
].join('\n');
const migrationPath = resolve(root, 'migrations', String(Math.max(...readdirSync(resolve(root, 'migrations')).filter(name => /^\d{4}_/.test(name)).map(name => Number(name.slice(0, 4)))) + 1).padStart(4, '0') + '_structured_hours.sql');
writeFileSync(migrationPath, sql, { flag: 'wx' });

const reportPath = resolve(root, 'reports', 'structured-hours.md');
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, [
	'# Structured hours normalization',
	'',
	`Generated: ${new Date().toISOString()}`,
	`Locations with original hours: ${records.length}`,
	`Locations promoted to structured weekly hours: ${accepted.length}`,
	`Locations left as display-only hours: ${rejected.length}`,
	`Structured day/time rows: ${accepted.reduce((total, record) => total + record.rows.length, 0)}`,
	'',
	'Only unambiguous weekly schedules are used for Open now. Recurring monthly, seasonal, appointment-based, and unclear schedules remain available as their original display text.',
	'',
	'## Not promoted',
	'',
	...rejected.map((record) => `- ${record.id}: ${record.name} (${record.reason})`),
	'',
].join('\n'));

console.log(`Wrote ${migrationPath}`);
console.log(`Promoted ${accepted.length} of ${records.length} locations into ${accepted.reduce((total, record) => total + record.rows.length, 0)} schedule rows.`);
console.log(`Review report: ${reportPath}`);

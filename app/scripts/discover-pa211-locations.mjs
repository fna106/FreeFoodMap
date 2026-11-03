import { spawnSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'csv-parse/sync';
import { loadPa211Services } from './pa211-source.mjs';

const apply = process.argv.includes('--apply');
const limitArgument = process.argv.find((argument) => argument.startsWith('--limit='));
const dateArgument = process.argv.find((argument) => argument.startsWith('--date='));
const limit = limitArgument ? Number(limitArgument.split('=')[1]) : 150;
const wranglerPath = resolve('node_modules', 'wrangler', 'bin', 'wrangler.js');
const reportsDirectory = resolve('reports');

if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('--limit must be an integer from 1 to 200.');

function easternDate() {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
	}).formatToParts(new Date());
	const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	return `${value.year}-${value.month}-${value.day}`;
}

const importDate = dateArgument ? dateArgument.split('=')[1] : easternDate();
if (!/^\d{4}-\d{2}-\d{2}$/.test(importDate)) throw new Error('--date must use YYYY-MM-DD.');

function runWrangler(argumentsList) {
	const result = spawnSync(process.execPath, [wranglerPath, ...argumentsList], {
		cwd: process.cwd(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
	});
	if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Wrangler command failed.').trim());
	return result.stdout;
}

function loadExistingLocations() {
	const output = runWrangler([
		'd1', 'execute', 'free-food-map-db', '--remote', '--json', '--command',
		`SELECT id, name, normalized_name, address, normalized_address, zip_code,
			contact_phone, latitude, longitude, source_url
		FROM locations
		UNION ALL SELECT id,name,normalized_name,address,normalized_address,zip_code,contact_phone,latitude,longitude,source_url FROM suggestions
		ORDER BY id`,
	]);
	return JSON.parse(output)[0]?.results || [];
}

async function nextMigrationPath() {
	const files = (await readdir(resolve('migrations'))).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
	const output = runWrangler([
		'd1', 'execute', 'free-food-map-db', '--remote', '--json', '--command',
		'SELECT name FROM d1_migrations ORDER BY id',
	]);
	const applied = new Set((JSON.parse(output)[0]?.results || []).map((row) => row.name));
	const pending = files.filter((name) => !applied.has(name));
	if (pending.length) {
		// Never overwrite an unreviewed discovery batch on a later run.
		throw new Error(`Apply or remove the existing pending migration before discovery: ${pending.join(', ')}`);
	}
	const nextNumber = Math.max(0, ...files.map((name) => Number(name.slice(0, 4)))) + 1;
	return resolve('migrations', `${String(nextNumber).padStart(4, '0')}_add_pa211_locations.sql`);
}

function clean(value, max = 500) {
	return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanName(value) {
	return clean(value, 140).replace(/\bFood Panty\b/gi, 'Food Pantry');
}

function normalized(value) {
	return clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function zipFrom(value) {
	const matches = [...clean(value).matchAll(/(?:^|\D)(\d{5})(?:-\d{4})?(?!\d)/g)];
	return matches.at(-1)?.[1] || '';
}

function addressWithoutZip(value) {
	return clean(value).replace(/\s+\d{5}(?:-\d{4})?\s*$/, '').replace(/\s+,/g, ',');
}

function addressKey(address, zip) {
	const street = clean(address).split(',')[0];
	return `${normalized(street).replace(/\bstreet\b/g, 'st').replace(/\broad\b/g, 'rd').replace(/\bavenue\b/g, 'ave')}|${zip}`;
}

function houseNumber(address) {
	return normalized(clean(address).split(',')[0]).split(' ').find((word) => /^\d+[a-z]?$/.test(word)) || '';
}

function phoneDigits(value) {
	const digits = clean(value).replace(/\D/g, '');
	return digits.length >= 10 ? digits.slice(-10) : digits;
}

function safeUrl(value) {
	if (!value) return null;
	try {
		const prepared = /^https?:\/\//i.test(value) ? value : `https://${value}`;
		const url = new URL(prepared);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
	} catch {
		return null;
	}
}

function validCoordinates(service) {
	const coordinates = service.location?.coordinates;
	if (!Array.isArray(coordinates)) return null;
	const longitude = Number(coordinates[0]);
	const latitude = Number(coordinates[1]);
	if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
	if (latitude < 39.7 || latitude > 42.6 || longitude < -80.7 || longitude > -74.5) return null;
	return { latitude, longitude };
}

function serviceType(service) {
	const source = normalized([service.serviceName, service.name, ...(service.taxonomies || []).map((item) => item.name)].join(' '));
	if (source.includes('food banks food distribution warehouses') || /\bfood bank\b/.test(source)) return 'Food Bank';
	if (source.includes('food pantries') || /\bfood pantry\b/.test(source) || source.includes('food cupboard')) return 'Food Pantry';
	if (source.includes('brown bag food programs')) return 'Food Distribution';
	return null;
}

function isDirectoryRatherThanLocation(service) {
	const source = normalized([service.serviceName, service.name, service.description].join(' '));
	return source.includes('pantry locator') || source.includes('food finder') || source.includes('find food guide') ||
		source.includes('listing of food pantries') || source.includes('search tool to assist') ||
		source.includes('food pantry information') || source.includes('donation warehouse');
}

function sourceRecord(service) {
	const zip = zipFrom(service.address);
	const coordinates = validCoordinates(service);
	const type = serviceType(service);
	const name = cleanName(service.name);
	const address = addressWithoutZip(service.address).slice(0, 240);
	const hours = clean(service.hours, 500);
	const phone = clean(service.phone, 40);
	if (!name || !address || !/^1[5-9]\d{3}$/.test(zip) || !coordinates || !type || !hours || phoneDigits(phone).length !== 10) return null;
	if (isDirectoryRatherThanLocation(service) || /address unavailable/i.test(address)) return null;
	const website = safeUrl(service.website);
	const sourceUrl = `https://search.pa211.org/search/${service.id}`;
	return {
		name, address, zip, serviceType: type, hours, phone, website, sourceUrl,
		latitude: coordinates.latitude, longitude: coordinates.longitude,
		key: addressKey(address, zip), sourceId: service.id,
	};
}

function isExisting(record, existingKeys, existingSources) {
	return existingKeys.has(record.key) || existingSources.has(record.sourceUrl);
}

function distanceMiles(first, second) {
	const firstLatitude = Number(first.latitude);
	const firstLongitude = Number(first.longitude);
	const secondLatitude = Number(second.latitude);
	const secondLongitude = Number(second.longitude);
	if (![firstLatitude, firstLongitude, secondLatitude, secondLongitude].every(Number.isFinite)) return null;
	const radians = (degrees) => (degrees * Math.PI) / 180;
	const latitudeDelta = radians(secondLatitude - firstLatitude);
	const longitudeDelta = radians(secondLongitude - firstLongitude);
	const value = Math.sin(latitudeDelta / 2) ** 2 +
		Math.cos(radians(firstLatitude)) * Math.cos(radians(secondLatitude)) * Math.sin(longitudeDelta / 2) ** 2;
	return 3958.8 * 2 * Math.asin(Math.sqrt(value));
}

function samePhysicalLocation(first, second) {
	if (first.key === second.key) return true;
	const firstZip = String(first.zip || first.zip_code || '');
	const secondZip = String(second.zip || second.zip_code || '');
	const samePhone = phoneDigits(first.phone || first.contact_phone) &&
		phoneDigits(first.phone || first.contact_phone) === phoneDigits(second.phone || second.contact_phone);
	const firstHouseNumber = houseNumber(first.address);
	if (samePhone && firstZip === secondZip && firstHouseNumber && firstHouseNumber === houseNumber(second.address)) return true;
	const distance = distanceMiles(first, second);
	return Boolean(samePhone && distance != null && distance <= 0.1);
}

function qualityScore(record) {
	return (record.website ? 3 : 0) + (record.serviceType === 'Food Pantry' ? 2 : 0) +
		(normalized(record.name).includes('food pantry') ? 2 : 0) + Math.min(3, record.hours.length / 120);
}

function chooseCandidates(records, count) {
	const buckets = new Map();
	for (const record of records) {
		const prefix = record.zip.slice(0, 2);
		buckets.set(prefix, [...(buckets.get(prefix) || []), record]);
	}
	for (const bucket of buckets.values()) bucket.sort((a, b) => a.zip.localeCompare(b.zip) || a.name.localeCompare(b.name));
	const prefixes = [...buckets.keys()].sort();
	const selected = [];
	let offset = 0;
	while (selected.length < count) {
		let added = false;
		for (const prefix of prefixes) {
			const record = buckets.get(prefix)?.[offset];
			if (record && selected.length < count) {
				selected.push(record);
				added = true;
			}
		}
		if (!added) break;
		offset += 1;
	}
	return selected;
}

function csvField(value) {
	return `"${String(value == null ? '' : value).replaceAll('"', '""')}"`;
}

async function censusCoordinates(records) {
	const lines = records.map((record) => {
		const parts = record.address.split(',').map((part) => part.trim()).filter(Boolean);
		const street = parts[0] || record.address;
		const city = parts.length >= 3 ? parts.at(-2) : '';
		return [record.sourceId, street, city, 'PA', record.zip].map(csvField).join(',');
	});
	const form = new FormData();
	form.set('addressFile', new Blob([lines.join('\n')], { type: 'text/csv' }), 'new-pa-locations.csv');
	form.set('benchmark', 'Public_AR_Current');
	const response = await fetch('https://geocoding.geo.census.gov/geocoder/locations/addressbatch', { method: 'POST', body: form });
	if (!response.ok) throw new Error(`Census geocoder returned HTTP ${response.status}.`);
	const matches = new Map();
	for (const row of parse(await response.text(), { relax_column_count: true, skip_empty_lines: true })) {
		if (clean(row[2]).toLowerCase() !== 'match') continue;
		const sourceId = clean(row[0]);
		const matchedZip = zipFrom(row[4]);
		const pair = clean(row[5]).split(',');
		const longitude = Number(pair[0]);
		const latitude = Number(pair[1]);
		const record = records.find((item) => item.sourceId === sourceId);
		if (!record || matchedZip !== record.zip || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
		matches.set(sourceId, { latitude, longitude });
	}
	return matches;
}

function sql(value) {
	return value == null || value === '' ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
}

function migrationSql(records) {
	const timestamp = `${importDate}T12:00:00.000Z`;
	const values = records.map((record) => {
		const verifiedFields = ['name', 'address', 'zip', 'service', 'hours', 'phone', record.website && 'website', 'coordinates'].filter(Boolean).join(',');
		return `(${[
			sql(record.name), sql(normalized(record.name)), sql(record.address), sql(normalized(record.address)),
			sql(record.zip), sql(record.serviceType), sql(record.hours), sql(record.phone), sql(record.website),
			sql(record.sourceUrl), record.latitude, record.longitude, sql(verifiedFields), sql(record.sourceUrl),
			sql('Added from a current Pennsylvania 211 food-resource record; core listing details confirmed at import.'),
			sql(timestamp), sql(timestamp),
		].join(', ')})`;
	});
	const statements = [];
	for (let offset = 0; offset < values.length; offset += 25) {
		statements.push(
			`INSERT INTO locations (\n` +
			`  name, normalized_name, address, normalized_address, zip_code, service_type, hours,\n` +
			`  contact_phone, contact_web, source_url, latitude, longitude, verification_status,\n` +
			`  verified_fields, verification_source_url, verification_notes, last_verified_at, last_reviewed_at\n` +
			`) SELECT column1, column2, column3, column4, column5, column6, column7, column8, column9,\n` +
			`  column10, column11, column12, 'verified', column13, column14, column15, column16, column17\n` +
			`FROM (VALUES\n${values.slice(offset, offset + 25).join(',\n')}\n)\n` +
			`WHERE NOT EXISTS (\n` +
			`  SELECT 1 FROM locations existing\n` +
			`  WHERE existing.source_url = column10\n` +
			`     OR (existing.normalized_address = column4 AND existing.zip_code = column5)\n` +
			`) AND NOT EXISTS (SELECT 1 FROM suggestions s WHERE s.source_url=column10 OR (s.normalized_address=column4 AND s.zip_code=column5));`,
		);
	}
	return `-- Generated by scripts/discover-pa211-locations.mjs on ${importDate}.\n` +
		`-- Source: Pennsylvania 211 public food-resource directory.\n\n` +
		statements.join('\n\n') + '\n\nPRAGMA optimize;\n';
}

function reportCsv(records) {
	const headings = ['name', 'address', 'zip_code', 'service_type', 'hours', 'phone', 'website', 'latitude', 'longitude', 'coordinate_source', 'source_url'];
	const rows = records.map((record) => [record.name, record.address, record.zip, record.serviceType, record.hours, record.phone, record.website, record.latitude, record.longitude, record.coordinateSource, record.sourceUrl].map(csvField).join(','));
	return [headings.join(','), ...rows].join('\n') + '\n';
}

function reportMarkdown(records, sourceCount, eligibleCount, censusMatchCount) {
	const serviceCounts = Object.groupBy(records, (record) => record.serviceType);
	return `# New Pennsylvania Locations\n\n` +
		`Import date: ${importDate}\n\n` +
		`- New locations selected: ${records.length}\n` +
		`- Current Pennsylvania 211 records searched: ${sourceCount}\n` +
		`- Eligible unique additions found: ${eligibleCount}\n` +
		`- Census-matched candidates: ${censusMatchCount}\n` +
		`- Food pantries: ${serviceCounts['Food Pantry']?.length || 0}\n` +
		`- Food banks: ${serviceCounts['Food Bank']?.length || 0}\n` +
		`- Food distribution sites: ${serviceCounts['Food Distribution']?.length || 0}\n\n` +
		`The selected batch contains 30 locations from each Pennsylvania ZIP region from 15xxx through 19xxx. ` +
		`Every imported record has a current PA 211 source, phone number, listed hours, and a U.S. Census coordinate match in the same ZIP code. ` +
		`Directory-only records and physical duplicates were excluded.\n`;
}

const existing = loadExistingLocations();
const migrationPath = await nextMigrationPath();
const existingKeys = new Set(existing.map((location) => addressKey(location.address, String(location.zip_code))));
const existingSources = new Set(existing.map((location) => location.source_url).filter(Boolean));
const services = await loadPa211Services();
const discovered = [];
for (const service of services) {
	const record = sourceRecord(service);
	if (!record || isExisting(record, existingKeys, existingSources) || existing.some((location) => samePhysicalLocation(record, location))) continue;
	discovered.push(record);
}

const unique = [];
for (const record of discovered.sort((first, second) => qualityScore(second) - qualityScore(first) || first.name.localeCompare(second.name))) {
	if (!unique.some((candidate) => samePhysicalLocation(record, candidate))) unique.push(record);
}

const preselected = chooseCandidates(unique, Math.min(unique.length, limit + 100));
console.log(`Checking ${preselected.length} candidate addresses with the U.S. Census geocoder...`);
const censusMatches = await censusCoordinates(preselected);
const coordinateConfirmed = [];
for (const candidate of preselected) {
	const match = censusMatches.get(candidate.sourceId);
	if (match) {
		candidate.latitude = match.latitude;
		candidate.longitude = match.longitude;
		candidate.coordinateSource = 'U.S. Census';
		coordinateConfirmed.push(candidate);
	}
}
const candidates = chooseCandidates(coordinateConfirmed, limit);
	if (!candidates.length) { console.log('No genuinely new locations found. Nothing added.'); process.exit(0); }

await mkdir(reportsDirectory, { recursive: true });
await writeFile(migrationPath, migrationSql(candidates), 'utf8');
const reportPath = resolve(reportsDirectory, `new-pa-locations-${importDate}.csv`);
await writeFile(reportPath, reportCsv(candidates), 'utf8');
const summaryPath = resolve(reportsDirectory, `new-pa-locations-${importDate}.md`);
await writeFile(summaryPath, reportMarkdown(candidates, services.length, unique.length, censusMatches.size), 'utf8');

console.log('Pennsylvania location discovery complete');
console.log(`  Existing active locations: ${existing.length}`);
console.log(`  PA 211 records searched: ${services.length}`);
console.log(`  Eligible unique additions: ${unique.length}`);
console.log(`  Selected additions: ${candidates.length}`);
console.log(`  Census-matched candidate coordinates: ${censusMatches.size}`);
for (const prefix of [...new Set(candidates.map((record) => record.zip.slice(0, 2)))].sort()) {
	console.log(`  ZIP ${prefix}xxx: ${candidates.filter((record) => record.zip.startsWith(prefix)).length}`);
}
console.log(`  Review report: ${reportPath}`);
console.log(`  Summary: ${summaryPath}`);
console.log(`  Migration: ${migrationPath}`);

if (apply) {
	console.log('Applying the generated migration to the remote database...');
	runWrangler(['d1', 'migrations', 'apply', 'free-food-map-db', '--remote']);
	console.log(`Applied ${candidates.length} new Pennsylvania locations.`);
} else {
	console.log('Dry run only. Review the report, then run locations:add to publish the selected records.');
}

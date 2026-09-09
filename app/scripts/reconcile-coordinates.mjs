import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parse } from 'csv-parse/sync';

const apply = process.argv.includes('--apply');
const thresholdArgument = process.argv.find((argument) => argument.startsWith('--threshold-miles='));
const thresholdMiles = thresholdArgument ? Number(thresholdArgument.split('=')[1]) : 1;

if (!Number.isFinite(thresholdMiles) || thresholdMiles < 0) {
	throw new Error('The distance threshold must be a non-negative number.');
}

const wranglerPath = resolve('node_modules', 'wrangler', 'bin', 'wrangler.js');

function runWrangler(argumentsList) {
	const result = spawnSync(process.execPath, [wranglerPath, ...argumentsList], {
		cwd: process.cwd(),
		encoding: 'utf8',
		maxBuffer: 8 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error((result.stderr || result.stdout || 'Wrangler command failed.').trim());
	}
	return result.stdout;
}

function loadLocations() {
	const sql = `SELECT id, name, address, zip_code, latitude, longitude
		FROM locations WHERE status = 'active' ORDER BY id`;
	const output = runWrangler([
		'd1',
		'execute',
		'free-food-map-db',
		'--remote',
		'--json',
		'--command',
		sql,
	]);
	const payload = JSON.parse(output);
	return payload[0]?.results || [];
}

function clean(value) {
	return String(value || '').trim().replace(/\s+/g, ' ');
}

function splitAddress(value, fallbackZip) {
	const parts = clean(value).split(',').map((part) => part.trim()).filter(Boolean);
	const finalPart = parts.at(-1) || '';
	const stateMatch = finalPart.match(/\b([A-Z]{2})\b/i);
	const zipMatch = finalPart.match(/\b(\d{5})\b/);
	let city = '';
	if (stateMatch) {
		parts.pop();
		city = parts.pop() || '';
	}
	return {
		street: parts.join(', '),
		city,
		state: stateMatch ? stateMatch[1].toUpperCase() : 'PA',
		zip: zipMatch ? zipMatch[1] : clean(fallbackZip),
	};
}

function csvField(value) {
	return '"' + String(value).replaceAll('"', '""') + '"';
}

async function geocodeLocations(locations) {
	const batchLines = locations.map((location) => {
		const address = splitAddress(location.address, location.zip_code);
		return [location.id, address.street, address.city, address.state, address.zip]
			.map(csvField)
			.join(',');
	});
	const form = new FormData();
	form.set('addressFile', new Blob([batchLines.join('\n')], { type: 'text/csv' }), 'locations.csv');
	form.set('benchmark', 'Public_AR_Current');

	const response = await fetch('https://geocoding.geo.census.gov/geocoder/locations/addressbatch', {
		method: 'POST',
		body: form,
	});
	if (!response.ok) throw new Error('Census geocoder returned ' + response.status + '.');

	const rows = parse(await response.text(), {
		relax_column_count: true,
		skip_empty_lines: true,
	});
	const matches = new Map();
	for (const row of rows) {
		if (clean(row[2]).toLowerCase() !== 'match') continue;
		const id = Number(row[0]);
		const pair = clean(row[5]).split(',');
		const longitude = Number(pair[0]);
		const latitude = Number(pair[1]);
		const matchedAddress = clean(row[4]);
		const matchedZip = matchedAddress.match(/\b\d{5}(?:-\d{4})?\b/)?.[0]?.slice(0, 5) || '';
		if (!Number.isInteger(id) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
		matches.set(id, { latitude, longitude, matchedAddress, matchedZip });
	}
	return matches;
}

function haversineMiles(first, second) {
	const radians = (degrees) => (degrees * Math.PI) / 180;
	const earthRadiusMiles = 3958.8;
	const latitudeDelta = radians(second.latitude - first.latitude);
	const longitudeDelta = radians(second.longitude - first.longitude);
	const latitudeOne = radians(first.latitude);
	const latitudeTwo = radians(second.latitude);
	const value =
		Math.sin(latitudeDelta / 2) ** 2 +
		Math.cos(latitudeOne) * Math.cos(latitudeTwo) * Math.sin(longitudeDelta / 2) ** 2;
	return 2 * earthRadiusMiles * Math.asin(Math.sqrt(value));
}

function applyChanges(changes) {
	for (let offset = 0; offset < changes.length; offset += 40) {
		const sql = changes
			.slice(offset, offset + 40)
			.map(
				(change) =>
					`UPDATE locations SET latitude = ${change.match.latitude}, longitude = ${change.match.longitude}, ` +
					`updated_at = CURRENT_TIMESTAMP WHERE id = ${change.location.id};`,
			)
			.join('\n');
		runWrangler([
			'd1',
			'execute',
			'free-food-map-db',
			'--remote',
			'--json',
			'--command',
			sql,
		]);
	}
}

const locations = loadLocations();
const matches = await geocodeLocations(locations);
const rejectedZipMatches = [];
const changes = [];

for (const location of locations) {
	const match = matches.get(Number(location.id));
	if (!match) continue;
	if (!match.matchedZip || match.matchedZip !== location.zip_code) {
		rejectedZipMatches.push({ location, match });
		continue;
	}
	const hasStoredPoint = Number.isFinite(location.latitude) && Number.isFinite(location.longitude);
	const distanceMiles = hasStoredPoint
		? haversineMiles(
				{ latitude: Number(location.latitude), longitude: Number(location.longitude) },
				match,
			)
		: null;
	if (!hasStoredPoint || distanceMiles >= thresholdMiles) {
		changes.push({ location, match, distanceMiles });
	}
}

changes.sort((first, second) => (second.distanceMiles ?? Number.POSITIVE_INFINITY) - (first.distanceMiles ?? Number.POSITIVE_INFINITY));

console.log('Coordinate audit');
console.log('  Active locations: ' + locations.length);
console.log('  Census matches: ' + matches.size);
console.log('  Rejected ZIP mismatches: ' + rejectedZipMatches.length);
console.log('  Proposed updates: ' + changes.length);

for (const item of rejectedZipMatches) {
	console.log(
		`  REJECT ${item.location.id} ${item.location.name}: requested ${item.location.zip_code}, matched ${item.match.matchedZip || 'unknown'} (${item.match.matchedAddress})`,
	);
}

for (const item of changes) {
	const distance = item.distanceMiles == null ? 'missing coordinates' : item.distanceMiles.toFixed(2) + ' miles';
	console.log(
		`  UPDATE ${item.location.id} ${item.location.name}: ${distance} -> ${item.match.latitude}, ${item.match.longitude}`,
	);
}

if (apply && changes.length) {
	applyChanges(changes);
	console.log('Applied ' + changes.length + ' coordinate updates to the remote database.');
} else if (apply) {
	console.log('No coordinate updates were needed.');
} else {
	console.log('Dry run only. Re-run with --apply after reviewing the proposed updates.');
}

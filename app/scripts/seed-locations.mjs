import { readFile, writeFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';

const inputPath = process.argv[2] || '../FFM_data.csv';
const outputPath = process.argv[3] || 'migrations/0002_seed_locations.sql';
const shouldGeocode = process.argv.includes('--geocode');

function clean(value) {
	let result = String(value || '').trim();
	while (result.length >= 2 && result.startsWith('"') && result.endsWith('"')) {
		result = result.slice(1, -1).trim();
	}
	return result.replace(/\s+/g, ' ');
}

function normalized(value) {
	return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function cleanZip(value) {
	const digits = clean(value).replace(/\D/g, '');
	return /^\d{4}$/.test(digits) ? digits.padStart(5, '0') : digits;
}

function sql(value) {
	const result = clean(value);
	return result ? "'" + result.replaceAll("'", "''") + "'" : 'NULL';
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
		zip: zipMatch ? zipMatch[1] : cleanZip(fallbackZip),
	};
}

async function geocode(rows) {
	const expectedZips = new Map(rows.map((row) => [clean(row.location_id), cleanZip(row.zip_code)]));
	const batchLines = rows.map((row) => {
		const address = splitAddress(row.address, row.zip_code);
		return [row.location_id, address.street, address.city, address.state, address.zip]
			.map((field) => '"' + String(field).replaceAll('"', '""') + '"')
			.join(',');
	});
	const form = new FormData();
	form.set('addressFile', new Blob([batchLines.join('\n')], { type: 'text/csv' }), 'locations.csv');
	form.set('benchmark', 'Public_AR_Current');
	const response = await fetch('https://geocoding.geo.census.gov/geocoder/locations/addressbatch', {
		method: 'POST',
		body: form,
	});
	if (!response.ok) throw new Error('Census geocoder returned ' + response.status);
	const responseText = await response.text();
	if (process.env.DEBUG_GEOCODE) console.log(responseText.slice(0, 1200));
	const results = parse(responseText, { relax_column_count: true, skip_empty_lines: true });
	const coordinates = new Map();
	for (const result of results) {
		const id = String(result[0] || '');
		const match = String(result[2] || '').toLowerCase();
		const pair = String(result[5] || '').split(',');
		const longitude = Number(pair[0]);
		const latitude = Number(pair[1]);
		const matchedZip = String(result[4] || '').match(/\b\d{5}(?:-\d{4})?\b/)?.[0]?.slice(0, 5) || '';
		if (
			match === 'match' &&
			matchedZip === expectedZips.get(id) &&
			Number.isFinite(latitude) &&
			Number.isFinite(longitude)
		) {
			coordinates.set(id, { latitude, longitude });
		}
	}
	return coordinates;
}

const csv = await readFile(inputPath, 'utf8');
const rows = parse(csv, {
	columns: true,
	bom: true,
	skip_empty_lines: true,
	relax_quotes: true,
	relax_column_count: true,
})
	.map((row) => ({ ...row, zip_code: cleanZip(row.zip_code) }))
	.filter((row) => clean(row.name) && clean(row.address) && /^\d{5}$/.test(row.zip_code));

let coordinates = new Map();
if (shouldGeocode) {
	try {
		coordinates = await geocode(rows);
		console.log('Geocoded ' + coordinates.size + ' of ' + rows.length + ' records.');
	} catch (error) {
		console.warn('Geocoding skipped: ' + error.message);
	}
}

const statements = [
	'-- Generated from ../FFM_data.csv by scripts/seed-locations.mjs.',
	'-- Coordinates not matched here are filled by the scheduled Worker job.',
];

for (let offset = 0; offset < rows.length; offset += 100) {
	const chunk = rows.slice(offset, offset + 100);
	const values = chunk.map((row) => {
		const point = coordinates.get(clean(row.location_id));
		return (
			'(' +
			[
				Number(row.location_id),
				sql(row.name),
				sql(normalized(row.name)),
				sql(row.address),
				sql(normalized(row.address)),
				sql(row.zip_code),
				sql(row.service_type || 'Other'),
				sql(row.hours),
				sql(row.contact_phone),
				sql(row.contact_email),
				sql(row.contact_web),
				sql(row.notes),
				point ? point.latitude : 'NULL',
				point ? point.longitude : 'NULL',
			].join(', ') +
			')'
		);
	});
	statements.push(
		'INSERT OR IGNORE INTO locations (' +
			'id, name, normalized_name, address, normalized_address, zip_code, service_type, ' +
			'hours, contact_phone, contact_email, contact_web, notes, latitude, longitude' +
			') VALUES\n' +
			values.join(',\n') +
			';',
	);
}

statements.push('PRAGMA optimize;');
await writeFile(outputPath, statements.join('\n\n') + '\n', 'utf8');
console.log('Wrote ' + rows.length + ' locations to ' + outputPath + '.');

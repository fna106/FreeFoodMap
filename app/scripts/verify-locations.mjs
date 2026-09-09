import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetchText, loadPa211Services, pooled } from './pa211-source.mjs';

const apply = process.argv.includes('--apply');
const skipWebsites = process.argv.includes('--skip-websites');
const dateArgument = process.argv.find((argument) => argument.startsWith('--date='));
const pageArgument = process.argv.find((argument) => argument.startsWith('--pages='));
const requestedPages = pageArgument ? Number(pageArgument.split('=')[1]) : null;
const wranglerPath = resolve('node_modules', 'wrangler', 'bin', 'wrangler.js');
const reportsDirectory = resolve('reports');

if (requestedPages != null && (!Number.isInteger(requestedPages) || requestedPages < 1)) {
	throw new Error('--pages must be a positive integer.');
}

function easternDate() {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/New_York',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(new Date());
	const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	return `${value.year}-${value.month}-${value.day}`;
}

const auditDate = dateArgument ? dateArgument.split('=')[1] : easternDate();
if (!/^\d{4}-\d{2}-\d{2}$/.test(auditDate)) throw new Error('--date must use YYYY-MM-DD.');

function runWrangler(argumentsList) {
	const result = spawnSync(process.execPath, [wranglerPath, ...argumentsList], {
		cwd: process.cwd(),
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error((result.stderr || result.stdout || 'Wrangler command failed.').trim());
	}
	return result.stdout;
}

function loadLocations() {
	const output = runWrangler([
		'd1',
		'execute',
		'free-food-map-db',
		'--remote',
		'--json',
		'--command',
		`SELECT id, name, address, zip_code, service_type, hours, contact_phone,
			contact_email, contact_web, notes, latitude, longitude
		FROM locations WHERE status = 'active' ORDER BY id`,
	]);
	return JSON.parse(output)[0]?.results || [];
}

const WORD_ALIASES = new Map([
	['st', 'street'], ['ave', 'avenue'], ['av', 'avenue'], ['rd', 'road'], ['dr', 'drive'],
	['blvd', 'boulevard'], ['ln', 'lane'], ['hwy', 'highway'], ['rte', 'route'], ['pkwy', 'parkway'],
	['ctr', 'center'], ['ct', 'court'], ['pl', 'place'], ['mt', 'mount'], ['n', 'north'], ['s', 'south'],
	['e', 'east'], ['w', 'west'], ['ste', 'suite'],
]);
const NAME_STOP_WORDS = new Set(['the', 'of', 'and', 'inc', 'incorporated', 'food', 'pantry', 'bank', 'distribution', 'program', 'services', 'service', 'community']);
const STREET_NOISE = new Set(['suite', 'unit', 'building', 'floor', 'level', 'lower', 'upper', 'room']);

function normalizedWords(value) {
	return String(value || '')
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/&/g, ' and ')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => WORD_ALIASES.get(word) || word);
}

function normalized(value) {
	return normalizedWords(value).join(' ');
}

function digits(value) {
	const valueDigits = String(value || '').replace(/\D/g, '');
	return valueDigits.length >= 10 ? valueDigits.slice(0, 10).slice(-10) : valueDigits;
}

function zipFrom(value, fallback = '') {
	const matches = [...String(value || '').matchAll(/(?:^|\D)(\d{5})(?:-\d{4})?(?!\d)/g)];
	return matches.at(-1)?.[1] || String(fallback || '');
}

function streetParts(value) {
	const firstLine = String(value || '').split(',')[0];
	const words = normalizedWords(firstLine);
	const number = words.find((word) => /^\d+[a-z]?$/.test(word)) || '';
	const significant = [];
	for (const word of words) {
		if (word === number) continue;
		if (STREET_NOISE.has(word)) break;
		significant.push(word);
	}
	return { number, words: significant };
}

function overlap(first, second) {
	const a = new Set(first);
	const b = new Set(second);
	if (!a.size || !b.size) return 0;
	let common = 0;
	for (const value of a) if (b.has(value)) common += 1;
	return common / Math.min(a.size, b.size);
}

function addressesMatch(location, service) {
	if (String(location.zip_code) !== zipFrom(service.address)) return false;
	const local = streetParts(location.address);
	const source = streetParts(service.address);
	return Boolean(local.number && local.number === source.number && overlap(local.words, source.words) >= 0.7);
}

function namesMatch(first, second) {
	const allFirst = normalizedWords(first);
	const allSecond = normalizedWords(second);
	const importantFirst = allFirst.filter((word) => !NAME_STOP_WORDS.has(word));
	const importantSecond = allSecond.filter((word) => !NAME_STOP_WORDS.has(word));
	const score = overlap(importantFirst.length ? importantFirst : allFirst, importantSecond.length ? importantSecond : allSecond);
	return score >= 0.65;
}

function phonesMatch(first, second) {
	const a = digits(first);
	const b = digits(second);
	return Boolean(a.length === 10 && a === b);
}

function canonicalUrl(value) {
	if (!value) return '';
	try {
		const prepared = /^https?:\/\//i.test(value) ? value : `https://${value}`;
		const url = new URL(prepared);
		url.hash = '';
		url.search = '';
		return `${url.hostname.replace(/^www\./, '').toLowerCase()}${url.pathname.replace(/\/$/, '').toLowerCase()}`;
	} catch {
		return '';
	}
}

function urlsMatch(first, second) {
	const a = canonicalUrl(first);
	const b = canonicalUrl(second);
	return Boolean(a && b && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

function scheduleTokens(value) {
	const meaningful = /^(mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday|monthly|weekly|daily|closed|appointment|am|pm|\d{1,4})$/;
	return normalizedWords(value).filter((word) => meaningful.test(word));
}

function hoursMatch(first, second) {
	const a = scheduleTokens(first);
	const b = scheduleTokens(second);
	return a.length >= 4 && b.length >= 4 && overlap(a, b) >= 0.8;
}

function serviceMatches(location, service) {
	const source = normalized([
		service.serviceName,
		service.name,
		...(service.taxonomies || []).map((taxonomy) => taxonomy.name),
	].join(' '));
	const expectations = {
		'Food Pantry': ['food pantry'],
		'Food Bank': ['food bank', 'food distribution warehouse'],
		'Soup Kitchen': ['soup kitchen', 'congregate meal', 'free meal'],
		'Food Distribution': ['food distribution', 'mobile food', 'food line'],
		'Emergency Food': ['emergency food'],
	};
	return (expectations[location.service_type] || []).some((value) => source.includes(value));
}

function distanceMiles(location, service) {
	const coordinates = service.location?.coordinates;
	const latitude = Number(location.latitude);
	const longitude = Number(location.longitude);
	if (!Array.isArray(coordinates) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
	const sourceLongitude = Number(coordinates[0]);
	const sourceLatitude = Number(coordinates[1]);
	if (!Number.isFinite(sourceLatitude) || !Number.isFinite(sourceLongitude)) return null;
	const radians = (degrees) => (degrees * Math.PI) / 180;
	const latitudeDelta = radians(sourceLatitude - latitude);
	const longitudeDelta = radians(sourceLongitude - longitude);
	const value = Math.sin(latitudeDelta / 2) ** 2 +
		Math.cos(radians(latitude)) * Math.cos(radians(sourceLatitude)) * Math.sin(longitudeDelta / 2) ** 2;
	return 3958.8 * 2 * Math.asin(Math.sqrt(value));
}

function pa211Evidence(location, service) {
	const fields = [];
	const address = addressesMatch(location, service);
	const zip = String(location.zip_code) === zipFrom(service.address);
	const name = namesMatch(location.name, service.name);
	const phone = phonesMatch(location.contact_phone, service.phone);
	if (name) fields.push('name');
	if (address) fields.push('address');
	if (zip) fields.push('zip');
	if (serviceMatches(location, service)) fields.push('service');
	if (location.hours && service.hours && hoursMatch(location.hours, service.hours)) fields.push('hours');
	if (phone) fields.push('phone');
	if (location.contact_web && service.website && urlsMatch(location.contact_web, service.website)) fields.push('website');
	const distance = distanceMiles(location, service);
	if (distance != null && distance <= 0.25) fields.push('coordinates');
	return { fields, address, zip, name, phone, distance };
}

function candidateScore(location, service) {
	const evidence = pa211Evidence(location, service);
	let score = 0;
	if (evidence.address) score += 10;
	if (evidence.phone) score += 7;
	if (evidence.name) score += 4;
	if (evidence.zip) score += 2;
	if (location.contact_web && service.website && urlsMatch(location.contact_web, service.website)) score += 1;
	if (evidence.distance != null && evidence.distance <= 0.5) score += 2;
	return { service, evidence, score };
}

function findPa211Candidate(location, servicesByZip, servicesByPhone) {
	const possible = new Map();
	for (const service of servicesByZip.get(String(location.zip_code)) || []) possible.set(service.id, service);
	for (const service of servicesByPhone.get(digits(location.contact_phone)) || []) possible.set(service.id, service);
	const ranked = [...possible.values()]
		.map((service) => candidateScore(location, service))
		.filter((candidate) => candidate.score >= 9)
		.sort((first, second) => second.score - first.score);
	if (!ranked.length) return null;
	if (ranked[1] && ranked[0].score === ranked[1].score && !ranked[0].evidence.address) return null;
	return ranked[0];
}

function htmlToText(html) {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&(?:nbsp|#160);/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&quot;/gi, '"')
		.replace(/&#(?:39|x27);/gi, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

function websiteEvidence(location, page) {
	if (!page?.ok) return [];
	const fields = ['website'];
	const plainText = htmlToText(page.html);
	const pageWords = new Set(normalizedWords(plainText));
	const pageNormalized = [...pageWords].join(' ');
	const nameWords = normalizedWords(location.name).filter((word) => !NAME_STOP_WORDS.has(word));
	if (nameWords.length && nameWords.filter((word) => pageWords.has(word)).length / nameWords.length >= 0.75) fields.push('name');
	const street = streetParts(location.address);
	const hasStreet = street.number && pageWords.has(street.number) && street.words.filter((word) => pageWords.has(word)).length / Math.max(1, street.words.length) >= 0.8;
	if (hasStreet) fields.push('address');
	if (pageNormalized.includes(String(location.zip_code))) fields.push('zip');
	if (location.contact_phone && page.html.replace(/\D/g, '').includes(digits(location.contact_phone))) fields.push('phone');
	if (location.contact_email && page.html.toLowerCase().includes(String(location.contact_email).toLowerCase())) fields.push('email');
	return [...new Set(fields)];
}

async function loadWebsitePages(locations) {
	if (skipWebsites) return new Map();
	const urls = [...new Set(locations.map((location) => location.contact_web).filter(Boolean))];
	console.log(`Checking ${urls.length} listing websites...`);
	const values = await pooled(urls, 5, async (value, index) => {
		let url = String(value);
		if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
		try {
			const response = await fetchText(url, 12_000);
			if ((index + 1) % 15 === 0 || index + 1 === urls.length) console.log(`  Websites: ${index + 1}/${urls.length}`);
			return [value, { ok: true, html: response.text, finalUrl: response.finalUrl }];
		} catch (error) {
			if ((index + 1) % 15 === 0 || index + 1 === urls.length) console.log(`  Websites: ${index + 1}/${urls.length}`);
			return [value, { ok: false, error: error.message, finalUrl: url }];
		}
	});
	return new Map(values);
}

function classify(location, pa211Candidate, websitePage) {
	const paFields = pa211Candidate?.evidence.fields || [];
	const webFields = websiteEvidence(location, websitePage);
	const fields = [...new Set([...paFields, ...webFields])];
	const has = (field) => fields.includes(field);
	const coreConfirmed = has('name') && has('address') && has('zip') && (!location.contact_phone || has('phone'));
	const partialConfirmed = (has('address') && has('zip') && (has('name') || has('phone'))) || (has('name') && has('phone') && has('zip'));
	const status = coreConfirmed ? 'verified' : partialConfirmed ? 'partial' : 'needs_review';
	const sourceUrl = pa211Candidate
		? `https://search.pa211.org/search/${pa211Candidate.service.id}`
		: websitePage?.ok ? websitePage.finalUrl : null;
	let note;
	if (status === 'verified') {
		note = `Current source confirms the core listing details. Confirmed fields: ${fields.join(', ')}.`;
	} else if (status === 'partial') {
		note = `Current source confirms part of the listing. Confirmed fields: ${fields.join(', ')}; remaining fields need review.`;
	} else if (pa211Candidate) {
		const conflicts = [];
		if (!pa211Candidate.evidence.name) conflicts.push('name');
		if (!pa211Candidate.evidence.address) conflicts.push('address');
		if (!pa211Candidate.evidence.phone && location.contact_phone) conflicts.push('phone');
		note = `Possible PA 211 match found, but ${conflicts.join(', ') || 'the core details'} could not be confirmed.`;
	} else if (location.contact_web && websitePage && !websitePage.ok) {
		note = `No matching PA 211 record was found and the listed website could not be checked (${websitePage.error}).`;
	} else {
		note = 'No current source confirmed enough identifying details during this audit.';
	}
	return { status, fields, sourceUrl, note, pa211Candidate, websitePage };
}

function csvField(value) {
	return `"${String(value == null ? '' : value).replaceAll('"', '""')}"`;
}

function reportCsv(results) {
	const headings = [
		'id', 'name', 'status', 'audit_date', 'confirmed_fields', 'source_url', 'audit_note',
		'current_address', 'current_zip', 'current_phone', 'current_hours',
		'source_name', 'source_address', 'source_phone', 'source_hours',
	];
	const rows = results.map(({ location, result }) => {
		const source = result.pa211Candidate?.service || {};
		return [
			location.id, location.name, result.status, auditDate, result.fields.join(', '), result.sourceUrl,
			result.note, location.address, location.zip_code, location.contact_phone, location.hours,
			source.name, source.address, source.phone, source.hours,
		].map(csvField).join(',');
	});
	return [headings.join(','), ...rows].join('\n') + '\n';
}

function reportMarkdown(results, pa211Count, websiteCount) {
	const counts = results.reduce((values, item) => {
		values[item.result.status] = (values[item.result.status] || 0) + 1;
		return values;
	}, {});
	return `# Location Verification Audit\n\n` +
		`Audit date: ${auditDate}\n\n` +
		`- Active records reviewed: ${results.length}\n` +
		`- Verified: ${counts.verified || 0}\n` +
		`- Partially checked: ${counts.partial || 0}\n` +
		`- Needs review: ${counts.needs_review || 0}\n` +
		`- Current PA 211 records searched: ${pa211Count}\n` +
		`- Listing websites checked: ${websiteCount}\n\n` +
		`A record is verified only when a current source confirms its name, street address, ZIP code, and listed phone number when one is present. ` +
		`Partially checked records have at least two matching identifiers. The CSV report lists the exact fields confirmed and any conflicting source details.\n`;
}

function sqlValue(value) {
	return value == null || value === '' ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
}

function applyResults(results) {
	const timestamp = `${auditDate}T12:00:00.000Z`;
	for (let offset = 0; offset < results.length; offset += 30) {
		const sql = results.slice(offset, offset + 30).map(({ location, result }) => {
			const verifiedAt = result.status === 'verified' || result.status === 'partial' ? sqlValue(timestamp) : 'last_verified_at';
			return `UPDATE locations SET verification_status = ${sqlValue(result.status)}, ` +
				`verified_fields = ${sqlValue(result.fields.join(','))}, ` +
				`verification_source_url = ${sqlValue(result.sourceUrl)}, ` +
				`verification_notes = ${sqlValue(result.note)}, ` +
				`last_verified_at = ${verifiedAt}, last_reviewed_at = ${sqlValue(timestamp)}, ` +
				`updated_at = CURRENT_TIMESTAMP WHERE id = ${Number(location.id)};\n` +
				`INSERT INTO workflow_events (entity_type, entity_id, action, note) VALUES ` +
				`('location', ${Number(location.id)}, 'verification_audit', ${sqlValue(`${result.status}: ${result.note}`)});`;
		}).join('\n');
		runWrangler(['d1', 'execute', 'free-food-map-db', '--remote', '--json', '--command', sql]);
		console.log(`  Applied records ${offset + 1}-${Math.min(offset + 30, results.length)}.`);
	}
}

const locations = loadLocations();
console.log(`Auditing ${locations.length} active Free Food Map records for ${auditDate}.`);
const pa211Services = await loadPa211Services({ requestedPages });

const servicesByZip = new Map();
const servicesByPhone = new Map();
for (const service of pa211Services) {
	const zip = zipFrom(service.address);
	if (zip) servicesByZip.set(zip, [...(servicesByZip.get(zip) || []), service]);
	const phone = digits(service.phone);
	if (phone.length === 10) servicesByPhone.set(phone, [...(servicesByPhone.get(phone) || []), service]);
}

const websitePages = await loadWebsitePages(locations);
const results = locations.map((location) => {
	const pa211Candidate = findPa211Candidate(location, servicesByZip, servicesByPhone);
	const websitePage = websitePages.get(location.contact_web);
	return { location, result: classify(location, pa211Candidate, websitePage) };
});

await mkdir(reportsDirectory, { recursive: true });
const csvPath = resolve(reportsDirectory, `location-verification-${auditDate}.csv`);
const markdownPath = resolve(reportsDirectory, `location-verification-${auditDate}.md`);
await writeFile(csvPath, reportCsv(results), 'utf8');
await writeFile(markdownPath, reportMarkdown(results, pa211Services.length, websitePages.size), 'utf8');

const counts = results.reduce((values, item) => {
	values[item.result.status] = (values[item.result.status] || 0) + 1;
	return values;
}, {});
console.log('Verification audit complete');
console.log(`  Verified: ${counts.verified || 0}`);
console.log(`  Partially checked: ${counts.partial || 0}`);
console.log(`  Needs review: ${counts.needs_review || 0}`);
console.log(`  CSV report: ${csvPath}`);
console.log(`  Summary: ${markdownPath}`);

if (apply) {
	console.log('Applying reviewed results to the remote database...');
	applyResults(results);
	console.log(`Applied ${results.length} dated verification results.`);
} else {
	console.log('Dry run only. Review the CSV, then run verification:apply to publish these results.');
}

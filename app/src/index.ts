import { easternClock, haversineMiles, normalized, searchSnapshot } from '../public/snapshot-search.mjs';
import { normalizeRecord } from '../public/hours.mjs';
import puppeteer from '@cloudflare/puppeteer';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

export interface VerificationWorkflowParams {
	location_id: number;
	job_id: number;
}

export interface Env {
	DB: D1Database;
	ASSETS: Fetcher;
	ADMIN_TOKEN?: string;
	MAP_PUBLISH_GITHUB_TOKEN?: string;
	START_MAP_PUBLISH_7314_FNA106_11042026?: string;
	SUBMISSION_SALT?: string;
	TURNSTILE_SITE_KEY?: string;
	TURNSTILE_SECRET?: string;
	CF_ACCESS_TEAM_DOMAIN?: string;
	CF_ACCESS_AUD?: string;
	VERIFY_WORKFLOW?: Workflow<VerificationWorkflowParams>;
	BROWSER?: Fetcher;
	AI?: Ai;
}

type JsonRecord = Record<string, unknown>;
class RequestError extends Error {
	constructor(message: string, readonly status = 400) { super(message); }
}

export const SERVICE_TYPES = [
	'Food Bank',
	'Food Pantry',
	'Soup Kitchen',
	'Support Services',
	'Emergency Food',
	'Food Distribution',
	'Other',
] as const;

const JSON_HEADERS = {
	'content-type': 'application/json; charset=utf-8',
	'x-content-type-options': 'nosniff',
};

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
	const headers = new Headers(JSON_HEADERS);
	headers.set('cache-control', 'no-store');
	if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
	return new Response(JSON.stringify(data), { status, headers });
}

async function cachedPublicResponse(
	request: Request,
	ctx: ExecutionContext,
	ttlSeconds: number,
	loader: () => Promise<Response>,
): Promise<Response> {
	const cache = caches.default;
	const cacheKey = new Request(request.url, { method: 'GET', headers: { accept: request.headers.get('accept') || '*/*' } });
	const cached = await cache.match(cacheKey);
	if (cached) {
		const etag = cached.headers.get('etag');
		if (etag && request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: cached.headers });
		return cached;
	}

	const response = await loader();
	if (!response.ok) return response;
	const body = await response.clone().arrayBuffer();
	const digest = await crypto.subtle.digest('SHA-256', body);
	const etag = '"' + Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, '0')).join('') + '"';
	const headers = new Headers(response.headers);
	headers.set('cache-control', `public, max-age=${ttlSeconds}, stale-while-revalidate=${ttlSeconds * 6}`);
	headers.set('etag', etag);
	const cacheable = new Response(body, { status: response.status, headers });
	ctx.waitUntil(cache.put(cacheKey, cacheable.clone()));
	if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
	return cacheable;
}

function clean(value: unknown, max = 500): string {
	return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function optional(value: unknown, max = 500): string | null {
	const result = clean(value, max);
	return result || null;
}

export function isValidZip(value: string): boolean {
	return /^\d{5}$/.test(value);
}

export function matchedAddressHasZip(matchedAddress: string, expectedZip: string): boolean {
	const matchedZip = matchedAddress.match(/,\s*(\d{5})(?:-\d{4})?\s*$/)?.[1] || '';
	return isValidZip(expectedZip) && matchedZip === expectedZip;
}

export function isValidEmail(value: string): boolean {
	return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function isValidUrl(value: string): boolean {
	if (!value) return true;
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

function ftsQuery(value: string): string {
	return normalized(value)
		.split(/\s+/)
		.filter((term) => term.length > 1)
		.slice(0, 8)
		.map((term) => `"${term}"*`)
		.join(' AND ');
}

function finiteNumber(value: string | null, minimum: number, maximum: number): number | null {
	if (value == null || value.trim() === '') return null;
	const number = Number(value);
	return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function slugify(value: string): string {
	return normalized(value).replace(/\s+/g, '-').slice(0, 80) || 'food-resource';
}

function escapeHtml(value: unknown): string {
	return String(value == null ? '' : value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

function escapeXml(value: unknown): string {
	return escapeHtml(value);
}

function coordinate(value: unknown, fallback: unknown, minimum: number, maximum: number): number | null {
	const candidate = value === undefined ? fallback : value;
	if (candidate === '' || candidate == null) return null;
	const number = Number(candidate);
	return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

async function readBody(request: Request): Promise<JsonRecord> {
	const size = Number(request.headers.get('content-length') || '0');
	if (size > 64_000) throw new RequestError('Request is too large.', 413);
	const reader = request.body?.getReader();
	let bytes = 0;
	const chunks: Uint8Array[] = [];
	if (reader) for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (bytes > 64_000) { await reader.cancel(); throw new RequestError('Request is too large.', 413); }
		chunks.push(value);
	}
	const buffer = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
	let value: unknown;
	try { value = JSON.parse(new TextDecoder().decode(buffer)); }
	catch { throw new RequestError('Enter a valid JSON object.'); }
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new RequestError('Invalid request body.');
	}
	return value as JsonRecord;
}

function suggestionFields(body: JsonRecord) {
	return {
		name: clean(body.name, 140),
		address: clean(body.address, 240),
		zip_code: clean(body.zip_code, 120),
		service_type: clean(body.service_type, 60),
		organization_name: optional(body.organization_name, 140),
		hours: optional(body.hours, 500),
		contact_phone: optional(body.contact_phone, 40),
		contact_email: optional(body.contact_email, 160),
		contact_web: optional(body.contact_web, 500),
		notes: optional(body.notes, 1200),
		source_url: optional(body.source_url, 500),
		eligibility: optional(body.eligibility, 700),
		accessibility: optional(body.accessibility, 500),
		languages: optional(body.languages, 300),
		appointment_required: body.appointment_required === true || body.appointment_required === 1 ? 1 : 0,
		submitter_email: optional(body.submitter_email, 160),
		verified_recently: body.verified_recently === true || body.verified_recently === 1 ? 1 : 0,
	};
}

function nextVerificationDue(from = new Date()): string {
	return new Date(from.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();
}

function validateSuggestion(fields: ReturnType<typeof suggestionFields>): string | null {
	if (!fields.name || !fields.address || !fields.zip_code || !fields.service_type) {
		return 'Name, address, ZIP code, and service type are required.';
	}
	if (!isValidZip(fields.zip_code)) return 'Enter a valid five-digit ZIP code.';
	if (!SERVICE_TYPES.includes(fields.service_type as (typeof SERVICE_TYPES)[number])) {
		return 'Choose a valid service type.';
	}
	if (!isValidEmail(fields.contact_email || '') || !isValidEmail(fields.submitter_email || '')) {
		return 'Enter a valid email address.';
	}
	if (!isValidUrl(fields.contact_web || '') || !isValidUrl(fields.source_url || '')) {
		return 'Website and source links must begin with http:// or https://.';
	}
	return null;
}

async function sha256(value: string): Promise<string> {
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function clientHash(request: Request, env: Env): Promise<string> {
	const ip = request.headers.get('cf-connecting-ip') || 'local';
	return sha256(ip + ':' + (env.SUBMISSION_SALT || 'local-development'));
}

async function tooManySubmissions(env: Env, hash: string): Promise<boolean> {
	const result = await env.DB.prepare(
		`SELECT
			(SELECT COUNT(*) FROM suggestions WHERE client_hash = ? AND submitted_at >= datetime('now', '-10 minutes')) +
			(SELECT COUNT(*) FROM reports WHERE client_hash = ? AND submitted_at >= datetime('now', '-10 minutes')) +
			(SELECT COUNT(*) FROM location_confirmations WHERE client_hash = ? AND submitted_at >= datetime('now', '-10 minutes')) AS total`,
	)
		.bind(hash, hash, hash)
		.first<{ total: number }>();
	return Number(result?.total || 0) >= 5;
}

async function validateTurnstile(request: Request, env: Env, token: unknown): Promise<boolean> {
	if (!env.TURNSTILE_SECRET) return true;
	const responseToken = clean(token, 2048);
	if (!responseToken) return false;
	try {
		const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				secret: env.TURNSTILE_SECRET,
				response: responseToken,
				remoteip: request.headers.get('cf-connecting-ip') || undefined,
				idempotency_key: crypto.randomUUID(),
			}),
		});
		const result = (await response.json()) as { success?: boolean };
		return result.success === true;
	} catch (error) {
		console.error('Turnstile validation failed', error);
		return false;
	}
}

async function resolveZipCenter(zip: string): Promise<{ latitude: number; longitude: number } | null> {
	const request = new Request(`https://api.zippopotam.us/us/${zip}`);
	try {
		const cached = await caches.default.match(request);
		const response = cached || await fetch(request, { signal: AbortSignal.timeout(5000) });
		if (!response.ok) return null;
		const data = await response.clone().json() as { places?: Array<{ latitude?: string; longitude?: string }> };
		const place = data.places?.[0];
		const latitude = finiteNumber(place?.latitude ?? null, -90, 90);
		const longitude = finiteNumber(place?.longitude ?? null, -180, 180);
		if (latitude == null || longitude == null) return null;
		if (!cached) await caches.default.put(request, new Response(JSON.stringify(data), {
			headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=2592000' },
		}));
		return { latitude, longitude };
	} catch {
		return null;
	}
}

let databaseSearchRetryAt = 0;

export async function listLocations(request: Request, env: Env): Promise<Response> {
	try {
		if (Date.now() < databaseSearchRetryAt) return await snapshotLocations(request,env);
		return await queryLiveLocations(request,env);
	} catch (error) {
		console.error('Live location search unavailable',error);
		if (/daily.*limit|exceeded.*D1|D1.*exceeded/i.test(String(error))) databaseSearchRetryAt = Date.now()+60000;
		return snapshotLocations(request,env);
	}
}

export async function snapshotLocations(request: Request, env: Env): Promise<Response> {
	const p=new URL(request.url).searchParams;
	const zip=clean(p.get('zip'),120);
	const service=clean(p.get('service'),60);
	const radius=finiteNumber(p.get('radius'),1,100) ?? 5;
	if (zip && !isValidZip(zip)) return json({error:'Enter a valid five-digit ZIP code.'},400);
	if (p.has('radius') && finiteNumber(p.get('radius'),1,100)==null) return json({error:'Choose a distance between 1 and 100 miles.'},400);
	if(service && !SERVICE_TYPES.includes(service as (typeof SERVICE_TYPES)[number])) return json({error:'Choose a valid service type.'},400);
	const requestedNearby=p.has('lat') || p.has('lon');
	let lat=finiteNumber(p.get('lat'),-90,90), lon=finiteNumber(p.get('lon'),-180,180);
	if(requestedNearby && (lat==null || lon==null)) return json({error:'Valid latitude and longitude are required for nearby search.'},400);
	if(!zip && !requestedNearby && p.get('all')!=='true') return json({error:'Enter a ZIP code, use your location, or choose Show all locations.'},400);
	if(zip && !requestedNearby) { const center=await resolveZipCenter(zip); if(center) {lat=center.latitude;lon=center.longitude;} }
	const response=await env.ASSETS.fetch(new Request(new URL('/location-snapshot.json',request.url)));
	if(!response.ok) return json({error:'Location search is temporarily unavailable. Please try again shortly.'},503);
	const data=await response.json<{locations:Array<Record<string,unknown>>;snapshot_at:string}>();
	const result = searchSnapshot(data, p, lat, lon, radius);
	return json({...result, service_types: SERVICE_TYPES, meta: {...result.meta, using_saved_data: true}});
}

async function queryLiveLocations(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const zip = clean(url.searchParams.get('zip'), 120);
	const service = clean(url.searchParams.get('service'), 60);
	const query = clean(url.searchParams.get('q'), 120);
	const hasHours = url.searchParams.get('has_hours') === 'true';
	const openNow = url.searchParams.get('open_now') === 'true';
	const showAll = url.searchParams.get('all') === 'true';
	let latitude = finiteNumber(url.searchParams.get('lat'), -90, 90);
	let longitude = finiteNumber(url.searchParams.get('lon'), -180, 180);
	const requestedNearby = url.searchParams.has('lat') || url.searchParams.has('lon');
	if (zip && !isValidZip(zip)) return json({ error: 'Enter a valid five-digit ZIP code.' }, 400);
	if (requestedNearby && (latitude == null || longitude == null)) return json({ error: 'Valid latitude and longitude are required for nearby search.' }, 400);
	const requestedRadius = finiteNumber(url.searchParams.get('radius'), 1, 100);
	if (url.searchParams.has('radius') && requestedRadius == null) return json({ error: 'Choose a distance between 1 and 100 miles.' }, 400);
	const radius = requestedRadius ?? 5;
	let zipCenterUnavailable = false;
	if (zip && !requestedNearby) {
		const center = await resolveZipCenter(zip);
		if (center) ({ latitude, longitude } = center);
		else zipCenterUnavailable = true;
	}
	const nearby = latitude != null && longitude != null;
	const conditions = ["l.status = 'active'"];
	const bindings: unknown[] = [];

	if (zip && !nearby) {
		conditions.push('l.zip_code = ?');
		bindings.push(zip);
	}
	if (requestedNearby && !nearby) return json({ error: 'Valid latitude and longitude are required for nearby search.' }, 400);
	if (!zip && !nearby && !showAll) {
		return json({ error: 'Enter a ZIP code, use your location, or choose Show all locations.' }, 400);
	}
	if (service) {
		if (!SERVICE_TYPES.includes(service as (typeof SERVICE_TYPES)[number])) return json({ error: 'Choose a valid service type.' }, 400);
		conditions.push('l.service_type = ?');
		bindings.push(service);
	}
	if (query) {
		const match = ftsQuery(query);
		if (match) {
			conditions.push('l.id IN (SELECT rowid FROM location_search WHERE location_search MATCH ?)');
			bindings.push(match);
		}
	}
	if (hasHours) conditions.push("l.hours IS NOT NULL AND trim(l.hours) != ''");

	if (nearby && latitude != null && longitude != null) {
		// A conservative bounding box; the exact great-circle distance is checked below.
		const latitudeDelta = radius / 68;
		const longitudeDelta = Math.abs(latitude) + latitudeDelta >= 90 ? 180 : radius / (68 * Math.cos(((Math.abs(latitude) + latitudeDelta) * Math.PI) / 180));
		conditions.push(`((l.latitude BETWEEN ? AND ? AND l.longitude BETWEEN ? AND ?)${zip ? ' OR (l.zip_code = ? AND (l.latitude IS NULL OR l.longitude IS NULL))' : ''})`);
		bindings.push(latitude - latitudeDelta, latitude + latitudeDelta, longitude - longitudeDelta, longitude + longitudeDelta);
		if (zip) bindings.push(zip);
	}

	const clock = easternClock();
	const openExpression = `EXISTS (
		SELECT 1 FROM location_operating_hours oh
		WHERE oh.location_id = l.id
			AND (oh.valid_from IS NULL OR date(oh.valid_from) <= date('now'))
			AND (oh.valid_through IS NULL OR date(oh.valid_through) >= date('now'))
			AND (
				(oh.day_of_week = ${clock.day} AND (
					(oh.opens_at <= oh.closes_at AND oh.opens_at <= '${clock.time}' AND oh.closes_at > '${clock.time}') OR
					(oh.opens_at > oh.closes_at AND oh.opens_at <= '${clock.time}')
				)) OR
				(oh.day_of_week = ${clock.previousDay} AND oh.opens_at > oh.closes_at AND oh.closes_at > '${clock.time}')
			)
	)`;
	if (openNow) conditions.push(openExpression);

	const sql = `SELECT l.id, l.name, l.address, l.zip_code, l.service_type, l.organization_name, l.hours,
		l.contact_phone, l.contact_email, l.contact_web, l.notes, l.latitude, l.longitude,
		l.eligibility, l.accessibility, l.languages, l.appointment_required, l.schedule_timezone,
		l.verification_status, l.verified_fields,
		l.last_verified_at, l.last_reviewed_at, l.verification_due_at, l.updated_at,
		${openExpression} AS is_open_now,
		EXISTS (SELECT 1 FROM location_operating_hours oh WHERE oh.location_id = l.id) AS has_structured_hours,
		(SELECT signal FROM location_confirmations c
			WHERE c.location_id = l.id AND c.submitted_at >= datetime('now', '-24 hours')
			ORDER BY c.submitted_at DESC LIMIT 1) AS recent_confirmation_signal,
		(SELECT submitted_at FROM location_confirmations c
			WHERE c.location_id = l.id AND c.submitted_at >= datetime('now', '-24 hours')
			ORDER BY c.submitted_at DESC LIMIT 1) AS recent_confirmation_at
		FROM locations l WHERE ${conditions.join(' AND ')}
		ORDER BY CASE WHEN l.latitude IS NULL THEN 1 ELSE 0 END, l.name COLLATE NOCASE`;
	const result = await env.DB.prepare(sql).bind(...bindings).all();
	let locations = result.results as Array<Record<string, unknown>>;
	if (nearby && latitude != null && longitude != null) {
		locations = locations
			.map((location) => {
				if (location.latitude == null || location.longitude == null) return { ...location, distance_miles: null };
				const distance = haversineMiles(latitude, longitude, Number(location.latitude), Number(location.longitude));
				return { ...location, distance_miles: distance };
			})
			.filter((location) => location.distance_miles == null || Number(location.distance_miles) <= radius)
			.sort((a, b) => (a.distance_miles ?? Infinity) - (b.distance_miles ?? Infinity));
		const limit = Math.min(250, Math.max(1, Number(url.searchParams.get('limit')) || 100));
		locations = locations.slice(0, limit).map((location) => ({ ...location, distance_miles: location.distance_miles == null ? null : Math.round(Number(location.distance_miles) * 10) / 10 }));
	}
	return json({
		locations,
		service_types: SERVICE_TYPES,
		meta: {
			mode: nearby ? 'nearby' : zip ? 'zip' : 'all',
			count: locations.length,
			radius_miles: nearby ? radius : null,
			unmapped_count: locations.filter(l=>l.latitude == null || l.longitude == null).length,
			origin_zip: zip || null,
			approximate_origin: Boolean(zip && nearby && !requestedNearby),
			zip_center_unavailable: zipCenterUnavailable,
		},
	});
}

async function publicStats(env: Env): Promise<Response> {
	const counts = await env.DB.prepare(
		`SELECT COUNT(*) AS active_locations,
			SUM(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 ELSE 0 END) AS mapped_locations,
			SUM(CASE WHEN verification_status = 'verified' THEN 1 ELSE 0 END) AS verified_locations,
			MAX(updated_at) AS last_updated
		FROM locations WHERE status = 'active'`,
	).first();
	return json({ counts });
}

type PublicLocation = Record<string, unknown> & {
	id: number;
	name: string;
	address: string;
	zip_code: string;
	service_type: string;
};

async function getPublicLocation(env: Env, id: number): Promise<PublicLocation | null> {
	try {
	return await env.DB.prepare(
		`SELECT l.*,
			(SELECT signal FROM location_confirmations c
			 WHERE c.location_id = l.id AND c.submitted_at >= datetime('now', '-24 hours')
			 ORDER BY c.submitted_at DESC LIMIT 1) AS recent_confirmation_signal,
			(SELECT submitted_at FROM location_confirmations c
			 WHERE c.location_id = l.id AND c.submitted_at >= datetime('now', '-24 hours')
			 ORDER BY c.submitted_at DESC LIMIT 1) AS recent_confirmation_at
		FROM locations l WHERE l.id = ? AND l.status = 'active'`,
	)
		.bind(id)
		.first<PublicLocation>();
	} catch (error) {
		console.error('Live detail unavailable',error);
		const response=await env.ASSETS.fetch(new Request('https://freefoodmap.org/location-snapshot.json'));
		if(!response.ok) throw error;
		const data=await response.json<{locations:PublicLocation[]}>();
		return data.locations.find(l=>l.id===id)||null;
	}
}

function publicLocationUrl(location: PublicLocation): string {
	return `https://freefoodmap.org/locations/${location.id}/${slugify(location.name)}`;
}

function htmlResponse(markup: string, status = 200, extraHeaders?: HeadersInit): Response {
	const headers = new Headers({
		'content-type': 'text/html; charset=utf-8',
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'strict-origin-when-cross-origin',
		'content-security-policy': "default-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
	});
	if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
	return new Response(markup, { status, headers });
}

async function renderLocationPage(env: Env, id: number, requestedSlug: string): Promise<Response> {
	const location = await getPublicLocation(env, id);
	if (!location) return htmlResponse('<!doctype html><html lang="en"><title>Location not found</title><body><h1>Location not found</h1><p><a href="/">Return to Free Food Map</a></p></body></html>', 404);
	const canonical = publicLocationUrl(location);
	const slug = slugify(location.name);
	if (requestedSlug !== slug) return Response.redirect(canonical, 308);
	const phoneHref = String(location.contact_phone || '').replace(/[^\d+]/g, '');
	const website = isValidUrl(String(location.contact_web || '')) ? String(location.contact_web || '') : '';
	const directions = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${location.address} ${location.zip_code}`)}`;
	const verifiedDate = location.last_verified_at || location.last_reviewed_at;
	const description = `${location.service_type} at ${location.address} ${location.zip_code}. ${String(location.hours || 'Call for current hours.')}`;
	const schema = {
		'@context': 'https://schema.org',
		'@type': 'Organization',
		name: location.name,
		description,
		url: canonical,
		telephone: location.contact_phone || undefined,
		email: location.contact_email || undefined,
		address: {
			'@type': 'PostalAddress',
			streetAddress: location.address,
			addressRegion: 'PA',
			postalCode: location.zip_code,
			addressCountry: 'US',
		},
		geo: location.latitude != null && location.longitude != null ? {
			'@type': 'GeoCoordinates', latitude: location.latitude, longitude: location.longitude,
		} : undefined,
	};
	const detail = (label: string, value: unknown) => value ? `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>` : '';
	const actions = [
		phoneHref ? `<a class="button button-primary" href="tel:${escapeHtml(phoneHref)}">Call</a>` : '',
		website ? `<a class="button button-secondary" href="${escapeHtml(website)}" rel="noopener">Website</a>` : '',
		`<a class="button button-secondary" href="${escapeHtml(directions)}" rel="noopener">Directions</a>`,
	].join('');
	const markup = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#001e44"><meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${escapeHtml(location.name)} | Free Food Map"><meta property="og:description" content="${escapeHtml(description)}">
<link rel="canonical" href="${canonical}"><link rel="icon" href="/icon-192.png"><link rel="stylesheet" href="/app.css?v=12">
<title>${escapeHtml(location.name)} | Free Food Map</title><script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script></head>
<body class="location-page"><header class="app-header"><a class="brand" href="/"><span class="brand-mark">FF</span><span><strong>Free Food Map</strong><small>Community initiative</small></span></a><a class="button button-primary" href="/?zip=${escapeHtml(location.zip_code)}#map">Search the map</a></header>
<main class="location-detail"><p class="eyebrow">${escapeHtml(location.service_type)}</p><h1>${escapeHtml(location.name)}</h1>
${location.organization_name ? `<p class="location-organization">${escapeHtml(location.organization_name)}</p>` : ''}
<address>${escapeHtml(location.address)} ${escapeHtml(location.zip_code)}</address><div class="location-actions">${actions}</div>
<dl class="location-facts">${detail('Appointment', location.appointment_required ? 'Required â€” contact this location before visiting.' : '')}${detail('Hours', location.hours)}${detail('Eligibility', location.eligibility)}${detail('Accessibility', location.accessibility)}${detail('Languages', location.languages)}${detail('Phone', location.contact_phone)}${detail('Email', location.contact_email)}${detail('Notes', location.notes)}${detail('Last reviewed', verifiedDate ? String(verifiedDate).slice(0, 10) : 'Not yet verified')}</dl>
<p class="location-caution">Hours and availability can change. Call before visiting.</p>
<a href="/?zip=${escapeHtml(location.zip_code)}#map">See other resources in ${escapeHtml(location.zip_code)}</a></main></body></html>`;
	return htmlResponse(markup, 200, { 'cache-control': 'public, max-age=3600, stale-while-revalidate=86400' });
}

async function renderSitemap(env: Env): Promise<Response> {
	const rows = await env.DB.prepare("SELECT id, name, updated_at FROM locations WHERE status = 'active' ORDER BY id").all<PublicLocation>();
	const urls = rows.results.map((location) => `<url><loc>${escapeXml(publicLocationUrl(location))}</loc><lastmod>${escapeXml(String(location.updated_at || '').slice(0, 10))}</lastmod></url>`).join('');
	return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://freefoodmap.org/</loc></url>${urls}</urlset>`, {
		headers: { 'content-type': 'application/xml; charset=utf-8' },
	});
}

function hsdsId(kind: number, id: number): string {
	return `00000000-0000-4000-8${kind.toString(16).padStart(3, '0')}-${String(id).padStart(12, '0')}`;
}

async function exportHsds(env: Env): Promise<Response> {
	const rows = await env.DB.prepare("SELECT * FROM locations WHERE status = 'active' ORDER BY id").all<PublicLocation>();
	const organizations = new Map<string, { id: string; name: string; description: string }>();
	const locations: JsonRecord[] = [];
	const services: JsonRecord[] = [];
	const serviceAtLocations: JsonRecord[] = [];
	for (const row of rows.results) {
		const organizationName = String(row.organization_name || row.name);
		const organizationKey = normalized(organizationName);
		const organizationId = hsdsId(1, Number(row.id));
		if (!organizations.has(organizationKey)) organizations.set(organizationKey, { id: organizationId, name: organizationName, description: 'Community food resource' });
		const locationId = hsdsId(2, Number(row.id));
		const serviceId = hsdsId(3, Number(row.id));
		locations.push({ id: locationId, organization_id: organizations.get(organizationKey)?.id, name: row.name, address_1: row.address, state_province: 'PA', postal_code: row.zip_code, latitude: row.latitude, longitude: row.longitude });
		services.push({ id: serviceId, organization_id: organizations.get(organizationKey)?.id, name: row.name, description: row.notes, url: row.contact_web, email: row.contact_email, status: 'active', interpretation_services: row.languages, eligibility_description: row.eligibility, fees_description: 'Free' });
		serviceAtLocations.push({ id: hsdsId(4, Number(row.id)), service_id: serviceId, location_id: locationId, description: row.hours, appointment_required: Boolean(row.appointment_required) });
	}
	return json({ metadata: { profile: 'Open Referral HSDS-inspired public export', generated_at: new Date().toISOString(), source: 'https://freefoodmap.org' }, organizations: [...organizations.values()], locations, services, service_at_locations: serviceAtLocations });
}

async function submitSuggestion(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const body = await readBody(request);
	if (clean(body.company, 100)) return json({ ok: true }, 202);
	if (!(await validateTurnstile(request, env, body.turnstile_token || body['cf-turnstile-response']))) {
		return json({ error: 'Please complete the human verification and try again.' }, 400);
	}
	const fields = suggestionFields(body);
	const validationError = validateSuggestion(fields);
	if (validationError) return json({ error: validationError }, 400);

	const hash = await clientHash(request, env);
	if (await tooManySubmissions(env, hash)) {
		return json({ error: 'Too many recent submissions. Please try again in a few minutes.' }, 429);
	}

	const duplicate = await env.DB.prepare(
		`SELECT id, name, address FROM locations
		WHERE status = 'active' AND (normalized_address = ? OR (normalized_name = ? AND zip_code = ?))
		LIMIT 1`,
	)
		.bind(normalized(fields.address), normalized(fields.name), fields.zip_code)
		.first<{ id: number; name: string; address: string }>();

	const insert = await env.DB.prepare(
		`INSERT INTO suggestions (
			name, normalized_name, address, normalized_address, zip_code, service_type,
			organization_name, hours, contact_phone, contact_email, contact_web, notes,
			source_url, eligibility, accessibility, languages, appointment_required,
			submitter_email, verified_recently, duplicate_of_location_id,
			client_hash, status
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
	)
		.bind(
			fields.name,
			normalized(fields.name),
			fields.address,
			normalized(fields.address),
			fields.zip_code,
			fields.service_type,
			fields.organization_name,
			fields.hours,
			fields.contact_phone,
			fields.contact_email,
			fields.contact_web,
			fields.notes,
			fields.source_url,
			fields.eligibility,
			fields.accessibility,
			fields.languages,
			fields.appointment_required,
			fields.submitter_email,
			fields.verified_recently,
			duplicate?.id || null,
			hash,
		)
		.run();

	const id = Number(insert.meta.last_row_id);
	if (!insert.meta.changes) return json({ error: 'This location is already listed or has already been submitted for review.' }, 409);
	ctx.waitUntil(geocodeSuggestion(env, id));
	return json(
		{
			ok: true,
			id,
			possible_duplicate: duplicate || null,
			message: duplicate
				? 'Suggestion received and flagged for duplicate review.'
				: 'Suggestion received. It is now in the review queue.',
		},
		201,
	);
}

async function submitReport(request: Request, env: Env): Promise<Response> {
	const body = await readBody(request);
	if (clean(body.company, 100)) return json({ ok: true }, 202);
	if (!(await validateTurnstile(request, env, body.turnstile_token || body['cf-turnstile-response']))) {
		return json({ error: 'Please complete the human verification and try again.' }, 400);
	}
	const locationId = Number(body.location_id);
	const category = clean(body.category, 60);
	const description = clean(body.description, 1200);
	const contactEmail = optional(body.contact_email, 160);
	if (!Number.isInteger(locationId) || locationId < 1 || !category || !description) {
		return json({ error: 'Location, issue type, and description are required.' }, 400);
	}
	if (!isValidEmail(contactEmail || '')) return json({ error: 'Enter a valid email address.' }, 400);

	const location = await env.DB.prepare("SELECT id FROM locations WHERE id = ? AND status = 'active'")
		.bind(locationId)
		.first();
	if (!location) return json({ error: 'Location not found.' }, 404);

	const hash = await clientHash(request, env);
	if (await tooManySubmissions(env, hash)) {
		return json({ error: 'Too many recent submissions. Please try again in a few minutes.' }, 429);
	}

	const result = await env.DB.prepare(
		`INSERT INTO reports (location_id, category, description, contact_email, client_hash, status)
		VALUES (?, ?, ?, ?, ?, 'open')`,
	)
		.bind(locationId, category, description, contactEmail, hash)
		.run();
	return json({ ok: true, id: result.meta.last_row_id, message: 'Report received. Thank you for helping keep the map accurate.' }, 201);
}

const CONFIRMATION_SIGNALS = ['open', 'hours_correct', 'food_available', 'temporary_closed', 'long_wait'] as const;

async function submitConfirmation(request: Request, env: Env, locationId: number): Promise<Response> {
	const body = await readBody(request);
	if (clean(body.company, 100)) return json({ ok: true }, 202);
	if (!(await validateTurnstile(request, env, body.turnstile_token || body['cf-turnstile-response']))) {
		return json({ error: 'Please complete the human verification and try again.' }, 400);
	}
	const signal = clean(body.signal, 40);
	const note = optional(body.note, 280);
	if (!CONFIRMATION_SIGNALS.includes(signal as (typeof CONFIRMATION_SIGNALS)[number])) {
		return json({ error: 'Choose a valid visit update.' }, 400);
	}
	const location = await env.DB.prepare("SELECT id FROM locations WHERE id = ? AND status = 'active'").bind(locationId).first();
	if (!location) return json({ error: 'Location not found.' }, 404);

	const hash = await clientHash(request, env);
	if (await tooManySubmissions(env, hash)) {
		return json({ error: 'Too many recent submissions. Please try again in a few minutes.' }, 429);
	}
	const duplicate = await env.DB.prepare(
		`SELECT id FROM location_confirmations
		WHERE location_id = ? AND client_hash = ? AND signal = ? AND submitted_at >= datetime('now', '-1 hour')
		LIMIT 1`,
	)
		.bind(locationId, hash, signal)
		.first();
	if (duplicate) return json({ ok: true, message: 'Your recent update is already recorded.' });

	const results = await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO location_confirmations (location_id, signal, note, client_hash)
			VALUES (?, ?, ?, ?)`,
		).bind(locationId, signal, note, hash),
		env.DB.prepare(
			`INSERT INTO workflow_events (entity_type, entity_id, action, note)
			VALUES ('location', ?, 'community_confirmation', ?)`,
		).bind(locationId, signal + (note ? ': ' + note : '')),
	]);
	return json({
		ok: true,
		id: results[0].meta.last_row_id,
		message: 'Thank you. Your visit update will remain visible for 24 hours.',
	}, 201);
}

async function secureEqual(a: string, b: string): Promise<boolean> {
	const [aHash, bHash] = await Promise.all([sha256(a), sha256(b)]);
	return aHash === bHash;
}

const accessKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function hasValidAccessIdentity(request: Request, env: Env): Promise<boolean> {
	if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) return false;
	const token = request.headers.get('cf-access-jwt-assertion') || '';
	if (!token) return false;
	const teamHost = env.CF_ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
	try {
		let keySet = accessKeySets.get(teamHost);
		if (!keySet) {
			keySet = createRemoteJWKSet(new URL(`https://${teamHost}/cdn-cgi/access/certs`));
			accessKeySets.set(teamHost, keySet);
		}
		await jwtVerify(token, keySet, {
			issuer: `https://${teamHost}`,
			audience: env.CF_ACCESS_AUD,
		});
		return true;
	} catch (error) {
		console.error('Cloudflare Access token rejected', error);
		return false;
	}
}

async function isAdmin(request: Request, env: Env): Promise<boolean> {
	if (await hasValidAccessIdentity(request, env)) return true;
	const expected = env.ADMIN_TOKEN || '';
	if (!expected) return false;
	const header = request.headers.get('authorization') || '';
	const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
	return supplied.length > 0 && secureEqual(supplied, expected);
}

async function adminOverview(env: Env): Promise<Response> {
	const counts = await env.DB.prepare(
		`SELECT
			(SELECT COUNT(*) FROM locations WHERE status = 'active') AS active_locations,
			(SELECT COUNT(*) FROM locations WHERE status = 'active' AND latitude IS NULL) AS awaiting_coordinates,
			(SELECT COUNT(*) FROM locations WHERE status = 'active' AND verification_status = 'verified') AS verified_locations,
			(SELECT COUNT(*) FROM locations WHERE status = 'active' AND verification_status = 'partial') AS partially_verified_locations,
			(SELECT COUNT(*) FROM locations WHERE status = 'active' AND verification_status = 'needs_review') AS locations_needing_review,
			(SELECT COUNT(*) FROM suggestions WHERE status = 'pending') AS pending_suggestions,
			(SELECT COUNT(*) FROM reports WHERE status = 'open') AS open_reports,
			(SELECT COUNT(*) FROM location_confirmations WHERE submitted_at >= datetime('now', '-24 hours')) AS recent_confirmations,
			(SELECT COUNT(DISTINCT location_id) FROM location_operating_hours) AS locations_with_structured_hours,
			(SELECT COUNT(*) FROM verification_jobs WHERE status IN ('queued', 'running')) AS active_verification_jobs,
			(SELECT COUNT(*) FROM verification_jobs j JOIN locations l ON l.id=j.location_id WHERE l.status='active' AND j.status IN ('proposed','needs_review','failed') AND j.id=(SELECT MAX(v.id) FROM verification_jobs v WHERE v.location_id=j.location_id)) AS verification_jobs_needing_review`,
	).first();
	return json({ counts });
}

async function verificationQueue(request: Request, env: Env): Promise<Response> {
	const params = new URL(request.url).searchParams;
	const category = params.get('category') || 'attention';
	const categories = ['attention','identity','hours','contact','other','failed','running','confirmed','mapping'];
	if (!categories.includes(category)) return json({ error: 'Unknown verification category.' }, 400);
	const page = Math.max(1, Math.floor(Number(params.get('page')) || 1));
	const cte = `WITH latest AS (SELECT j.*, l.name AS location_name,l.address AS location_address,
	 CASE WHEN j.status='failed' THEN 'failed' WHEN j.status IN ('queued','running') THEN 'running'
	 WHEN j.status='confirmed' THEN 'confirmed'
	 WHEN EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(j.evidence_json) THEN j.evidence_json ELSE '{}' END,'$.checks') c WHERE json_extract(c.value,'$.field') IN ('name','address','zip') AND json_extract(c.value,'$.confirmed')=0) THEN 'identity'
	 WHEN EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(j.evidence_json) THEN j.evidence_json ELSE '{}' END,'$.checks') c WHERE json_extract(c.value,'$.field')='hours' AND json_extract(c.value,'$.confirmed')=0) THEN 'hours'
	 WHEN EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(j.evidence_json) THEN j.evidence_json ELSE '{}' END,'$.checks') c WHERE json_extract(c.value,'$.field')='phone' AND json_extract(c.value,'$.confirmed')=0) THEN 'contact'
	 ELSE 'other' END AS reason
	 FROM verification_jobs j JOIN locations l ON l.id=j.location_id WHERE l.status='active'
	 AND j.id=(SELECT MAX(v.id) FROM verification_jobs v WHERE v.location_id=j.location_id))`;
	const counts = (await env.DB.prepare(cte+' SELECT reason,COUNT(*) AS total FROM latest GROUP BY reason').all<{reason:string;total:number}>()).results;
	const mappingTotal = Number(await env.DB.prepare("SELECT COUNT(*) n FROM locations WHERE status='active' AND (latitude IS NULL OR longitude IS NULL)").first('n'));
	counts.push({reason:'mapping',total:mappingTotal});
	if (category === 'mapping') {
		const rows=await env.DB.prepare("SELECT id, id AS location_id,name AS location_name,address AS location_address,source_url,'needs_coordinates' AS status,updated_at AS scheduled_for,'Full street address, city and ZIP need a confirmed map position.' AS error_message FROM locations WHERE status='active' AND (latitude IS NULL OR longitude IS NULL) ORDER BY id LIMIT 50 OFFSET ?").bind((page-1)*50).all();
		return json({verification_jobs:rows.results,counts,total:mappingTotal,page,page_size:50});
	}
	const where = category === 'attention' ? "reason NOT IN ('confirmed','running')" : 'reason = ?';
	const bindings = category === 'attention' ? [] : [category];
	const result = await env.DB.prepare(cte+` SELECT * FROM latest WHERE ${where} ORDER BY updated_at DESC,id DESC LIMIT 50 OFFSET ?`).bind(...bindings,(page-1)*50).all();
	const total = counts.filter(c=>category==='attention' ? !['confirmed','running','mapping'].includes(c.reason) : c.reason===category).reduce((n,c)=>n+c.total,0);
	return json({ verification_jobs: result.results, counts, total, page, page_size:50 });
}

async function adminList(env: Env, kind: 'suggestions' | 'reports' | 'locations' | 'verification-jobs'): Promise<Response> {
	if (kind === 'suggestions') {
		const rows = await env.DB.prepare(
			`SELECT s.*, l.name AS duplicate_name, l.address AS duplicate_address
			FROM suggestions s LEFT JOIN locations l ON l.id = s.duplicate_of_location_id
			WHERE s.status = 'pending' ORDER BY s.submitted_at ASC LIMIT 250`,
		).all();
		return json({ suggestions: rows.results });
	}
	if (kind === 'reports') {
		const rows = await env.DB.prepare(
			`SELECT r.*, l.name AS location_name, l.address AS location_address
			FROM reports r JOIN locations l ON l.id = r.location_id
			WHERE r.status = 'open' ORDER BY r.submitted_at ASC LIMIT 250`,
		).all();
		return json({ reports: rows.results });
	}
	if (kind === 'verification-jobs') {
		const rows = await env.DB.prepare(
			`SELECT j.id, j.location_id, j.source_url, j.status, j.attempt_count, j.evidence_json,
				j.error_message, j.workflow_instance_id, j.scheduled_for, j.started_at, j.completed_at,
				l.name AS location_name, l.address AS location_address
			FROM verification_jobs j JOIN locations l ON l.id = j.location_id
			ORDER BY CASE j.status WHEN 'needs_review' THEN 0 WHEN 'proposed' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
				j.updated_at DESC LIMIT 250`,
		).all();
		return json({ verification_jobs: rows.results });
	}
	const rows = await env.DB.prepare(
		`SELECT id, name, address, zip_code, service_type, organization_name, hours,
		contact_phone, contact_email, contact_web, notes, source_url, latitude, longitude,
		eligibility, accessibility, languages, appointment_required, schedule_timezone, verification_due_at,
		status, verification_status, verified_fields, verification_source_url, verification_notes,
		last_verified_at, last_reviewed_at, updated_at
		FROM locations ORDER BY updated_at DESC LIMIT 500`,
	).all();
	return json({ locations: rows.results });
}

async function reviewSuggestion(request: Request, env: Env, id: number, action: 'approve' | 'reject'): Promise<Response> {
	const existing = await env.DB.prepare("SELECT * FROM suggestions WHERE id = ? AND status = 'pending'")
		.bind(id)
		.first<Record<string, unknown>>();
	if (!existing) return json({ error: 'Pending suggestion not found.' }, 404);
	const body = await readBody(request);
	const reviewNotes = optional(body.review_notes, 1200);

	if (action === 'reject') {
		await env.DB.batch([
			env.DB.prepare("UPDATE suggestions SET status = 'rejected', review_notes = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(reviewNotes, id),
			env.DB.prepare("INSERT INTO workflow_events (entity_type, entity_id, action, note) VALUES ('suggestion', ?, 'rejected', ?)").bind(id, reviewNotes),
		]);
		return json({ ok: true });
	}

	const fields = suggestionFields({ ...existing, ...body });
	const validationError = validateSuggestion(fields);
	if (validationError) return json({ error: validationError }, 400);
	let lat = coordinate(body.latitude, existing.latitude, -90, 90);
	let lon = coordinate(body.longitude, existing.longitude, -180, 180);
	const addressChanged = normalized(fields.address) !== normalized(String(existing.address)) || fields.zip_code !== existing.zip_code;
	const coordinatesEdited =
		(body.latitude !== '' && body.latitude != null && Number(body.latitude) !== Number(existing.latitude)) ||
		(body.longitude !== '' && body.longitude != null && Number(body.longitude) !== Number(existing.longitude));
	if (addressChanged && !coordinatesEdited) {
		const geocoded = await geocodeAddress(fields.address + ' ' + fields.zip_code, fields.zip_code);
		lat = geocoded?.latitude ?? null;
		lon = geocoded?.longitude ?? null;
	}
	const markedVerified = body.mark_verified === true;
	const verifiedAt = markedVerified ? new Date().toISOString() : null;
	const verificationDue = markedVerified ? nextVerificationDue() : null;
	const verificationStatus = markedVerified ? 'verified' : 'unverified';
	const verifiedFields = markedVerified
		? ['name', 'address', 'zip', 'service', fields.hours && 'hours', fields.contact_phone && 'phone', fields.contact_email && 'email', fields.contact_web && 'website'].filter(Boolean).join(',')
		: null;

	await env.DB.batch([
		env.DB.prepare(
			`UPDATE suggestions SET name = ?, normalized_name = ?, address = ?, normalized_address = ?,
			zip_code = ?, service_type = ?, organization_name = ?, hours = ?, contact_phone = ?,
			contact_email = ?, contact_web = ?, notes = ?, source_url = ?, eligibility = ?,
			accessibility = ?, languages = ?, appointment_required = ?, latitude = ?, longitude = ?
			WHERE id = ? AND status = 'pending'`,
		).bind(
			fields.name, normalized(fields.name), fields.address, normalized(fields.address), fields.zip_code,
			fields.service_type, fields.organization_name, fields.hours, fields.contact_phone,
			fields.contact_email, fields.contact_web, fields.notes, fields.source_url, fields.eligibility,
			fields.accessibility, fields.languages, fields.appointment_required, lat, lon, id,
		),
		env.DB.prepare(
			`INSERT INTO locations (
				name, normalized_name, address, normalized_address, zip_code, service_type,
				organization_name, hours, contact_phone, contact_email, contact_web, notes,
				source_url, eligibility, accessibility, languages, appointment_required, schedule_timezone,
				latitude, longitude, status, verification_status, verified_fields,
				verification_source_url, verification_notes, last_verified_at, last_reviewed_at,
				verification_due_at, source_suggestion_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			fields.name, normalized(fields.name), fields.address, normalized(fields.address), fields.zip_code,
			fields.service_type, fields.organization_name, fields.hours, fields.contact_phone,
			fields.contact_email, fields.contact_web, fields.notes, fields.source_url, fields.eligibility,
			fields.accessibility, fields.languages, fields.appointment_required, 'America/New_York', lat, lon,
			verificationStatus, verifiedFields, markedVerified ? fields.source_url : null,
			markedVerified ? reviewNotes : null, verifiedAt, verifiedAt, verificationDue, id,
		),
		...normalizeRecord(fields).rows.map(row => env.DB.prepare('INSERT INTO location_operating_hours(location_id,day_of_week,opens_at,closes_at,source_url) SELECT id,?,?,?,? FROM locations WHERE source_suggestion_id=?').bind(row.day,row.opens,row.closes,fields.source_url,id)),
		env.DB.prepare(
			`UPDATE suggestions SET status = 'approved', review_notes = ?, reviewed_at = CURRENT_TIMESTAMP,
			published_location_id = (SELECT id FROM locations WHERE source_suggestion_id = ?)
			WHERE id = ?`,
		).bind(reviewNotes, id, id),
		env.DB.prepare("INSERT INTO workflow_events (entity_type, entity_id, action, note) VALUES ('suggestion', ?, 'approved', ?)").bind(id, reviewNotes),
	]);
	return json({ ok: true });
}

async function resolveReport(request: Request, env: Env, id: number): Promise<Response> {
	const body = await readBody(request);
	const note = optional(body.resolution_notes, 1200);
	const result = await env.DB.batch([
		env.DB.prepare("UPDATE reports SET status = 'resolved', resolution_notes = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'open'").bind(note, id),
		env.DB.prepare("INSERT INTO workflow_events (entity_type, entity_id, action, note) VALUES ('report', ?, 'resolved', ?)").bind(id, note),
	]);
	if (!result[0].meta.changes) return json({ error: 'Open report not found.' }, 404);
	return json({ ok: true });
}

async function updateLocation(request: Request, env: Env, id: number): Promise<Response> {
	const existing = await env.DB.prepare('SELECT * FROM locations WHERE id = ?').bind(id).first<Record<string, unknown>>();
	if (!existing) return json({ error: 'Location not found.' }, 404);
	const body = await readBody(request);
	const fields = suggestionFields({ ...existing, ...body });
	const validationError = validateSuggestion(fields);
	if (validationError) return json({ error: validationError }, 400);
	const status = body.status === 'inactive' ? 'inactive' : 'active';
	for (const [field, minimum, maximum] of [['latitude', -90, 90], ['longitude', -180, 180]] as const) {
		const value = body[field];
		if (value != null && value !== '' && (!Number.isFinite(Number(value)) || Number(value) < minimum || Number(value) > maximum)) return json({ error: `Enter a valid ${field}.` }, 400);
	}
	let lat = coordinate(body.latitude, existing.latitude, -90, 90);
	let lon = coordinate(body.longitude, existing.longitude, -180, 180);
	if ((lat == null) !== (lon == null)) return json({ error: 'Provide both coordinates, or clear both.' }, 400);
	const addressChanged = normalized(fields.address) !== normalized(String(existing.address)) || fields.zip_code !== existing.zip_code;
	const coordinatesEdited =
		(body.latitude !== '' && body.latitude != null && Number(body.latitude) !== Number(existing.latitude)) ||
		(body.longitude !== '' && body.longitude != null && Number(body.longitude) !== Number(existing.longitude));
	if (addressChanged && !coordinatesEdited) {
		const geocoded = await geocodeAddress(fields.address + ' ' + fields.zip_code, fields.zip_code);
		lat = geocoded?.latitude ?? null;
		lon = geocoded?.longitude ?? null;
	}
	const changed = ['name','address','zip_code','service_type','hours','contact_phone','contact_email','contact_web','source_url'].some(key => fields[key as keyof typeof fields] !== existing[key]);
	if (changed) { existing.verification_status = 'unverified'; existing.verified_fields = null; existing.last_verified_at = null; existing.last_reviewed_at = null; existing.verification_source_url = null; existing.verification_notes = null; existing.verification_due_at = null; }
	const markedVerified = body.mark_verified === true;
	const verifiedAt = markedVerified ? new Date().toISOString() : existing.last_verified_at;
	const verificationStatus = markedVerified ? 'verified' : String(existing.verification_status || 'unverified');
	const verifiedFields = markedVerified
		? ['name', 'address', 'zip', 'service', fields.hours && 'hours', fields.contact_phone && 'phone', fields.contact_email && 'email', fields.contact_web && 'website'].filter(Boolean).join(',')
		: existing.verified_fields;
	const verificationSource = markedVerified ? fields.source_url : existing.verification_source_url;
	const verificationNotes = markedVerified ? optional(body.review_notes, 1200) : existing.verification_notes;
	const reviewedAt = markedVerified ? verifiedAt : existing.last_reviewed_at;
	const verificationDue = markedVerified ? nextVerificationDue() : existing.verification_due_at;
	const scheduleTimezone = clean(body.schedule_timezone ?? existing.schedule_timezone, 80) || 'America/New_York';
	if (scheduleTimezone !== 'America/New_York') return json({ error: 'Structured schedules currently support America/New_York only.' }, 400);

	await env.DB.batch([
		env.DB.prepare(
			`UPDATE locations SET name = ?, normalized_name = ?, address = ?, normalized_address = ?,
			zip_code = ?, service_type = ?, organization_name = ?, hours = ?, contact_phone = ?,
			contact_email = ?, contact_web = ?, notes = ?, source_url = ?, eligibility = ?,
			accessibility = ?, languages = ?, appointment_required = ?, schedule_timezone = ?,
			latitude = ?, longitude = ?,
			status = ?, verification_status = ?, verified_fields = ?, verification_source_url = ?,
			verification_notes = ?, last_verified_at = ?, last_reviewed_at = ?, verification_due_at = ?,
			updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		).bind(
			fields.name, normalized(fields.name), fields.address, normalized(fields.address), fields.zip_code,
			fields.service_type, fields.organization_name, fields.hours, fields.contact_phone,
			fields.contact_email, fields.contact_web, fields.notes, fields.source_url, fields.eligibility,
			fields.accessibility, fields.languages, fields.appointment_required, scheduleTimezone, lat, lon,
			status, verificationStatus, verifiedFields, verificationSource, verificationNotes,
			verifiedAt, reviewedAt, verificationDue, id,
		),
		env.DB.prepare("UPDATE verification_jobs SET status='confirmed', completed_at=CURRENT_TIMESTAMP WHERE location_id=? AND id=(SELECT MAX(id) FROM verification_jobs WHERE location_id=?) AND ?=1").bind(id,id,markedVerified ? 1 : 0),
		env.DB.prepare('DELETE FROM location_operating_hours WHERE location_id = ?').bind(id),
		...normalizeRecord(fields).rows.map((row) => env.DB.prepare('INSERT INTO location_operating_hours(location_id,day_of_week,opens_at,closes_at,source_url) VALUES (?,?,?,?,?)').bind(id,row.day,row.opens,row.closes,fields.source_url)),
		env.DB.prepare("INSERT INTO workflow_events (entity_type, entity_id, action, note) VALUES ('location', ?, 'updated', ?)").bind(id, optional(body.review_notes, 1200)),
	]);
	return json({ ok: true });
}

export async function geocodeAddress(address: string, expectedZip: string): Promise<{ latitude: number; longitude: number } | null> {
	const url = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
	url.searchParams.set('address', address);
	url.searchParams.set('benchmark', 'Public_AR_Current');
	url.searchParams.set('format', 'json');
	try {
		const response = await fetch(url.toString(), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
		if (!response.ok) return null;
		const data = (await response.json()) as {
			result?: { addressMatches?: Array<{ matchedAddress?: string; coordinates?: { x: number; y: number } }> };
		};
		const match = data.result?.addressMatches?.[0];
		const coordinates = match?.coordinates;
		if (
			!coordinates ||
			!Number.isFinite(coordinates.x) ||
			!Number.isFinite(coordinates.y) ||
			!matchedAddressHasZip(match?.matchedAddress || '', expectedZip)
		) return null;
		return { latitude: coordinates.y, longitude: coordinates.x };
	} catch {
		return null;
	}
}

async function geocodeSuggestion(env: Env, id: number): Promise<void> {
	const row = await env.DB.prepare('SELECT address, zip_code FROM suggestions WHERE id = ? AND (latitude IS NULL OR longitude IS NULL)').bind(id).first<{ address: string; zip_code: string }>();
	if (!row) return;
	await env.DB.prepare('UPDATE suggestions SET geocode_attempted_at=CURRENT_TIMESTAMP WHERE id=?').bind(id).run();
	const coordinates = await geocodeAddress(row.address + ' ' + row.zip_code, row.zip_code);
	if (coordinates) {
		await env.DB.prepare('UPDATE suggestions SET latitude = ?, longitude = ? WHERE id = ?')
			.bind(coordinates.latitude, coordinates.longitude, id)
			.run();
	}
}

export async function geocodeMissing(env: Env): Promise<void> {
	const suggestions = await env.DB.prepare("SELECT id FROM suggestions WHERE status = 'pending' AND (latitude IS NULL OR longitude IS NULL) AND (geocode_attempted_at IS NULL OR geocode_attempted_at < datetime('now','-1 day')) ORDER BY geocode_attempted_at,id LIMIT 5").all<{ id: number }>();
	for (const row of suggestions.results) await geocodeSuggestion(env, row.id);

	const locations = await env.DB.prepare("SELECT id, address, zip_code FROM locations WHERE status = 'active' AND (latitude IS NULL OR longitude IS NULL) AND (geocode_attempted_at IS NULL OR geocode_attempted_at < datetime('now','-1 day')) ORDER BY geocode_attempted_at,id LIMIT 20").all<{ id: number; address: string; zip_code: string }>();
	for (const row of locations.results) {
		await env.DB.prepare('UPDATE locations SET geocode_attempted_at=CURRENT_TIMESTAMP WHERE id=?').bind(row.id).run();
		const coordinates = await geocodeAddress(row.address + ' ' + row.zip_code, row.zip_code);
		if (coordinates) {
			await env.DB.prepare('UPDATE locations SET latitude = ?, longitude = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
				.bind(coordinates.latitude, coordinates.longitude, row.id)
				.run();
		}
	}
}

type VerificationTarget = {
	id: number;
	name: string;
	address: string;
	zip_code: string;
	contact_phone: string | null;
	hours: string | null;
	verification_status: string;
	source_url: string;
};

function sourceUrlAllowed(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
		const host = url.hostname.toLowerCase();
		return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && !host.endsWith('.local') && !/^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host);
	} catch {
		return false;
	}
}

async function fetchVerificationSource(env: Env, sourceUrl: string): Promise<{ text: string; method: string; final_url: string; title: string }> {
	if (!sourceUrlAllowed(sourceUrl)) throw new Error('Source URL is not allowed.');
	try {
		const response = await fetch(sourceUrl, {
			redirect: 'follow',
			headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'FreeFoodMapVerifier/1.0 (+https://freefoodmap.org)' },
			signal: AbortSignal.timeout(15_000),
		});
		const finalUrl = response.url || sourceUrl;
		if (!sourceUrlAllowed(finalUrl)) throw new Error('The source redirected to a disallowed URL.');
		const contentType = response.headers.get('content-type') || '';
		if (response.ok && (contentType.includes('text/html') || contentType.includes('text/plain'))) {
			const body = (await response.text()).slice(0, 500_000);
			if (body.length > 200) return { text: body, method: 'fetch', final_url: finalUrl, title: '' };
		}
	} catch (error) {
		console.error('Direct verification fetch failed', error);
	}
	if (!env.BROWSER) throw new Error('The source could not be read and browser rendering is not configured.');
	const browser = await puppeteer.launch(env.BROWSER);
	try {
		const page = await browser.newPage();
		await page.goto(sourceUrl, { waitUntil: 'networkidle2', timeout: 25_000 });
		if (!sourceUrlAllowed(page.url())) throw new Error('The source redirected to a disallowed URL.');
		const [content, title] = await Promise.all([page.content(), page.title()]);
		return { text: content.slice(0, 500_000), method: 'browser', final_url: page.url(), title };
	} finally {
		await browser.close();
	}
}

function evidenceMatch(sourceText: string, value: string | null, mode: 'text' | 'phone' = 'text'): boolean {
	if (!value) return false;
	if (mode === 'phone') {
		const needle = value.replace(/\D/g, '').slice(-10);
		return needle.length >= 7 && sourceText.replace(/\D/g, '').includes(needle);
	}
	const needle = normalized(value);
	return needle.length >= 3 && normalized(sourceText).includes(needle);
}

export async function performVerification(env: Env, locationId: number, jobId: number): Promise<{ status: string; confirmed_fields: string[] }> {
	const target = await env.DB.prepare(
		`SELECT id, name, address, zip_code, contact_phone, hours, verification_status,
			COALESCE(NULLIF(verification_source_url, ''), NULLIF(source_url, ''), contact_web) AS source_url
		FROM locations WHERE id = ? AND status = 'active'`,
	)
		.bind(locationId)
		.first<VerificationTarget>();
	if (!target?.source_url) {
		await env.DB.prepare("UPDATE verification_jobs SET status='failed',error_message='Location is inactive or has no public source',completed_at=CURRENT_TIMESTAMP WHERE id=?").bind(jobId).run();
		throw new Error('No public source URL is available for this location.');
	}
	await env.DB.prepare("UPDATE verification_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP, attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(jobId).run();

	try {
		const source = await fetchVerificationSource(env, target.source_url);
		const checks = [
			{ field: 'name', value: target.name, confirmed: evidenceMatch(source.text, target.name) },
			{ field: 'address', value: target.address, confirmed: evidenceMatch(source.text, target.address) },
			{ field: 'zip', value: target.zip_code, confirmed: evidenceMatch(source.text, target.zip_code) },
			{ field: 'phone', value: target.contact_phone, confirmed: evidenceMatch(source.text, target.contact_phone, 'phone') },
			{ field: 'hours', value: target.hours, confirmed: evidenceMatch(source.text, target.hours) },
		].filter((check) => check.value);
		const confirmedFields = checks.filter((check) => check.confirmed).map((check) => check.field);
		const exact = confirmedFields.includes('address') && confirmedFields.includes('zip') && (confirmedFields.includes('name') || confirmedFields.includes('phone'));
		const jobStatus = exact ? 'confirmed' : 'needs_review';
		const evidence = { checked_at: new Date().toISOString(), source_url: source.final_url, retrieval_method: source.method, title: source.title, checks: checks.map(({ field, confirmed }) => ({ field, confirmed })) };
		const statements = checks.map((check) => env.DB.prepare(
			`INSERT INTO location_evidence (location_id, field_name, observed_value, source_url, status, note)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).bind(locationId, check.field, check.confirmed ? check.value : null, source.final_url, check.confirmed ? 'confirmed' : 'missing', `Automated ${source.method} check`));
		statements.push(env.DB.prepare(
			`UPDATE verification_jobs SET status = ?, evidence_json = ?, error_message = NULL,
			 completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		).bind(jobStatus, JSON.stringify(evidence), jobId));
		if (!exact) statements.push(env.DB.prepare("UPDATE locations SET verification_status='needs_review', verified_fields=NULL, verification_due_at=datetime('now','+7 days'), updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(locationId));
		if (exact) {
			statements.push(env.DB.prepare(
				`UPDATE locations SET verification_status = 'partial', verified_fields = ?, verification_source_url = ?, last_verified_at = CURRENT_TIMESTAMP,
			 last_reviewed_at = CURRENT_TIMESTAMP, verification_due_at = datetime('now', '+90 days'), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
			).bind(confirmedFields.join(','), source.final_url, locationId));
		}
		await env.DB.batch(statements);
		return { status: jobStatus, confirmed_fields: confirmedFields };
	} catch (error) {
		const message = error instanceof Error ? error.message.slice(0, 500) : 'Verification failed.';
		await env.DB.prepare("UPDATE verification_jobs SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(message, jobId).run();
		throw error;
	}
}

export async function queueLocationVerification(env: Env, locationId: number): Promise<{ job_id: number; workflow_id: string }> {
	if (!env.VERIFY_WORKFLOW) throw new Error('Verification Workflow is not configured.');
	const target = await env.DB.prepare(
		`SELECT id, COALESCE(NULLIF(verification_source_url, ''), NULLIF(source_url, ''), contact_web) AS source_url
		 FROM locations WHERE id = ? AND status = 'active'`,
	).bind(locationId).first<{ id: number; source_url: string | null }>();
	if (!target?.source_url || !sourceUrlAllowed(target.source_url)) throw new Error('This location does not have a usable public source URL.');
	const existing = await env.DB.prepare("SELECT id FROM verification_jobs WHERE location_id = ? AND status IN ('queued', 'running') LIMIT 1").bind(locationId).first<{ id: number }>();
	if (existing) return { job_id: existing.id, workflow_id: '' };
	const insert = await env.DB.prepare("INSERT INTO verification_jobs (location_id, source_url) VALUES (?, ?)").bind(locationId, target.source_url).run();
	const jobId = Number(insert.meta.last_row_id);
	let instance;
	try { instance = await env.VERIFY_WORKFLOW.create({ id: `location-${locationId}-job-${jobId}`, params: { location_id: locationId, job_id: jobId } }); }
	catch (error) { await env.DB.prepare("UPDATE verification_jobs SET status='failed', error_message='Workflow creation failed', completed_at=CURRENT_TIMESTAMP WHERE id=?").bind(jobId).run(); throw error; }
	await env.DB.prepare('UPDATE verification_jobs SET workflow_instance_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(instance.id, jobId).run();
	return { job_id: jobId, workflow_id: instance.id };
}

async function queueDueVerifications(env: Env): Promise<void> {
	if (!env.VERIFY_WORKFLOW) return;
	const due = await env.DB.prepare(
		`SELECT l.id FROM locations l
		 WHERE l.status = 'active'
		 AND COALESCE(NULLIF(l.verification_source_url, ''), NULLIF(l.source_url, ''), l.contact_web) IS NOT NULL
		 AND (l.verification_due_at IS NULL OR l.verification_due_at <= CURRENT_TIMESTAMP )
		 AND NOT EXISTS (SELECT 1 FROM verification_jobs j WHERE j.location_id = l.id AND (j.status IN ('queued', 'running') OR j.created_at > datetime('now','-1 day')))
		 ORDER BY COALESCE(l.verification_due_at, '1970-01-01'), l.id LIMIT 1000`,
	).all<{ id: number }>();
	for (const location of due.results) {
		try {
			await queueLocationVerification(env, location.id);
		} catch (error) {
			console.error('Could not queue verification', location.id, error);
		}
	}
}

export class LocationVerificationWorkflow extends WorkflowEntrypoint<Env, VerificationWorkflowParams> {
	async run(event: Readonly<WorkflowEvent<VerificationWorkflowParams>>, step: WorkflowStep): Promise<unknown> {
		return step.do('check-public-source', { retries: { limit: 2, delay: '30 seconds' }, timeout: '1 minute' }, () =>
			performVerification(this.env, event.payload.location_id, event.payload.job_id),
		);
	}
}

async function publishPublicMap(request: Request, env: Env): Promise<Response> {
	if (request.headers.get('origin') !== new URL(request.url).origin) {
		return json({ error: 'Open the admin dashboard to publish the map.' }, 403);
	}
	const token = env.START_MAP_PUBLISH_7314_FNA106_11042026 || env.MAP_PUBLISH_GITHUB_TOKEN;
	if (!token) {
		return json({ error: 'Map publishing has not been configured.' }, 503);
	}

	const response = await fetch('https://api.github.com/repos/fna106/FreeFoodMap/actions/workflows/deploy-cloudflare.yml/dispatches', {
		method: 'POST',
		headers: {
			accept: 'application/vnd.github+json',
			authorization: 'Bearer ' + token,
			'content-type': 'application/json',
			'user-agent': 'free-food-map',
			'x-github-api-version': '2026-03-10',
		},
		body: JSON.stringify({ ref: 'main', return_run_details: true }),
		signal: AbortSignal.timeout(10000),
	}).catch(() => null);

	if (!response?.ok) {
		console.error('Map publish dispatch failed', response?.status);
		return json({ error: 'Could not confirm that publishing started. Check GitHub Actions before retrying.' }, 502);
	}
	const run = await response.json<{ workflow_run_id?: number }>().catch(() => null);
	const runsUrl = 'https://github.com/fna106/FreeFoodMap/actions';
	return json({
		run_url: Number.isSafeInteger(run?.workflow_run_id) ? runsUrl + '/runs/' + run?.workflow_run_id : runsUrl + '/workflows/deploy-cloudflare.yml',
	}, 202);
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const method = request.method.toUpperCase();

	if (method === 'GET' && url.pathname === '/api/meta') {
		return cachedPublicResponse(request, ctx, 86_400, () => Promise.resolve(json({
			service_types: SERVICE_TYPES,
			report_categories: ['Wrong hours', 'Location closed', 'Wrong address', 'Contact information', 'Eligibility or access', 'Other'],
			confirmation_signals: CONFIRMATION_SIGNALS,
			turnstile_site_key: env.TURNSTILE_SITE_KEY || null,
		})));
	}
	if (method === 'GET' && url.pathname === '/api/stats') return cachedPublicResponse(request, ctx, 3600, () => publicStats(env));
	if (method === 'GET' && url.pathname === '/api/locations') return cachedPublicResponse(request, ctx, 60, () => listLocations(request, env));
	if (method === 'GET' && url.pathname === '/api/open-data/hsds') return cachedPublicResponse(request, ctx, 86_400, () => exportHsds(env));
	if (method === 'POST' && url.pathname === '/api/suggestions') return submitSuggestion(request, env, ctx);
	if (method === 'POST' && url.pathname === '/api/reports') return submitReport(request, env);
	const confirmationMatch = url.pathname.match(/^\/api\/locations\/(\d+)\/confirm$/);
	if (method === 'POST' && confirmationMatch) return submitConfirmation(request, env, Number(confirmationMatch[1]));

	if (url.pathname.startsWith('/api/admin/')) {
		if (!(await isAdmin(request, env))) return json({ error: 'Admin access required.' }, 401);
		if (method === 'POST' && url.pathname === '/api/admin/publish') return publishPublicMap(request, env);
		if (method === 'GET' && url.pathname === '/api/admin/overview') return adminOverview(env);
		if (method === 'GET' && url.pathname === '/api/admin/suggestions') return adminList(env, 'suggestions');
		if (method === 'GET' && url.pathname === '/api/admin/reports') return adminList(env, 'reports');
		if (method === 'GET' && url.pathname === '/api/admin/locations') return adminList(env, 'locations');
		if (method === 'GET' && url.pathname === '/api/admin/verification-jobs') return verificationQueue(request, env);

		const suggestionMatch = url.pathname.match(/^\/api\/admin\/suggestions\/(\d+)\/(approve|reject)$/);
		if (method === 'POST' && suggestionMatch) {
			return reviewSuggestion(request, env, Number(suggestionMatch[1]), suggestionMatch[2] as 'approve' | 'reject');
		}
		const reportMatch = url.pathname.match(/^\/api\/admin\/reports\/(\d+)\/resolve$/);
		if (method === 'POST' && reportMatch) return resolveReport(request, env, Number(reportMatch[1]));
		const locationMatch = url.pathname.match(/^\/api\/admin\/locations\/(\d+)$/);
		if (method === 'GET' && locationMatch) {
			const location = await env.DB.prepare('SELECT * FROM locations WHERE id=?').bind(Number(locationMatch[1])).first();
			return location ? json({ location }) : json({ error: 'Location not found.' },404);
		}
		if (method === 'PUT' && locationMatch) return updateLocation(request, env, Number(locationMatch[1]));
		const verificationMatch = url.pathname.match(/^\/api\/admin\/locations\/(\d+)\/verify$/);
		if (method === 'POST' && verificationMatch) {
			try {
				return json({ ok: true, ...(await queueLocationVerification(env, Number(verificationMatch[1]))) }, 202);
			} catch (error) {
				return json({ error: error instanceof Error ? error.message : 'Could not queue verification.' }, 400);
			}
		}
	}

	return json({ error: 'Not found.' }, 404);
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		try {
			const url = new URL(request.url);
			const incomingHost = (request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host).split(':')[0].toLowerCase();
			const isPublicDomain = incomingHost === 'freefoodmap.org' || incomingHost === 'www.freefoodmap.org';
			const visitorUsesHttp = /"scheme"\s*:\s*"http"/.test(request.headers.get('cf-visitor') || '');
			if (isPublicDomain && (visitorUsesHttp || incomingHost === 'www.freefoodmap.org')) {
				url.protocol = 'https:';
				url.hostname = 'freefoodmap.org';
				return Response.redirect(url.toString(), 308);
			}
			if (url.pathname.startsWith('/api/')) return await handleApi(request, env, ctx);
			const locationMatch = url.pathname.match(/^\/locations\/(\d+)(?:\/([^/]+))?\/?$/);
			if (request.method === 'GET' && locationMatch) {
				return cachedPublicResponse(request, ctx, 3600, () => renderLocationPage(env, Number(locationMatch[1]), locationMatch[2] || ''));
			}
			if (request.method === 'GET' && url.pathname === '/sitemap.xml') return cachedPublicResponse(request, ctx, 3600, () => renderSitemap(env));
			if (request.method === 'GET' && url.pathname === '/robots.txt') {
				return new Response('User-agent: *\nAllow: /\nSitemap: https://freefoodmap.org/sitemap.xml\n', {
					headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' },
				});
			}
			return env.ASSETS.fetch(request);
		} catch (error) {
			console.error(error);
			const message = error instanceof Error ? error.message : 'Unexpected server error.';
			if (/D1.*(exceeded|limit)|daily.*row.*limit/i.test(message)) return json({error:'Live updates are temporarily unavailable. Please try again later; changes were not saved.'},503,{'retry-after':'3600'});
			return json({ error: error instanceof RequestError ? message : 'Unexpected server error.' }, error instanceof RequestError ? error.status : 500);
		}
	},
	async scheduled(_controller, env, ctx): Promise<void> {
		ctx.waitUntil((_controller.cron === '15 3 * * 1,4' ? queueDueVerifications(env) : geocodeMissing(env)));
	},
} satisfies ExportedHandler<Env>;

import { normalizeRecord } from './hours.mjs';

/** @param {string} value */
export function normalized(value) {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function haversineMiles(latitudeA, longitudeA, latitudeB, longitudeB) {
	const toRadians = (degrees) => (degrees * Math.PI) / 180;
	const latitudeDelta = toRadians(latitudeB - latitudeA);
	const longitudeDelta = toRadians(longitudeB - longitudeA);
	const a =
		Math.sin(latitudeDelta / 2) ** 2 +
		Math.cos(toRadians(latitudeA)) * Math.cos(toRadians(latitudeB)) * Math.sin(longitudeDelta / 2) ** 2;
	return 3958.7613 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function easternClock(date = new Date()) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/New_York',
		weekday: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(date);
	const weekday = parts.find((part) => part.type === 'weekday')?.value || 'Sun';
	const hour = parts.find((part) => part.type === 'hour')?.value || '00';
	const minute = parts.find((part) => part.type === 'minute')?.value || '00';
	const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
	return { day, previousDay: (day + 6) % 7, time: `${hour}:${minute}` };
}

export function searchSnapshot(data, p, lat, lon, radius) {
	const zip = (p.get('zip') || '').trim();
	const service = p.get('service');
	const requestedNearby = p.has('lat') || p.has('lon');
	const terms = normalized((p.get('q') || '').trim().slice(0, 120)).split(/\s+/).filter(term => term.length > 1);
	const clock = easternClock();
	const nearby = lat != null && lon != null;
	let locations = [];

	for (const listing of data.locations) {
		if (service && listing.service_type !== service) continue;
		const words = normalized([listing.name, listing.organization_name, listing.address, listing.service_type, listing.notes].join(' ')).split(' ');
		if (!terms.every(term => words.some(word => word.startsWith(term)))) continue;
		if (p.get('has_hours') === 'true' && !String(listing.hours || '').trim()) continue;

		const distance = nearby && listing.latitude != null && listing.longitude != null
			? haversineMiles(lat, lon, Number(listing.latitude), Number(listing.longitude))
			: null;
		if (distance != null ? distance > radius : zip && listing.zip_code !== zip) continue;
		if (nearby && distance == null && !zip) continue;

		const { rows } = normalizeRecord(listing);
		const open = rows.some(({ day, opens, closes }) =>
			(day === clock.day && opens <= clock.time && (opens > closes || closes > clock.time)) ||
			(day === clock.previousDay && opens > closes && closes > clock.time),
		);
		if (p.get('open_now') === 'true' && !open) continue;

		const { verification_source_url, verification_notes, source_url, verified_fields, ...location } = listing;
		const confirmationTime = Date.parse(String(location.recent_confirmation_at || '').replace(' ', 'T').replace(/(?<=\d)$/, 'Z'));
		const recent = confirmationTime >= Date.now() - 86400000;
		locations.push({
			...location,
			distance_miles: distance,
			is_open_now: Number(open),
			has_structured_hours: Number(rows.length > 0),
			recent_confirmation_signal: recent ? location.recent_confirmation_signal : null,
			recent_confirmation_at: recent ? location.recent_confirmation_at : null,
		});
	}

	locations.sort((a, b) => nearby
		? (a.distance_miles ?? Infinity) - (b.distance_miles ?? Infinity)
		: String(a.name).localeCompare(String(b.name)));
	if (nearby) locations = locations.slice(0, Math.min(250, Math.max(1, Number(p.get('limit')) || 100)));
	return {
		locations: locations.map(location => ({
			...location,
			distance_miles: location.distance_miles == null ? null : Math.round(location.distance_miles * 10) / 10,
		})),
		meta: {
			mode: nearby ? 'nearby' : zip ? 'zip' : 'all',
			count: locations.length,
			radius_miles: nearby ? radius : null,
			origin_zip: zip || null,
			approximate_origin: Boolean(zip && nearby && !requestedNearby),
			zip_center_unavailable: Boolean(zip && !nearby),
			unmapped_count: locations.filter(location => location.latitude == null || location.longitude == null).length,
			snapshot_at: data.snapshot_at,
		},
	};
}

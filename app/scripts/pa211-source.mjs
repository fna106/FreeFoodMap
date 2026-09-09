const PA211_QUERY = 'BD-1800.2000%2CBD-1800.1000';

export function pa211PageUrl(page) {
	return `https://search.pa211.org/search?page=${page}&query=${PA211_QUERY}&query_label=Food+Pantries+%2F+Banks&query_type=taxonomy`;
}

export async function fetchText(url, timeoutMs = 15_000) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			redirect: 'follow',
			headers: {
				accept: 'text/html,application/xhtml+xml',
				'user-agent': 'FreeFoodMap-Verification/1.0 (+https://freefoodmap.org)',
			},
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return { text: await response.text(), finalUrl: response.url, status: response.status };
	} finally {
		clearTimeout(timeout);
	}
}

function extractFlightStrings(html) {
	const prefix = 'self.__next_f.push(';
	const suffix = ')</script>';
	const strings = [];
	let cursor = 0;
	while (cursor < html.length) {
		const start = html.indexOf(prefix, cursor);
		if (start < 0) break;
		const valueStart = start + prefix.length;
		const end = html.indexOf(suffix, valueStart);
		if (end < 0) break;
		try {
			const value = JSON.parse(html.slice(valueStart, end));
			if (typeof value?.[1] === 'string') strings.push(value[1]);
		} catch {
			// A malformed framework chunk is ignored; the resource data is repeated in another chunk.
		}
		cursor = end + suffix.length;
	}
	return strings;
}

function balancedObjectAt(text, start) {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const character = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') inString = true;
		else if (character === '{') depth += 1;
		else if (character === '}') {
			depth -= 1;
			if (depth === 0) return text.slice(start, index + 1);
		}
	}
	return '';
}

export function parsePa211Page(html) {
	const services = new Map();
	let totalResults = 0;
	for (const chunk of extractFlightStrings(html)) {
		const total = Number(chunk.match(/"totalResults":(\d+)/)?.[1] || 0);
		if (total > totalResults) totalResults = total;
		let cursor = 0;
		while (cursor < chunk.length) {
			const start = chunk.indexOf('{"_id":"', cursor);
			if (start < 0) break;
			const objectText = balancedObjectAt(chunk, start);
			if (!objectText) break;
			try {
				const service = JSON.parse(objectText);
				if (service.attribution === 'Pennsylvania 211' && service.id && service.address) {
					services.set(service.id, service);
				}
			} catch {
				// Continue scanning when a non-resource object resembles a resource record.
			}
			cursor = start + objectText.length;
		}
	}
	return { services: [...services.values()], totalResults };
}

export async function pooled(items, concurrency, task) {
	const results = new Array(items.length);
	let cursor = 0;
	async function worker() {
		while (cursor < items.length) {
			const index = cursor;
			cursor += 1;
			results[index] = await task(items[index], index);
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
	return results;
}

export async function loadPa211Services({ requestedPages = null } = {}) {
	console.log('Loading current Pennsylvania 211 food-resource records...');
	const first = await fetchText(pa211PageUrl(1));
	const firstPage = parsePa211Page(first.text);
	if (!firstPage.services.length) throw new Error('PA 211 returned no parseable resource records.');
	const totalPages = requestedPages || Math.ceil(firstPage.totalResults / 25);
	const pages = Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) => index + 2);
	const remaining = await pooled(pages, 4, async (page, index) => {
		try {
			const response = await fetchText(pa211PageUrl(page));
			const parsed = parsePa211Page(response.text);
			if ((index + 1) % 8 === 0 || page === totalPages) console.log(`  PA 211 pages: ${page}/${totalPages}`);
			return parsed.services;
		} catch (error) {
			console.warn(`  PA 211 page ${page} failed: ${error.message}`);
			return [];
		}
	});
	const services = new Map(firstPage.services.map((service) => [service.id, service]));
	for (const page of remaining) for (const service of page) services.set(service.id, service);
	console.log(`  Loaded ${services.size} current PA 211 records from ${totalPages} pages.`);
	return [...services.values()];
}

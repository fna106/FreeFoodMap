const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const dayLookup = new Map([
	['sunday', 0], ['sundays', 0], ['sun', 0],
	['monday', 1], ['mondays', 1], ['mon', 1],
	['tuesday', 2], ['tuesdays', 2], ['tue', 2], ['tues', 2],
	['wednesday', 3], ['wednesdays', 3], ['wed', 3],
	['thursday', 4], ['thursdays', 4], ['thu', 4], ['thur', 4], ['thurs', 4],
	['friday', 5], ['fridays', 5], ['fri', 5],
	['saturday', 6], ['saturdays', 6], ['sat', 6],
]);
const dayToken = '(?:sundays?|sun|mondays?|mon|tuesdays?|tues?|wednesdays?|wed|thursdays?|thurs?|thur|thu|fridays?|fri|saturdays?|sat)\\.?';
const dayGroup = `${dayToken}(?:\\s*(?:,|and|&|to|through|-)\\s*${dayToken})*`;
const timeToken = '(?:[01]?\\d|2[0-3])(?::[0-5]\\d)?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?';
const schedulePattern = new RegExp(`(${dayGroup})\\s*(?::|,|-)?\\s*(?:from\\s*)?(${timeToken})\\s*(?:-|to|until|till)\\s*(${timeToken})`, 'gi');

function parseTime(raw) {
	const match = raw.toLowerCase().replace(/\./g, '').match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
	if (!match) return null;
	return { hour: Number(match[1]), minute: Number(match[2] || 0), meridiem: match[3] || '' };
}

function clockValue(time, inferredMeridiem) {
	const meridiem = time.meridiem || inferredMeridiem;
	if (!meridiem || time.hour > 23 || time.minute > 59) return null;
	let hour = time.hour;
	if (hour > 12 && meridiem) return null;
	if (meridiem === 'am') hour = hour === 12 ? 0 : hour;
	if (meridiem === 'pm') hour = hour === 12 ? 12 : hour + 12;
	return `${String(hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}

function parseRange(startRaw, endRaw) {
	const start = parseTime(startRaw);
	const end = parseTime(endRaw);
	if (!start || !end || (!start.meridiem && !end.meridiem)) return null;
	let startMeridiem = start.meridiem || end.meridiem;
	const endMeridiem = end.meridiem || start.meridiem;
	let opens = clockValue(start, startMeridiem);
	const closes = clockValue(end, endMeridiem);
	if (!opens || !closes) return null;
	if (!start.meridiem && endMeridiem === 'pm' && opens >= closes && start.hour >= 7) {
		startMeridiem = 'am';
		opens = clockValue(start, startMeridiem);
	}
	if (!opens || opens === closes) return null;
	return { opens, closes };
}

function parseDays(raw) {
	const normalized = raw.toLowerCase().replace(/\./g, '').trim();
	const names = [...normalized.matchAll(new RegExp(dayToken, 'gi'))].map((match) => dayLookup.get(match[0].replace(/\./g, '').toLowerCase()));
	if (names.some((day) => day == null) || !names.length) return [];
	if (/\b(to|through)\b|(?<=[a-z])-(?=[a-z])/i.test(normalized) && names.length === 2) {
		const days = [];
		for (let day = names[0]; ; day = (day + 1) % 7) {
			days.push(day);
			if (day === names[1] || days.length === 7) break;
		}
		return days;
	}
	return [...new Set(names)];
}

export function normalizeRecord(record) {
	const source = String(record.hours).replace(/[–—]/g, '-').replace(/Â/g, ' ').replace(/\s+/g, ' ').trim();
	if (/\b(first|second|third|fourth|fifth|last|final|following|alternating|1st|2nd|3rd|4th|5th|every other|monthly|each month|of (?:each|every|the) month|semester|season|spring break|appointment|emergenc(?:y|ies) only|specific|holidays?|hours? var(?:y|ies)|different hours|at most locations|office hours?|phone registration|donations accepted|hot meals?|dining hall)\b/i.test(source) || /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(source)) {
		return { rows: [], reason: 'recurring, seasonal, or appointment-based' };
	}
	if (/\b(?:open\s*)?24\s*\/\s*7\b/i.test(source)) {
		return { rows: dayNames.map((_name, day) => ({ day, opens: '00:00', closes: '24:00' })), reason: '' };
	}
	if (/office|donation|registration|deliveries/i.test(source)) return { rows: [], reason: 'mixed purpose hours' };
	// A second time range without its own weekday cannot be safely assigned yet.
	if (/\b(?:am|pm)\s*(?:and|&)\s*\d/i.test(source)) return { rows: [], reason: 'multiple daily intervals need review' };
	const rows = [];
	for (const match of source.matchAll(schedulePattern)) {
		const days = parseDays(match[1]);
		const range = parseRange(match[2], match[3]);
		if (!days.length || !range) continue;
		for (const day of days) rows.push({ day, ...range });
	}
	if (/\bdaily\b/i.test(source)) {
		const timeMatch = source.match(new RegExp(`(${timeToken})\\s*(?:-|to|until|till)\\s*(${timeToken})`, 'i'));
		const range = timeMatch && parseRange(timeMatch[1], timeMatch[2]);
		if (range) for (let day = 0; day < 7; day += 1) rows.push({ day, ...range });
	}
	const unique = [...new Map(rows.map((row) => [`${row.day}-${row.opens}-${row.closes}`, row])).values()];
	return { rows: unique, reason: unique.length ? '' : 'no unambiguous weekly schedule' };
}


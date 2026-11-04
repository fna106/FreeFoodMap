import * as snapshotSearch from '../public/snapshot-search.mjs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function client(useStaticData = false) {
	let fields = { zip: '', radius: '5' };
	const requests = [];
	const nodes = new Map();
	const node = id => {
		if (!nodes.has(id)) nodes.set(id, { addEventListener() {}, querySelectorAll: () => [], focus() {}, dataset: {}, classList: { add() {}, toggle() {} } });
		return nodes.get(id);
	};
	const sandbox = vm.createContext({
		staticSearchModule: snapshotSearch, console, URL, URLSearchParams, Map, Intl, Date,
		sessionStorage: { getItem: () => '' },
		document: { getElementById: node, querySelectorAll: () => [], addEventListener() {} },
		window: { addEventListener() {}, location: { hash: '' } },
		FormData: class { forEach(fn) { Object.entries(fields).forEach(([k, v]) => fn(v, k)); } },
		fetch: async url => {
			requests.push(new URL(url, 'https://example.com'));
			return new Response(JSON.stringify({ locations: [], meta: { radius_miles: Number(fields.radius || 5), origin_zip: fields.zip, approximate_origin: Boolean(fields.zip) } }));
		},
	});
	const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
	const browserSource = useStaticData
		? source.replace("import('/snapshot-search.mjs')", 'Promise.resolve(staticSearchModule)')
		: source.replaceAll('searchPublicLocations(state.lastLocationQuery)', "api('/api/locations?' + state.lastLocationQuery)");
	vm.runInContext(browserSource.replace('\tinitialize();', 'globalThis.testClient = { loadLocations, state };'), sandbox);
	return { api: sandbox.testClient, requests, node, setFetch: fn => { sandbox.fetch = fn; }, fields: value => { fields = value; } };
}

test('ZIP search defaults to five miles and explains its approximate origin', async () => {
	const app = client();
	app.fields({ zip: '16803' });
	await app.api.loadLocations();
	assert.equal(app.requests[0].searchParams.get('radius'), '5');
	assert.equal(app.requests[0].searchParams.get('zip'), '16803');
	assert.match(app.node('search-summary').textContent, /approximate center of ZIP 16803/);
});

test('changing distance and filters preserves the device search origin', async () => {
	const app = client();
	await app.api.loadLocations({ latitude: 40.8082, longitude: -77.8926 });
	app.fields({ zip: '', radius: '25', service: 'Food Pantry' });
	await app.api.loadLocations();
	assert.equal(app.requests.length, 2);
	assert.equal(app.requests[1].searchParams.get('radius'), '25');
	assert.equal(app.requests[1].searchParams.get('lat'), '40.808');
	assert.equal(app.requests[1].searchParams.get('service'), 'Food Pantry');
});

test('statewide search preserves filters and a new ZIP replaces its scope', async () => {
	const app = client();
	app.fields({ zip: '', radius: '5', service: 'Food Pantry' });
	await app.api.loadLocations({ all: true });
	app.fields({ zip: '', radius: '10', service: 'Food Bank' });
	await app.api.loadLocations();
	assert.equal(app.requests[1].searchParams.get('all'), 'true');
	assert.equal(app.requests[1].searchParams.get('service'), 'Food Bank');
	app.fields({ zip: '16803', radius: '10' });
	await app.api.loadLocations();
	assert.equal(app.requests[2].searchParams.get('zip'), '16803');
	assert.equal(app.requests[2].searchParams.has('all'), false);
});

test('a slow earlier search cannot replace the newest results', async () => {
	const app = client();
	const pending = [];
	app.setFetch(() => new Promise(resolve => pending.push(resolve)));
	app.fields({ zip: '16803', radius: '5' });
	const old = app.api.loadLocations();
	app.fields({ zip: '19104', radius: '5' });
	const newest = app.api.loadLocations();
	pending[1](new Response(JSON.stringify({ locations: [], meta: { origin_zip: '19104' } })));
	await newest;
	pending[0](new Response(JSON.stringify({ locations: [], meta: { origin_zip: '16803' } })));
	await old;
	assert.equal(app.api.state.searchMeta.origin_zip, '19104');
});

test('ZIP and device searches use only static assets when all APIs are unavailable', async () => {
	const app = client(true);
	const assets = [];
	app.setFetch(async path => {
		assert.ok(['/location-snapshot.json', '/zip-centers.json'].includes(path));
		assets.push(path);
		return new Response(readFileSync(new URL('../public' + path, import.meta.url)));
	});
	app.fields({ zip: '19104', radius: '5' });
	await app.api.loadLocations();
	assert.ok(app.api.state.locations.length > 0, app.node('results').innerHTML);
	assert.equal(app.api.state.searchMeta.approximate_origin, true);
	app.fields({ radius: '5', service: 'Food Pantry' });
	await app.api.loadLocations({ latitude: 39.96, longitude: -75.19 });
	assert.ok(app.api.state.locations.length > 0, app.node('results').innerHTML);
	assert.ok(app.api.state.locations.every(location => location.service_type === 'Food Pantry'));
	assert.deepEqual(assets.sort(), ['/location-snapshot.json', '/zip-centers.json']);
});

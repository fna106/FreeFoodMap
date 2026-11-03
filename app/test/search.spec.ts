import { applyD1Migrations, env, type D1Migration } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listLocations } from '../src';

const zipUrl = 'https://api.zippopotam.us/us/16803';
const search = async (query: string) => {
	const response = await listLocations(new Request('https://example.com/api/locations?' + query), env);
	return { response, body: await response.json<any>() };
};

beforeAll(async () => {
	await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
	for (const [id, latitude] of [[9001, 40.8082], [9002, 40.85], [9003, 40.92]]) {
		await env.DB.prepare(`INSERT INTO locations (id,name,normalized_name,address,normalized_address,zip_code,service_type,latitude,longitude)
			VALUES (?, 'Distance test pantry', 'distance test pantry', 'Test address', 'test address', '16802', 'Food Pantry', ?, -77.8926)`)
			.bind(id, latitude).run();
	}
});

beforeEach(async () => { await caches.default.delete(new Request(zipUrl)); });
afterEach(() => vi.restoreAllMocks());

function mockZip() {
	return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
		places: [{ latitude: '40.8082', longitude: '-77.8926' }],
	}), { headers: { 'content-type': 'application/json' } }));
}

describe('ZIP and nearby distance search', () => {
	it('finds locations across ZIP boundaries within five miles by default for 16803', async () => {
		mockZip();
		const { response, body } = await search('zip=16803');
		expect(response.status).toBe(200);
		expect(body.meta).toMatchObject({ radius_miles: 5, origin_zip: '16803', approximate_origin: true });
		const ids = body.locations.map((l: any) => l.id);
		expect(ids).toContain(83); // University Park, ZIP 16802
		expect(ids).toContain(9001);
		expect(ids).toContain(9002);
		expect(ids).not.toContain(9003);
		expect(body.locations.every((l: any) => l.distance_miles <= 5)).toBe(true);
		expect(body.locations.map((l: any) => l.distance_miles)).toEqual(body.locations.map((l: any) => l.distance_miles).sort((a: number, b: number) => a - b));
	});

	it('changes the radius and preserves the service filter', async () => {
		mockZip();
		const narrow = await search('zip=16803&radius=1&service=Food%20Pantry');
		expect(narrow.body.locations.map((l: any) => l.id)).toContain(9001);
		expect(narrow.body.locations.map((l: any) => l.id)).not.toContain(9002);
		const wide = await search('zip=16803&radius=10&service=Food%20Pantry');
		expect(wide.body.locations.map((l: any) => l.id)).toContain(9003);
		expect(wide.body.locations.every((l: any) => l.service_type === 'Food Pantry')).toBe(true);
	});

	it('caches ZIP coordinates across search variants', async () => {
		const fetch = mockZip();
		await search('zip=16803&radius=1');
		await search('zip=16803&radius=10');
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('keeps exact ZIP results available when the ZIP service fails and explains the limitation', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
		const { response, body } = await search('zip=16803');
		expect(response.status).toBe(200);
		expect(body.meta).toMatchObject({ zip_center_unavailable: true, radius_miles: null, mode: 'zip' });
		expect(body.locations).toEqual([]);
	});

	it('uses five miles for a device location without requesting ZIP coordinates', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch');
		const { body } = await search('lat=40.8082&lon=-77.8926');
		expect(body.meta.radius_miles).toBe(5);
		expect(body.locations.map((l: any) => l.id)).not.toContain(9003);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('rejects invalid radii and overlong ZIP codes', async () => {
		for (const query of ['zip=16803&radius=0', 'zip=16803&radius=101', 'zip=16803&radius=bad', 'zip=16803garbage']) {
			expect((await search(query)).response.status).toBe(400);
		}
	});
	it('retains an exact-ZIP listing with no coordinates without pretending its distance is zero', async () => {
		await env.DB.prepare("INSERT INTO locations(id,name,normalized_name,address,normalized_address,zip_code,service_type) VALUES(9010,'Unmapped','unmapped','Unknown building','unknown building','16803','Food Pantry')").run();
		try {
			mockZip();
			const { body } = await search('zip=16803&radius=5');
			expect(body.locations.find((l:any)=>l.id===9010).distance_miles).toBeNull();
			expect(body.meta.unmapped_count).toBeGreaterThan(0);
		} finally { await env.DB.prepare('DELETE FROM locations WHERE id=9010').run(); }
	});
});

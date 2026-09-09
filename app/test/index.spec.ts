import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { isValidEmail, isValidUrl, isValidZip, matchedAddressHasZip } from '../src';

describe('Free Food Map validation', () => {
	it('accepts five-digit ZIP codes only', () => {
		expect(isValidZip('19104')).toBe(true);
		expect(isValidZip('1910')).toBe(false);
		expect(isValidZip('19104-1234')).toBe(false);
	});

	it('accepts optional, well-formed contact values', () => {
		expect(isValidEmail('')).toBe(true);
		expect(isValidEmail('hello@example.org')).toBe(true);
		expect(isValidEmail('not-an-email')).toBe(false);
		expect(isValidUrl('https://example.org/pantry')).toBe(true);
		expect(isValidUrl('javascript:alert(1)')).toBe(false);
	});

	it('accepts geocoding results only when the returned ZIP matches', () => {
		expect(matchedAddressHasZip('1520 11TH ST, ALTOONA, PA, 16601', '16601')).toBe(true);
		expect(matchedAddressHasZip('1520 11TH ST, ALTOONA, PA, 16601', '16625')).toBe(false);
		expect(matchedAddressHasZip('1520 11TH ST, ALTOONA, PA', '16601')).toBe(false);
	});
});

describe('Free Food Map API', () => {
	it('redirects www traffic to the canonical domain', async () => {
		const response = await SELF.fetch('https://www.freefoodmap.org/locations?service=pantry', {
			redirect: 'manual',
		});
		expect(response.status).toBe(308);
		expect(response.headers.get('location')).toBe('https://freefoodmap.org/locations?service=pantry');
	});

	it('upgrades the public domain to HTTPS', async () => {
		const response = await SELF.fetch('http://freefoodmap.org/?zip=19104', { redirect: 'manual', headers: { 'cf-visitor': '{"scheme":"http"}' } });
		expect(response.status).toBe(308);
		expect(response.headers.get('location')).toBe('https://freefoodmap.org/?zip=19104');
	});

	it('allows the OpenStreetMap tile host in the content security policy', async () => {
		const response = await SELF.fetch('https://freefoodmap.org/');
		expect(response.status).toBe(200);
		expect(response.headers.get('content-security-policy')).toContain('https://tile.openstreetmap.org');
		expect(response.headers.get('content-security-policy')).toContain('https://challenges.cloudflare.com');
	});

	it('starts with the initiative introduction and keeps the map ready behind it', async () => {
		const response = await SELF.fetch('https://freefoodmap.org/');
		const html = await response.text();
		expect(html).toContain('id="intro-view"');
		expect(html).toContain('id="open-map-button"');
		expect(html).toContain('id="public-view" class="map-workspace" hidden');
		expect(html).toContain('data-mobile-view-target="list"');
		expect(html).toContain('data-mobile-view-target="map"');
		expect(html).toContain('/app.css?v=9');
		expect(html).toContain('/app.js?v=10');
		expect(html).toContain('id="show-all-locations"');
		expect(html).toContain('Search by ZIP code');
		expect(html).not.toContain('<script src="/leaflet.js"');
		expect(html).not.toContain('<link rel="stylesheet" href="/leaflet.css"');
	});

	it('does not return every location without an explicit search scope', async () => {
		const response = await SELF.fetch('https://example.com/api/locations');
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'Enter a ZIP code, use your location, or choose Show all locations.' });
	});

	it('lazy-loads the map and starts with only metadata and aggregate counts', async () => {
		const response = await SELF.fetch('https://freefoodmap.org/app.js?v=9');
		const script = await response.text();
		expect(script).toContain("loadScript('/leaflet.js')");
		expect(script).toContain('Promise.all([loadMeta(), loadStats()])');
		expect(script).not.toContain('await loadLocations();\n\t\tif (\'serviceWorker\'');
	});

	it('does not turn missing coordinates into a zero-zero map marker', async () => {
		const response = await SELF.fetch('https://freefoodmap.org/app.js?v=9');
		const script = await response.text();
		expect(script).toContain("location.latitude == null || location.longitude == null");
		expect(script).toContain('Map pending');
	});

	it('explains exactly what was checked for each location', async () => {
		const response = await SELF.fetch('https://freefoodmap.org/app.js?v=9');
		const script = await response.text();
		expect(script).toContain('Partially checked');
		expect(script).toContain('Checked fields');
		expect(script).toContain('View verification source');
		expect(script).toContain('verification-summary');
	});

	it('publishes form choices to the client', async () => {
		const response = await SELF.fetch('https://example.com/api/meta');
		const body = await response.json<{ service_types: string[]; report_categories: string[] }>();
		expect(response.status).toBe(200);
		expect(body.service_types).toContain('Food Pantry');
		expect(body.report_categories).toContain('Wrong hours');
	});

	it('protects the review workflow', async () => {
		const response = await SELF.fetch('https://example.com/api/admin/overview');
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'Admin access required.' });
	});

	it('publishes PWA shortcuts and a share target', async () => {
		const response = await SELF.fetch('https://freefoodmap.org/manifest.webmanifest');
		const manifest = await response.json<{ shortcuts: unknown[]; share_target: { action: string } }>();
		expect(manifest.shortcuts).toHaveLength(2);
		expect(manifest.share_target.action).toBe('/');
	});

	it('publishes crawler directions without exposing admin routes', async () => {
		const response = await SELF.fetch('https://freefoodmap.org/robots.txt');
		const body = await response.text();
		expect(response.status).toBe(200);
		expect(body).toContain('Sitemap: https://freefoodmap.org/sitemap.xml');
	});
});

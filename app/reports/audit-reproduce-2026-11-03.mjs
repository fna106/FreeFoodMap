// Read-only audit: all database changes occur in an in-memory SQLite database.
// Run from app/: node reports/audit-reproduce-2026-11-03.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
for (const file of readdirSync(new URL('migrations/', root)).filter(x => x.endsWith('.sql')).sort()) {
  db.exec(read('migrations/' + file));
}
console.log('All 8 migrations applied; integrity:', db.prepare('PRAGMA integrity_check').get());
console.log('Foreign key errors:', db.prepare('PRAGMA foreign_key_check').all());
console.log('Seed counts:', db.prepare("SELECT count(*) total, sum(status='active') active FROM locations").get());
console.log('Schedules:', db.prepare('SELECT count(DISTINCT location_id) locations, count(*) rows FROM location_operating_hours').get());
console.log('Contradictory seed schedules:', db.prepare(`SELECT l.id,l.name,l.hours,
  group_concat(h.day_of_week || ':' || h.opens_at || '-' || h.closes_at) schedule
  FROM locations l JOIN location_operating_hours h ON h.location_id=l.id
  WHERE l.id IN (143,319,324,410) GROUP BY l.id`).all());
console.log('Exact duplicate groups:', db.prepare(`SELECT normalized_name,normalized_address,zip_code,
  group_concat(id) ids FROM locations GROUP BY normalized_name,normalized_address,zip_code HAVING count(*)>1`).all());
const normalizer = vm.createContext({});
const normalizerSource = read('scripts/normalize-hours.mjs');
vm.runInContext(normalizerSource.slice(normalizerSource.indexOf('const dayNames'), normalizerSource.indexOf('function quote')), normalizer);
const mismatches = [];
for (const record of db.prepare('SELECT id,name,hours FROM locations WHERE id IN (SELECT location_id FROM location_operating_hours)').all()) {
  const generated = normalizer.normalizeRecord(record).rows.map(r => `${r.day}:${r.opens}-${r.closes}`).sort();
  const stored = db.prepare('SELECT day_of_week,opens_at,closes_at FROM location_operating_hours WHERE location_id=?').all(record.id).map(r => `${r.day_of_week}:${r.opens_at}-${r.closes_at}`).sort();
  if (JSON.stringify(generated) !== JSON.stringify(stored)) mismatches.push(record.id);
}
console.log('Stored schedules differing from current normalizer:', mismatches.length, 'of 172; IDs:', mismatches.join(','));

const DB = {
  prepare(sql) {
    let params = [];
    return {
      bind(...values) { params = values; return this; },
      async first() { return db.prepare(sql).get(...params) || null; },
      async all() { return { results: db.prepare(sql).all(...params) }; },
      async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    };
  },
  async batch(statements) { return Promise.all(statements.map(s => s.run())); },
};
const sandbox = vm.createContext({
  console, Request, Response, Headers, URL, crypto, TextEncoder, AbortSignal,
  caches: { default: { match: async () => undefined, put: async () => {} } },
  WorkflowEntrypoint: class {},
  fetch: async () => new Response('<html>' + 'Unrelated content. '.repeat(30) + '</html>', { headers: { 'content-type': 'text/html' } }),
});
let source = read('src/index.ts').replace(/^import .*;\r?\n/gm, '').replace('export default {', 'globalThis.worker = {');
source = source.replace(/export /g, '');
vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, sandbox);
const env = { DB, ADMIN_TOKEN: 'audit-only', ASSETS: { fetch: async () => new Response('asset') } };
const ctx = { waitUntil() {} };
const request = (path, body, method = 'PUT') => new Request('https://audit.invalid' + path, {
  method, headers: { authorization: 'Bearer audit-only', 'content-type': 'application/json' }, body: JSON.stringify(body),
});
async function fixture(name, test) {
  db.exec('SAVEPOINT audit');
  try { await test(); console.log('REPRODUCED:', name); }
  finally { db.exec('ROLLBACK TO audit; RELEASE audit'); }
}
const target = db.prepare('SELECT l.* FROM locations l JOIN location_operating_hours h ON h.location_id=l.id LIMIT 1').get();

await fixture('Editing hours leaves the old machine-readable schedule and verified claims', async () => {
  db.prepare("UPDATE locations SET verification_status='verified', verified_fields='name,address,hours', last_verified_at='2026-09-01' WHERE id=?").run(target.id);
  const before = db.prepare('SELECT * FROM location_operating_hours WHERE location_id=?').all(target.id);
  const response = await sandbox.updateLocation(request('/', { hours: 'By appointment only' }), env, target.id);
  assert.equal(response.status, 200);
  assert.deepEqual(db.prepare('SELECT * FROM location_operating_hours WHERE location_id=?').all(target.id), before);
  assert.equal(db.prepare('SELECT verification_status FROM locations WHERE id=?').get(target.id).verification_status, 'verified');
});

await fixture('Clearing coordinate fields retains old coordinates', async () => {
  await sandbox.updateLocation(request('/', { latitude: '', longitude: '' }), env, target.id);
  const after = db.prepare('SELECT latitude,longitude FROM locations WHERE id=?').get(target.id);
  assert.equal(after.latitude, target.latitude);
  assert.equal(after.longitude, target.longitude);
});

await fixture('Malformed JSON is returned as HTTP 500', async () => {
  const response = await sandbox.worker.fetch(new Request('https://audit.invalid/api/reports', { method: 'POST', body: '{' }), env, ctx);
  assert.equal(response.status, 500);
});

await fixture('ZIP validation silently truncates invalid long ZIPs', async () => {
  const response = await sandbox.listLocations(new Request('https://audit.invalid/api/locations?zip=19104garbage'), env);
  assert.equal(response.status, 200);
});

await fixture('Failed source checks leave verified records verified and due for another immediate check', async () => {
  db.prepare("UPDATE locations SET verification_status='verified', verification_source_url='https://example.org', verification_due_at='2026-01-01' WHERE id=?").run(target.id);
  const job = db.prepare("INSERT INTO verification_jobs(location_id,source_url) VALUES (?, 'https://example.org')").run(target.id);
  const result = await sandbox.performVerification(env, target.id, Number(job.lastInsertRowid));
  assert.equal(result.status, 'needs_review');
  const after = db.prepare('SELECT verification_status,verification_due_at FROM locations WHERE id=?').get(target.id);
  assert.equal(after.verification_status, 'verified');
  assert.equal(after.verification_due_at, '2026-01-01');
});

await fixture('Workflow creation failure strands a queued job and blocks retry', async () => {
  db.prepare("DELETE FROM verification_jobs WHERE location_id=?").run(target.id);
  db.prepare("UPDATE locations SET verification_source_url='https://example.org' WHERE id=?").run(target.id);
  let attempts = 0;
  const broken = { ...env, VERIFY_WORKFLOW: { create: async () => { attempts++; throw new Error('simulated outage'); } } };
  await assert.rejects(sandbox.queueLocationVerification(broken, target.id));
  await sandbox.queueLocationVerification(broken, target.id);
  assert.equal(attempts, 1);
  assert.equal(db.prepare('SELECT status FROM verification_jobs WHERE location_id=?').get(target.id).status, 'queued');
});

// Exercise the actual client search functions with a minimal DOM; no browser or network required.
let fields = { zip: '', q: '', service: 'Food Pantry', open_now: true };
const nodes = new Map();
const node = id => {
  if (!nodes.has(id)) nodes.set(id, { addEventListener() {}, querySelectorAll: () => [], querySelector: () => ({ textContent: '', className: '' }), focus() {}, reset() { fields = { zip: '', q: '', service: '', open_now: false }; }, dataset: {}, classList: { add() {}, toggle() {} } });
  return nodes.get(id);
};
const client = vm.createContext({
  console, URL, URLSearchParams, Map, Intl, Date,
  sessionStorage: { getItem: () => '' },
  document: { getElementById: node, querySelectorAll: () => [], addEventListener() {} },
  window: { addEventListener() {}, location: { hash: '' } },
  FormData: class { forEach(fn) { Object.entries(fields).forEach(([k,v]) => fn(v,k)); } },
  fetch: async url => { client.requests.push(url); return new Response(JSON.stringify({ locations: [] })); },
  requests: [],
});
vm.runInContext(read('public/app.js').replace('\tinitialize();', 'globalThis.audit = { loadLocations, state };'), client);
await client.audit.loadLocations({ latitude: 40, longitude: -77 });
assert.equal(client.requests.length, 1);
await client.audit.loadLocations();
assert.equal(client.requests.length, 1);
console.log('REPRODUCED: Nearby search scope is lost when submitting filters; client demands ZIP instead');

// Resolve two search requests out of order, as can happen on a slow connection.
const pending = [];
client.fetch = url => new Promise(resolve => pending.push({ url, resolve }));
fields = { zip: '19104' };
const firstSearch = client.audit.loadLocations();
fields = { zip: '19103' };
const secondSearch = client.audit.loadLocations();
pending[1].resolve(new Response(JSON.stringify({ locations: [{ id: 2, name: 'New search', address: 'B' }] })));
await secondSearch;
pending[0].resolve(new Response(JSON.stringify({ locations: [{ id: 1, name: 'Old search', address: 'A' }] })));
await firstSearch;
assert.equal(client.audit.state.locations[0].id, 1);
assert.match(client.audit.state.lastLocationQuery, /19103/);
console.log('REPRODUCED: A slower old search overwrites a newer search result');

const handlers = {};
const sw = vm.createContext({
  self: { addEventListener: (name, fn) => { handlers[name] = fn; }, location: { origin: 'https://audit.invalid' }, skipWaiting() {} },
  URL, fetch: async () => { throw new Error('offline'); },
  caches: { open: async () => ({ match: async () => undefined }) },
});
vm.runInContext(read('public/sw.js'), sw);
let offlineResponse;
handlers.fetch({ request: new Request('https://audit.invalid/api/meta'), respondWith: p => { offlineResponse = p; } });
await assert.rejects(offlineResponse, /offline/);
console.log('REPRODUCED: Metadata is not precached, so a first online visit followed by offline reload loses form choices');

console.log('Data warnings:', db.prepare("SELECT count(*) count FROM locations WHERE status='active' AND (latitude IS NULL OR longitude IS NULL)").get());
console.log('Audit completed. No production services contacted; no persistent database changed.');

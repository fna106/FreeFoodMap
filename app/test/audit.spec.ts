import { applyD1Migrations, env, createExecutionContext, type D1Migration } from 'cloudflare:test';
import { beforeAll, describe, it, expect, vi } from 'vitest';
import worker, { queueLocationVerification, performVerification, geocodeMissing } from '../src';
import { normalizeRecord } from '../src/hours.js';
beforeAll(async () => applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS));
const api = (path: string, method: string, body: string) => worker.fetch(new Request('https://example.com'+path, {method, body, headers:{authorization:'Bearer test-key','content-type':'application/json'}}), {...env, ADMIN_TOKEN:'test-key'}, createExecutionContext());
describe('audit regressions', () => {
 it('rotates failed geocoding attempts so later records are not starved', async () => {
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify({result:{addressMatches:[]}})));
  try {
   await geocodeMissing(env);
   const first=Number(await env.DB.prepare('SELECT COUNT(*) n FROM locations WHERE geocode_attempted_at IS NOT NULL').first('n'));
   expect(first).toBe(20);
   await geocodeMissing(env);
   const second=Number(await env.DB.prepare('SELECT COUNT(*) n FROM locations WHERE geocode_attempted_at IS NOT NULL').first('n'));
   expect(second).toBeGreaterThan(first);
  } finally { fetch.mockRestore(); }
 });
 it('lists missing map positions for admin review even without verification jobs', async () => {
  const response=await worker.fetch(new Request('https://example.com/api/admin/verification-jobs?category=mapping',{headers:{authorization:'Bearer test-key'}}),{...env,ADMIN_TOKEN:'test-key'},createExecutionContext());
  const data=await response.json<any>();
  expect(data.total).toBeGreaterThan(0);
  expect(data.verification_jobs.every((j:any)=>j.status==='needs_coordinates')).toBe(true);
 });
 it('allows retry when Workflow creation failed', async () => {
  await env.DB.prepare("UPDATE locations SET source_url='https://example.org' WHERE id=2").run();
  const create = vi.fn().mockRejectedValue(new Error('outage'));
  const testEnv = {...env, VERIFY_WORKFLOW:{create} as unknown as typeof env.VERIFY_WORKFLOW};
  await expect(queueLocationVerification(testEnv,2)).rejects.toThrow();
  await expect(queueLocationVerification(testEnv,2)).rejects.toThrow();
  expect(create).toHaveBeenCalledTimes(2);
 });
 it('moves unmatched verified records into review', async () => {
  await env.DB.prepare("UPDATE locations SET source_url='https://example.org',verification_source_url=NULL,verification_status='verified' WHERE id=3").run();
  const job=await env.DB.prepare("INSERT INTO verification_jobs(location_id,source_url) VALUES(3,'https://example.org')").run();
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('Unrelated source text '.repeat(40),{headers:{'content-type':'text/html'}}));
  try { await performVerification(env,3,Number(job.meta.last_row_id)); } finally { fetch.mockRestore(); }
  expect(await env.DB.prepare('SELECT verification_status FROM locations WHERE id=3').first('verification_status')).toBe('needs_review');
 });
 it('shows only the latest job per location, grouped and paginated', async () => {
  await env.DB.prepare("INSERT INTO verification_jobs(location_id,source_url,status) VALUES(4,'https://example.org','needs_review'),(4,'https://example.org','confirmed')").run();
  const r=await worker.fetch(new Request('https://example.com/api/admin/verification-jobs?category=confirmed',{headers:{authorization:'Bearer test-key'}}),{...env,ADMIN_TOKEN:'test-key'},createExecutionContext());
  const data=await r.json<any>();
  expect(data.verification_jobs.filter((j:any)=>j.location_id===4)).toHaveLength(1);
  expect(data.page_size).toBe(50);
 });
 it('keeps monthly, expired, mixed-purpose and split schedules out of Open now', async () => {
  for (const id of [143,319,324,410]) expect(await env.DB.prepare('SELECT COUNT(*) n FROM location_operating_hours WHERE location_id=?').bind(id).first('n')).toBe(0);
 });
 it('covers the last minute of a 24/7 day', () => expect(normalizeRecord({hours:'Open 24/7'}).rows.every(r=>r.closes==='24:00')).toBe(true));
 it('invalidates verification and machine schedules when hours change', async () => {
  await env.DB.prepare("UPDATE locations SET verification_status='verified', verified_fields='hours' WHERE id=1").run();
  const r=await api('/api/admin/locations/1','PUT',JSON.stringify({hours:'By appointment only',latitude:'',longitude:''}));
  expect(r.status).toBe(200);
  const row=await env.DB.prepare('SELECT * FROM locations WHERE id=1').first();
  expect(row?.verification_status).toBe('unverified'); expect(row?.verified_fields).toBeNull(); expect(row?.latitude).toBeNull();
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM location_operating_hours WHERE location_id=1').first('n')).toBe(0);
 });
 it('rejects malformed JSON as a client error', async () => expect((await api('/api/reports','POST','{')).status).toBe(400));
 it('rejects oversized bodies without relying on Content-Length', async () => expect((await api('/api/reports','POST',JSON.stringify({description:'x'.repeat(65000)}))).status).toBe(413));
 it('blocks repeated pending submissions with street spelling variations', async () => {
  const sql="INSERT INTO suggestions(name,normalized_name,address,normalized_address,zip_code,service_type,client_hash) VALUES('Test','test',?,?, '16803','Food Pantry','test')";
  expect((await env.DB.prepare(sql).bind('99999 Audit Street, State College','99999 audit street state college').run()).meta.changes).toBe(1);
  expect((await env.DB.prepare(sql).bind('99999 Audit St','99999 audit st').run()).meta.changes).toBe(0);
 });
});

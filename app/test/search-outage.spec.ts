import { env } from 'cloudflare:test';
import { describe,it,expect,vi } from 'vitest';
import { listLocations,snapshotLocations } from '../src';
const assets={fetch:async()=>new Response(JSON.stringify({snapshot_at:'2026-11-03T10:00:00Z',locations:[
 {id:1,name:'Test pantry',address:'Test',zip_code:'19104',service_type:'Food Pantry',latitude:39.96,longitude:-75.2,hours:'Monday-Friday 9am-5pm'},
 {id:2,name:'Unmapped pantry',address:'Unknown',zip_code:'19104',service_type:'Food Pantry',latitude:null,longitude:null},
 {id:3,name:'Far pantry',address:'Far',zip_code:'16803',service_type:'Food Pantry',latitude:40.8,longitude:-77.89}
]}))} as unknown as Fetcher;
describe('database outage search',()=>{
 it('returns a usable saved dataset when D1 exceeds its quota',async()=>{
  const db={prepare(){throw Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit.");}} as unknown as D1Database;
  const response=await listLocations(new Request('https://example.com/api/locations?lat=39.96&lon=-75.2&radius=5'),{...env,DB:db,ASSETS:assets});
  const data=await response.json<any>();
  expect(response.status).toBe(200);expect(data.locations.map((l:any)=>l.id)).toEqual([1]);expect(data.meta.using_saved_data).toBe(true);
 });
 it('keeps ZIP filtering and unknown map positions working during an outage',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify({places:[{latitude:'39.96',longitude:'-75.2'}]})));
  try {
   const response=await snapshotLocations(new Request('https://example.com/api/locations?zip=19104&radius=5'),{...env,ASSETS:assets});
   const data=await response.json<any>();expect(data.locations.map((l:any)=>l.id)).toEqual([1,2]);expect(data.locations[1].distance_miles).toBeNull();
  } finally {fetch.mockRestore();}
 });
 it('still validates requests instead of returning the entire snapshot',async()=>{
  expect((await snapshotLocations(new Request('https://example.com/api/locations'),{...env,ASSETS:assets})).status).toBe(400);
  expect((await snapshotLocations(new Request('https://example.com/api/locations?zip=19104&radius=invalid'),{...env,ASSETS:assets})).status).toBe(400);
 });
});

// Only public listings are read; only missing coordinate pairs can be updated.
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'csv-parse/sync';
import { loadPa211Services, pooled } from './pa211-source.mjs';
const apply = process.argv.includes('--apply');
if(process.argv.includes('--apply-reviewed')) {
 const report=JSON.parse(readFileSync('reports/missing-coordinate-repair-2026-11-03.json','utf8'));
 const quote=v=>"'"+String(v).replaceAll("'","''")+"'";
 const sql=[];
 for(const r of report.filter(r=>r.latitude!=null && r.longitude!=null)) {
  if(!Number.isInteger(r.id) || !/^\d{5}$/.test(r.original_zip) || !/^\d{5}$/.test(r.zip) || !(r.latitude>=39 && r.latitude<=43 && r.longitude>=-81 && r.longitude<=-74))throw Error('Invalid reviewed coordinate record');
  sql.push(`UPDATE locations SET latitude=${r.latitude},longitude=${r.longitude},updated_at=CURRENT_TIMESTAMP WHERE id=${r.id} AND zip_code=${quote(r.original_zip)} AND address=${quote(r.address)} AND (latitude IS NULL OR longitude IS NULL);`);
  const observed=JSON.stringify({latitude:r.latitude,longitude:r.longitude});
  const source=r.source.match(/https:\/\/\S+/)?.[0] || 'https://geocoding.geo.census.gov/geocoder/';
  sql.push(`INSERT INTO location_evidence(location_id,field_name,observed_value,source_url,status,note) SELECT id,'coordinates',${quote(observed)},${quote(source)},'confirmed',${quote(r.source+'; '+r.evidence)} FROM locations WHERE id=${r.id} AND latitude=${r.latitude} AND longitude=${r.longitude} AND NOT EXISTS(SELECT 1 FROM location_evidence WHERE location_id=${r.id} AND field_name='coordinates' AND observed_value=${quote(observed)});`);
 }
 const result=spawnSync(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'d1','execute','free-food-map-db','--remote','--json','--command',sql.join('\n')],{encoding:'utf8'});
 if(result.status!==0)throw Error(result.stderr||result.stdout);
 console.log(`Applied reviewed coordinate repairs for ${sql.length/2} locations, guarded against changed addresses.`);
 process.exit(0);
}
const records = (await (await fetch('https://freefoodmap.org/api/locations?all=true')).json()).locations;
const missing = records.filter(r=>r.latitude == null || r.longitude == null);
const key = value => String(value).split(',')[0].toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\b(street|avenue|road|drive|lane|circle|boulevard|highway|north|south|east|west)\b/g,w=>({street:'st',avenue:'ave',road:'rd',drive:'dr',lane:'ln',circle:'cir',boulevard:'blvd',highway:'hwy',north:'n',south:'s',east:'e',west:'w'}[w])).replace(/\s+/g,'');
const csv = value => '"'+String(value).replaceAll('"','""')+'"';
const lines = missing.map(r=>{
 const parts=r.address.split(',').map(s=>s.trim());
 return [r.id,parts[0],parts.length>=3?parts.at(-2):'','PA',r.zip_code].map(csv).join(',');
});
const form=new FormData();
form.set('addressFile',new Blob([lines.join('\n')],{type:'text/csv'}),'missing.csv');
form.set('benchmark','Public_AR_Current');
const response=await fetch('https://geocoding.geo.census.gov/geocoder/locations/addressbatch',{method:'POST',body:form,signal:AbortSignal.timeout(60000)});
if(!response.ok)throw Error('Census HTTP '+response.status);
const matches=new Map();
for(const row of parse(await response.text(),{relax_column_count:true,skip_empty_lines:true})) {
 if(String(row[2]).toLowerCase()!=='match')continue;
 const record=missing.find(r=>r.id===Number(row[0]));
 const zip=String(row[4]).match(/,\s*(\d{5})(?:-\d{4})?\s*$/)?.[1];
 const [longitude,latitude]=String(row[5]).split(',').map(Number);
 if(!record || key(record.address)!==key(row[4]) || !(latitude>=39 && latitude<=43 && longitude>=-81 && longitude<=-74))continue;
 let cityConfirmed=zip===record.zip_code;
 if(!cityConfirmed) {
  const city=String(row[4]).split(',').at(-3)?.trim().toLowerCase();
  const inputCity=record.address.split(',')[1]?.trim().toLowerCase();
  cityConfirmed=Boolean(city && inputCity===city);
  if(!cityConfirmed) try {
   const data=await (await fetch('https://api.zippopotam.us/us/'+record.zip_code,{signal:AbortSignal.timeout(8000)})).json();
   cityConfirmed=data.places?.some(p=>p['place name'].toLowerCase()===city) || false;
  }catch{}
 }
 if(cityConfirmed) matches.set(record.id,{latitude,longitude,zip,evidence:row[4],source:'U.S. Census exact street and confirmed city'});
}
if(process.argv.includes('--pa211')) {
 const services=await loadPa211Services();
	const centers=new Map(await pooled([...new Set(missing.map(r=>r.zip_code))],4,async zip=>{
		try { const data=await (await fetch('https://api.zippopotam.us/us/'+zip,{signal:AbortSignal.timeout(8000)})).json(); return [zip,data.places?.[0]]; } catch { return [zip,null]; }
	}));
 for(const r of missing) {
  if(matches.has(r.id))continue;
  const candidates=services.filter(s=>key(s.address)===key(r.address) && String(s.address).match(/\b\d{5}\b\s*$/)?.[0]?.trim()===r.zip_code && Array.isArray(s.location?.coordinates));
  if(!candidates.length)continue;
  const [longitude,latitude]=candidates[0].location.coordinates.map(Number);
  const center=centers.get(r.zip_code);
  const distance=center ? Math.hypot((latitude-Number(center.latitude))*69,(longitude-Number(center.longitude))*69*Math.cos(latitude*Math.PI/180)) : Infinity;
  if(distance<=10 && latitude>=39 && latitude<=43 && longitude>=-81 && longitude<=-74 && candidates.every(s=>Math.abs(Number(s.location.coordinates[0])-longitude)<0.001 && Math.abs(Number(s.location.coordinates[1])-latitude)<0.001)) matches.set(r.id,{latitude,longitude,zip:r.zip_code,evidence:candidates[0].address,source:'Pennsylvania 211 exact street and ZIP, plausible ZIP proximity https://search.pa211.org/search/'+candidates[0].id});
 }
}
// The one-line endpoint can match full city addresses that the ZIP-constrained batch rejects.
await pooled(missing.filter(r=>!matches.has(r.id)),4,async r=>{
 try {
  const url=new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
  url.search=new URLSearchParams({address:r.address+' '+r.zip_code,benchmark:'Public_AR_Current',format:'json'});
  const data=await (await fetch(url,{signal:AbortSignal.timeout(10000)})).json();
  for(const m of data.result?.addressMatches || []) {
   if(key(r.address)!==key(m.matchedAddress))continue;
   const city=m.addressComponents?.city?.toLowerCase();
   const returnedZip=m.addressComponents?.zip;
   let cityConfirmed=returnedZip===r.zip_code || r.address.split(',')[1]?.trim().toLowerCase()===city;
   if(!cityConfirmed)try {
    const postal=await (await fetch('https://api.zippopotam.us/us/'+r.zip_code,{signal:AbortSignal.timeout(8000)})).json();
    cityConfirmed=postal.places?.some(p=>p['place name'].toLowerCase()===city) || false;
   }catch{}
   const {x:longitude,y:latitude}=m.coordinates || {};
   if(cityConfirmed && /^\d{5}$/.test(returnedZip) && latitude>=39 && latitude<=43 && longitude>=-81 && longitude<=-74) { matches.set(r.id,{latitude,longitude,zip:returnedZip,evidence:m.matchedAddress,source:'U.S. Census exact street and confirmed city'}); break; }
  }
 }catch{}
});
for(const r of missing) {
 if(matches.has(r.id))continue;
 const peer=records.find(p=>p.latitude!=null && p.longitude!=null && p.zip_code===r.zip_code && key(p.address)===key(r.address));
 if(peer) matches.set(r.id,{latitude:peer.latitude,longitude:peer.longitude,evidence:peer.address,source:'Existing mapped identical street address and ZIP, ID '+peer.id});
}
const report=missing.map(r=>({id:r.id,name:r.name,address:r.address,original_zip:r.zip_code,zip:r.zip_code,...(matches.get(r.id)||{status:'needs_address_review'})}));
writeFileSync('reports/missing-coordinate-repair-2026-11-03.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({missing:missing.length,repairable:matches.size,unresolved:missing.length-matches.size,report:'reports/missing-coordinate-repair-2026-11-03.json'},null,2));
if(apply && matches.size) {
 const statements=[...matches].map(([id,m])=>{
  const r=missing.find(r=>r.id===id);
  const zipChange=m.zip && m.zip!==r.zip_code ? `zip_code='${m.zip}',verification_status='needs_review',verified_fields=NULL,` : '';
  return `UPDATE locations SET ${zipChange}latitude=${m.latitude},longitude=${m.longitude},updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND zip_code='${r.zip_code}' AND address='${r.address.replaceAll("'","''")}' AND (latitude IS NULL OR longitude IS NULL);`;
 }).join('\n');
 const result=spawnSync(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'d1','execute','free-food-map-db','--remote','--json','--command',statements],{encoding:'utf8'});
 if(result.status!==0)throw Error(result.stderr||result.stdout);
 console.log('Applied supported coordinate repairs.');
}

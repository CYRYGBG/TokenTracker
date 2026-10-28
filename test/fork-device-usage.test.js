const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const view = require('../src/lib/fork-view');
const {createDeviceImportStore} = require('../src/lib/sync-store/importer');
const {serializeDocument,parseDocument} = require('../src/lib/sync-store/format');

test('WebDAV device card matches merged summary, deduplicates account usage and retains idle devices',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tt-device-card-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'config.json'),JSON.stringify({machineId:'machine-local'}));
 const row=(source,n)=>({source,model:source==='cursor'?'cursor-auto':'gpt-5.4',hour_start:'2026-10-25T23:30:00Z',input_tokens:n,output_tokens:0,cached_input_tokens:0,cache_creation_input_tokens:0,total_tokens:n,billable_total_tokens:n});
 await fs.writeFile(path.join(dir,'queue.jsonl'),[row('codex',100),row('cursor',500)].map(JSON.stringify).join('\n')+'\n');
 const importsDir=path.join(dir,'webdav/imports');
 for(const [id,rows] of [['machine-remote',[row('codex',200),row('cursor',400)]],['machine-idle',[]]]){
  const store=createDeviceImportStore({importsDir,machineId:id});
  await store.saveDeviceInfo({name:id,platform:'win32',updated_at:'2026-10-26T00:00:00Z'});
  await store.applyDocument(parseDocument(serializeDocument({kind:'buckets',device:id,seq:1,rows})));
 }
 const card=await view.deviceUsage(dir,r=>r.hour_start.startsWith('2026-10-25'));
 assert.deepEqual(card.devices.map(d=>d.total_tokens),[100,0,200]);
 assert.equal(card.devices.find(d=>d.id==='machine-remote').platform,'win32');
 assert.equal(card.account_sources.find(d=>d.source==='cursor').total_tokens,500);
 const merged=await view.buckets(dir);
 const total=merged.reduce((sum,r)=>sum+r.total_tokens,0);
 assert.equal(card.devices.reduce((sum,d)=>sum+d.total_tokens,0)+card.account_sources.reduce((sum,d)=>sum+d.total_tokens,0),total);
 await fs.writeFile(path.join(dir,'fork-view.json'),JSON.stringify({device:'machine-remote'}));
 assert.equal((await view.deviceUsage(dir,()=>true)).device,'machine-remote');
 assert.ok((await view.deviceUsage(dir,()=>false)).devices.every(d=>d.total_tokens===0));
});

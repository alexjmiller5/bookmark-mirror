import {test,expect} from 'bun:test';
import {readBookmarkChanges, applyBookmarkChanges, readTags, captureBookmark} from '../extension/hub.js';
const cfg={endpoint:'https://hub.example',token:'test-only'};
const reply=(x,status=200)=>new Response(JSON.stringify(x),{status});
const at=n=>`2026-01-01T00:00:0${n}.000Z`;
// A hub answering the cursor and batched pulls from `rows` (each with hub_at).
function hubOf(rows,seen=[]) {
 return async(url,init)=>{
  expect(init.headers.Authorization).toBe('Bearer test-only');
  expect(init.redirect).toBe('error');
  seen.push(new URL(url).pathname);
  const live=rows();
  if(url.endsWith('/v1/cursor')) {
   const mark=live.reduce((m,r)=>r.hub_at>m?r.hub_at:m,'');
   return reply({tables:{bookmarks:mark},at_mark:{bookmarks:live.filter(r=>r.hub_at===mark).length},pull_batch:{items:50,rows:5000}});
  }
  const [item]=JSON.parse(init.body).batch;
  expect(item.table).toBe('bookmarks');
  return reply({batch:[{rows:live.filter(r=>!item.since || r.hub_at>=item.since),next_cursor:null}]});
 };
}
test('reads the whole table once, then only arrivals, and a quiet round is one cursor request',async()=>{
 let rows=[{id:'a',url:'https://a.example/',hub_at:at(1),deleted_at:null},{id:'b',url:'https://b.example/',hub_at:at(2),deleted_at:null}];
 const seen=[],transport=hubOf(()=>rows,seen);
 const first=await readBookmarkChanges(cfg,null,transport);
 expect(first.full).toBe(true);
 let mirror=applyBookmarkChanges([{id:'stale'}],first);
 expect(mirror.map(r=>r.id)).toEqual(['a','b']);
 expect(seen).toEqual(['/v1/cursor','/v1/rows/pull']);
 seen.length=0;
 const quiet=await readBookmarkChanges(cfg,first.state,transport);
 expect(seen).toEqual(['/v1/cursor']);
 expect(applyBookmarkChanges(mirror,quiet)).toEqual(mirror);
 rows=[{...rows[0],url:'https://a2.example/',hub_at:at(3)},{...rows[1],deleted_at:at(3),hub_at:at(3)},{id:'c',url:'https://c.example/',hub_at:at(3),deleted_at:null}];
 const later=await readBookmarkChanges(cfg,quiet.state,transport);
 mirror=applyBookmarkChanges(mirror,later);
 expect(mirror.map(r=>[r.id,r.url])).toEqual([['a','https://a2.example/'],['c','https://c.example/']]);
});
test('fails closed on hub refusals and malformed replies',async()=>{
 await expect(readBookmarkChanges(cfg,null,async()=>reply({},503))).rejects.toThrow('Hub request failed (503)');
 await expect(readBookmarkChanges(cfg,null,async()=>reply({}))).rejects.toThrow('Invalid bookmark response');
 await expect(readBookmarkChanges(cfg,null,async url=>url.endsWith('/v1/cursor')
  ? reply({tables:{bookmarks:at(1)},pull_batch:{items:50,rows:5000}}) : reply({batch:[{rows:[],next_cursor:'a'}]}))).rejects.toThrow('Invalid bookmark response');
});
test('reads only the authorized static tag choices',async()=>{
 expect(await readTags(cfg,async url=>{expect(url).toEndWith('/v1/catalog/options?table=bookmarks&column=tags');return reply({options:[{v:'Research',d:'Study'}]});})).toEqual(['Research']);
});
test('capture updates existing live URL sparsely, preserves existing tags and checks rejection',async()=>{
 const input={url:'https://example.com',title:'Page title',description:'A useful resource.',tags:['Research']};
 let body;
 const transport=async(url,init)=>{
  if(url.endsWith('/pull'))return reply({rows:[body ? {...body.rows[0],tags:JSON.stringify(body.rows[0].tags),deleted_at:null} : {id:'existing',url:input.url,tags:'["Existing"]',deleted_at:null}],next_cursor:null});
  body=JSON.parse(init.body);return reply({rejected:[]});
 };
 await captureBookmark(cfg,input,transport);
 expect(body.rows[0]).toMatchObject({id:'existing',title:'Page title',description:'A useful resource',tags:['Existing','Research']});
 expect(body.rows[0].updated_at).toMatch(/^\d{4}-.*Z$/);
 await expect(captureBookmark(cfg,input,async(url)=>url.endsWith('/pull')?reply({rows:[],next_cursor:null}):reply({rejected:[{message:'No write permission'}]}))).rejects.toThrow('No write permission');
});
test('requires HTTPS endpoint and ordinary web bookmark URLs',async()=>{
 await expect(readBookmarkChanges({...cfg,endpoint:'http://public.example'},null)).rejects.toThrow();
 await expect(captureBookmark(cfg,{url:'javascript:alert(1)',title:'x',description:'x',tags:[]})).rejects.toThrow();
});

const captureInput={url:'https://example.com/capture',title:'Saved title',description:'Saved description',tags:['Research','Reading']};
function captureTransport(change = row => row) {
 let stored;
 return async (url,init) => {
  const body=JSON.parse(init.body);
  if(url.endsWith('/push')) {
   stored=change({...body.rows[0],deleted_at:null});
   return reply({upserted:1,rejected:[],hub_at:'2026-01-01T00:00:00.000Z'});
  }
  return reply({rows:stored ? [stored] : [],next_cursor:null});
 };
}
for(const [name,change] of [
 ['missing',()=>null],
 ['wrong ID',row=>({...row,id:'another-row'})],
 ['wrong URL',row=>({...row,url:'https://example.com/other'})],
 ['wrong title',row=>({...row,title:'Old title'})],
 ['wrong description',row=>({...row,description:'Old description'})],
 ['missing tag',row=>({...row,tags:['Research']})],
 ['extra tag',row=>({...row,tags:[...row.tags,'Other']})],
 ['tombstone',row=>({...row,deleted_at:'2026-01-01T00:00:00.000Z'})],
]) test(`capture refuses an accepted receipt whose persisted row is ${name}`,async()=>{
 await expect(captureBookmark(cfg,captureInput,captureTransport(change))).rejects.toThrow('confirm');
});
test('capture confirms JSON-encoded tags by membership rather than ordering',async()=>{
 const result=await captureBookmark(cfg,captureInput,captureTransport(row=>({...row,tags:JSON.stringify([...row.tags].reverse())})));
 expect(typeof result.id).toBe('string');
});
test('capture detects a silent LWW no-op against a future revision',async()=>{
 const stored={id:'future',...captureInput,title:'Original title',updated_at:'2099-01-01T00:00:00.000Z',deleted_at:null};
 const transport=async url=>url.endsWith('/push') ? reply({upserted:1,rejected:[],hub_at:stored.updated_at}) : reply({rows:[stored],next_cursor:null});
 await expect(captureBookmark(cfg,captureInput,transport)).rejects.toThrow('confirm');
});
test('capture does not confirm a write when readback fails',async()=>{
 let pushed=false;
 await expect(captureBookmark(cfg,captureInput,async url=>{
  if(url.endsWith('/push')){pushed=true;return reply({upserted:1,rejected:[]});}
  return pushed ? reply({},503) : reply({rows:[],next_cursor:null});
 })).rejects.toThrow();
});

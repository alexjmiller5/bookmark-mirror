import {test,expect} from 'bun:test';
import {readBookmarks, readTags, captureBookmark} from '../extension/hub.js';
const cfg={endpoint:'https://hub.example',token:'test-only'};
const reply=(x,status=200)=>new Response(JSON.stringify(x),{status});
test('reads every page before returning a snapshot, with scoped bearer auth',async()=>{
 let n=0;
 const rows=await readBookmarks(cfg,async(url,init)=>{
  expect(init.headers.Authorization).toBe('Bearer test-only');
  const b=JSON.parse(init.body);expect(b.table).toBe('bookmarks');
  expect(b.after).toBe(n? 'a':undefined);
  return n++?reply({rows:[{id:'b'}],next_cursor:null}):reply({rows:[{id:'a'}],next_cursor:'a'});
 });
 expect(rows.map(x=>x.id)).toEqual(['a','b']);
});
test('fails closed on partial reads, malformed replies and cursor cycles',async()=>{
 let n=0;
 await expect(readBookmarks(cfg,async()=>n++?reply({},503):reply({rows:[{id:'a'}],next_cursor:'a'}))).rejects.toThrow('503');
 await expect(readBookmarks(cfg,async()=>reply({}))).rejects.toThrow();
 await expect(readBookmarks(cfg,async()=>reply({rows:[],next_cursor:'a'}))).rejects.toThrow();
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
 await expect(readBookmarks({...cfg,endpoint:'http://public.example'})).rejects.toThrow();
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

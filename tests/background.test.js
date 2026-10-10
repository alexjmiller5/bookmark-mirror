import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {syncMirror} from '../extension/mirror.js';
import {endpointURL, readBookmarks, readTags, captureBookmark} from '../extension/hub.js';

const source=readFileSync(new URL('../extension/background.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const input={type:'capture',url:'https://example.com/saved',title:'Saved title',description:'Saved description',tags:['Reading']};
function background({save=true,failStatus=false,mirror=false,onMirrorCreate,rows=[],rejectHost,data={connection:{endpoint:'https://hub.example',token:'test-only'},syncStatus:{bookmarks:7,lastSync:'2026-01-01T00:00:00.000Z'}}}={}) {
 let listener,createdListener,changedListener,removedListener,stored,badge,treeReads=0,pushes=0,nextId=0;
 const nodes=new Map([['0',{id:'0',title:''}],['1',{id:'1',parentId:'0',title:'Bookmarks bar',folderType:'bookmarks-bar'}],['historical',{id:'historical',parentId:'1',title:'Historical',url:'https://example.com/historical'}]]);
 const tree=id=>({...nodes.get(id),children:[...nodes.values()].filter(n=>n.parentId===id).map(n=>tree(n.id))});
 const native=node=>{nodes.set(node.id,{parentId:'1',...node});createdListener?.(node.id,structuredClone(nodes.get(node.id)));};
 const change=(id,info)=>{if(nodes.has(id))Object.assign(nodes.get(id),info);changedListener?.(id,structuredClone(info));};
 const remove=id=>{nodes.delete(id);removedListener?.(id,{});};
 const transport=async (url,init)=>{
  if(rejectHost && url.startsWith(rejectHost))return Response.json({error:'forbidden'},{status:403});
  if(url.includes('/catalog/options'))return Response.json({options:[{v:'Reading'}]});
  const body=JSON.parse(init.body);
  if(url.endsWith('/push')){
   pushes++;
   if(save)stored={...body.rows[0],deleted_at:null};
   return Response.json({upserted:1,rejected:[]});
  }
  const all=[...rows,...(stored?[stored]:[])];
  return Response.json({rows:all.filter(row=>!body.where || Object.entries(body.where).every(([k,v])=>row[k]===v)),next_cursor:null});
 };
 const chrome={
  storage:{local:{
   async setAccessLevel(){},
   async get(keys){
    if(failStatus && treeReads)throw new Error('Storage unavailable');
    return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,structuredClone(data[key])]));
   },
   async set(values){Object.assign(data,structuredClone(values));},
  }},
  bookmarks:{
   onCreated:{addListener(fn){createdListener=fn;}},
   onChanged:{addListener(fn){changedListener=fn;}},
   onRemoved:{addListener(fn){removedListener=fn;}},
   async getTree(){treeReads++;if(!mirror)throw new Error('Bookmarks unavailable');return [tree('0')];},
   async create(details){const node={id:'mirror-'+(++nextId),...details};native(node);onMirrorCreate?.(node,native);return structuredClone(node);},
   async update(id,changes){change(id,changes);return structuredClone(nodes.get(id));},
   async remove(id){remove(id);},
  },
  action:{async setBadgeText({text}){badge=text;}},
  runtime:{id:'fixture',getURL:path=>'chrome-extension://fixture/'+path,
   onMessage:{addListener(fn){listener=fn;}},onInstalled:{addListener(){}},onStartup:{addListener(){}}},
  alarms:{onAlarm:{addListener(){}},async create(){}},
  permissions:{async contains(){return true;}},
 };
 runInNewContext(source,{chrome,syncMirror,endpointURL,
  readBookmarks:c=>readBookmarks(c,transport),readTags:c=>readTags(c,transport),
  captureBookmark:(c,message)=>captureBookmark(c,message,transport),URL});
 return {data,native,change,remove,get pushes(){return pushes;},get stored(){return stored;},get badge(){return badge;},get treeReads(){return treeReads;},
  send:message=>new Promise(resolve=>listener(message,{id:'fixture',url:'chrome-extension://fixture/popup.html'},resolve))};
}

test('confirmed capture remains successful when mirroring fails and reports the sync error',async()=>{
 const app=background();
 const result=await app.send(input);
 expect(app.stored).toMatchObject({title:'Saved title',description:'Saved description',tags:['Reading']});
 expect(result).toMatchObject({ok:true,configured:true,status:{bookmarks:7,error:'Bookmarks unavailable'}});
 expect(app.data.syncStatus.error).toBe('Bookmarks unavailable');
 expect(app.badge).toBe('!');
});

test('unconfirmed capture fails without starting a mirror sync',async()=>{
 const app=background({save:false});
 const result=await app.send(input);
 expect(result.ok).toBe(false);
 expect(result.error).toContain('confirm');
 expect(app.treeReads).toBe(0);
});

test('explicit sync still fails when mirroring fails',async()=>{
 const app=background();
 const result=await app.send({type:'sync'});
 expect(result).toEqual({ok:false,error:'Bookmarks unavailable'});
});

test('confirmed capture stays successful even if sync error status cannot be stored or read',async()=>{
 const app=background({failStatus:true});
 const result=await app.send(input);
 expect(result.ok).toBe(true);
 expect(result.status.error).toBe('Storage unavailable');
});


const nativeBookmark={id:'native-1',url:'https://example.com/native',title:'Native bookmark'};
test('new native bookmarks persist across worker restart, deduplicate by ID, and never import history or write source',async()=>{
 const app=background({mirror:true});
 expect((await app.send({type:'status'})).pendingCaptures).toEqual([]);
 app.native(nativeBookmark);
 app.native(nativeBookmark);
 const result=await app.send({type:'status'});
 expect(result.pendingCaptures).toEqual([nativeBookmark]);
 expect(app.data.pendingCaptures).toEqual([nativeBookmark]);
 expect(app.badge).toBe('1');
 expect(app.pushes).toBe(0);
 const restarted=background({data:app.data,mirror:true});
 expect((await restarted.send({type:'status'})).pendingCaptures).toEqual([nativeBookmark]);
 expect(restarted.badge).toBe('1');
 expect(restarted.pushes).toBe(0);
});

test('queue accepts only configured ordinary HTTP(S) creations',async()=>{
 const app=background();
 for(const node of [{id:'folder',title:'Folder'},
  {id:'script',url:'javascript:alert(1)'},{id:'internal',url:'chrome://settings'},
  {id:'invalid',url:'not a URL'},{id:'userinfo',url:'https://user:password@example.com/'}])app.native(node);
 expect((await app.send({type:'status'})).pendingCaptures).toEqual([]);
 const offline=background({data:{}});
 offline.native(nativeBookmark);
 expect((await offline.send({type:'status'})).pendingCaptures).toEqual([]);
 expect(offline.pushes).toBe(0);
 app.native({...nativeBookmark,url:'http://example.com/native'});
 expect((await app.send({type:'status'})).pendingCaptures).toHaveLength(1);
});

test('queued creation events see final mirror ownership and retain user bookmarks created during sync',async()=>{
 let emitted=false;
 const app=background({mirror:true,rows:[{id:'row-1',url:'https://example.com/mirrored',title:'Mirrored',tags:['Reading'],deleted_at:null}],
  onMirrorCreate(node,native){if(node.url && !emitted){emitted=true;native(nativeBookmark);}}
 });
 expect((await app.send({type:'sync'})).ok).toBe(true);
 expect((await app.send({type:'status'})).pendingCaptures).toEqual([nativeBookmark]);
 expect(app.data.mirrorState.links).toHaveLength(1);
 expect(app.badge).toBe('1');
 expect(app.pushes).toBe(0);
 const owned=app.data.mirrorState.links[0];
 const restarted=background({mirror:true,data:app.data});
 restarted.native({id:owned.id,url:owned.url,title:owned.title});
 expect((await restarted.send({type:'status'})).pendingCaptures).toEqual([nativeBookmark]);
});

test('sync errors take badge precedence; a successful sync restores the pending count',async()=>{
 const app=background();
 app.native(nativeBookmark);
 await app.send({type:'sync'});
 expect(app.badge).toBe('!');
 app.native({...nativeBookmark,id:'native-2'});
 expect((await app.send({type:'status'})).pendingCaptures).toHaveLength(2);
 expect(app.badge).toBe('!');
 const recovered=background({data:app.data,mirror:true});
 expect((await recovered.send({type:'sync'})).ok).toBe(true);
 expect(recovered.badge).toBe('2');
});

test('only successful explicit matching capture acknowledges a pending bookmark despite mirror failure',async()=>{
 const app=background();
 app.native({...nativeBookmark,url:input.url});
 app.native({...nativeBookmark,id:'native-2',url:input.url});
 const result=await app.send({...input,bookmarkId:nativeBookmark.id});
 expect(result.ok).toBe(true);
 expect(result.status.error).toBe('Bookmarks unavailable');
 expect(result.pendingCaptures).toEqual([{...nativeBookmark,id:'native-2',url:input.url}]);
 expect(app.data.pendingCaptures).toEqual(result.pendingCaptures);
 expect(app.badge).toBe('!');
});

for(const mode of ['unconfirmed','no ID','wrong URL'])test(`pending entry survives capture with ${mode}`,async()=>{
 const app=background({save:mode!=='unconfirmed'});
 const pending={...nativeBookmark,url:mode==='wrong URL'?nativeBookmark.url:input.url};
 app.native(pending);
 const result=await app.send({...input,...(mode==='no ID'?{}:{bookmarkId:nativeBookmark.id})});
 expect(result.ok).toBe(mode!=='unconfirmed');
 expect((await app.send({type:'status'})).pendingCaptures).toEqual([pending]);
});

test('acknowledged capture and successful mirror clear the pending badge without requeueing the mirror copy',async()=>{
 const app=background({mirror:true});
 app.native({...nativeBookmark,url:input.url});
 const result=await app.send({...input,bookmarkId:nativeBookmark.id});
 expect(result.ok).toBe(true);
 expect(result.pendingCaptures).toEqual([]);
 expect((await app.send({type:'status'})).pendingCaptures).toEqual([]);
 expect(app.badge).toBe('');
 expect(app.pushes).toBe(1);
});


test('native removal clears only the matching pending ID, persists, and clears its badge',async()=>{
 const app=background();
 app.native(nativeBookmark);
 app.native({...nativeBookmark,id:'second'});
 app.remove(nativeBookmark.id);
 expect((await app.send({type:'status'})).pendingCaptures).toEqual([{...nativeBookmark,id:'second'}]);
 expect(app.badge).toBe('1');
 app.remove('second');
 expect((await app.send({type:'status'})).pendingCaptures).toEqual([]);
 expect(app.data.pendingCaptures).toEqual([]);
 expect(app.badge).toBe('');
 expect(app.pushes).toBe(0);
 const restarted=background({data:app.data});
 expect((await restarted.send({type:'status'})).pendingCaptures).toEqual([]);
});

test('pending URL and title edits preserve absent fields and survive restart without source writes',async()=>{
 const app=background();
 app.native(nativeBookmark);
 app.change(nativeBookmark.id,{url:'http://example.com/edited'});
 expect((await app.send({type:'status'})).pendingCaptures).toEqual([{...nativeBookmark,url:'http://example.com/edited'}]);
 app.change(nativeBookmark.id,{title:'New title'});
 expect((await app.send({type:'status'})).pendingCaptures).toEqual([{...nativeBookmark,url:'http://example.com/edited',title:'New title'}]);
 app.change(nativeBookmark.id,{title:''});
 expect((await app.send({type:'status'})).pendingCaptures[0].title).toBe('');
 const restarted=background({data:app.data});
 expect((await restarted.send({type:'status'})).pendingCaptures).toEqual([{...nativeBookmark,url:'http://example.com/edited',title:''}]);
 expect(restarted.badge).toBe('1');
 expect(app.pushes).toBe(0);
});

for(const url of ['javascript:alert(1)','chrome://settings','not a URL','https://user:password@example.com/','https://user@example.com/',''])test(`unsupported pending URL edit removes the candidate: ${url}`,async()=>{
 const app=background();
 app.native(nativeBookmark);
 app.change(nativeBookmark.id,{url});
 expect((await app.send({type:'status'})).pendingCaptures).toEqual([]);
 expect(app.badge).toBe('');
 expect(app.pushes).toBe(0);
});

test('edits never adopt historical or managed bookmarks or re-adopt a removed candidate',async()=>{
 const app=background({mirror:true,rows:[{id:'row-1',url:'https://example.com/mirrored',title:'Mirrored',tags:['Reading'],deleted_at:null}]});
 await app.send({type:'sync'});
 app.change('historical',{url:'https://example.com/new-history',title:'Edited history'});
 app.change(app.data.mirrorState.links[0].id,{url:'https://example.com/managed-edit'});
 app.native(nativeBookmark);
 app.change(nativeBookmark.id,{url:'chrome://settings'});
 app.change(nativeBookmark.id,{url:nativeBookmark.url});
 expect((await app.send({type:'status'})).pendingCaptures).toEqual([]);
 expect(app.pushes).toBe(0);
});

test('edits and removals during sync follow queued creations and retain error badge precedence',async()=>{
 let emitted=false;
 const app=background({mirror:true,rows:[{id:'row-1',url:'https://example.com/mirrored',title:'Mirrored',tags:['Reading'],deleted_at:null}],
  onMirrorCreate(node,native){if(node.url && !emitted){
   emitted=true;native(nativeBookmark);app.change(nativeBookmark.id,{url:'https://example.com/edited'});
   native({...nativeBookmark,id:'removed'});app.remove('removed');
  }}
 });
 await app.send({type:'sync'});
 expect((await app.send({type:'status'})).pendingCaptures).toEqual([{...nativeBookmark,url:'https://example.com/edited'}]);
 app.data.syncStatus.error='Sync failed';
 app.change(nativeBookmark.id,{title:'Edited'});
 await app.send({type:'status'});
 expect(app.badge).toBe('!');
 app.remove(nativeBookmark.id);
 expect((await app.send({type:'status'})).pendingCaptures).toEqual([]);
 expect(app.badge).toBe('!');
 expect(app.pushes).toBe(0);
});

test('an installation follows its own credential to the hub under a new address',async()=>{
 const b=background({mirror:true});
 const result=await b.send({type:'configure',endpoint:'https://soma.example',token:''});
 expect(result).toMatchObject({ok:true,configured:true});
 expect(b.data.connection).toEqual({endpoint:'https://soma.example',token:'test-only'});
});
test('a new credential cannot point an installation at another hub',async()=>{
 const b=background({mirror:true});
 const result=await b.send({type:'configure',endpoint:'https://other.example',token:'other-token'});
 expect(result).toMatchObject({ok:false,error:'This installation already mirrors another hub. Use a separate Chrome profile for another source.'});
 expect(b.data.connection).toEqual({endpoint:'https://hub.example',token:'test-only'});
});
test('a new address that rejects the stored credential keeps the working connection',async()=>{
 const b=background({mirror:true,rejectHost:'https://rejects.example'});
 const result=await b.send({type:'configure',endpoint:'https://rejects.example',token:''});
 expect(result.ok).toBe(false);
 expect(b.data.connection).toEqual({endpoint:'https://hub.example',token:'test-only'});
});

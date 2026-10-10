import {syncMirror} from './mirror.js';
import {endpointURL, readBookmarks, readTags, captureBookmark} from './hub.js';

const ALARM = 'bookmark-mirror-sync';
let queue = Promise.resolve();
const enqueue = action => {
  const next = queue.then(action, action);
  queue = next.catch(() => {});
  return next;
};
const trustedStorage = chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
async function config() {
  await trustedStorage;
  return (await chrome.storage.local.get('connection')).connection ?? {};
}
async function status() {
  const c = await config();
  const {syncStatus = {}, tagChoices = [], pendingCaptures = []} = await chrome.storage.local.get(['syncStatus','tagChoices','pendingCaptures']);
  return {ok:true,configured:!!(c.endpoint && c.token),status:syncStatus,tags:tagChoices,pendingCaptures};
}
async function updateBadge() {
  await trustedStorage;
  const {syncStatus = {}, pendingCaptures = []} = await chrome.storage.local.get(['syncStatus','pendingCaptures']);
  await chrome.action.setBadgeText({text:syncStatus.error ? '!' : pendingCaptures.length ? String(pendingCaptures.length) : ''});
}
async function reportError(e) {
  const {syncStatus = {}} = await chrome.storage.local.get('syncStatus');
  await chrome.storage.local.set({syncStatus:{...syncStatus,error:e.message}});
  await updateBadge();
}
function captureURL(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['http:','https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
async function queueCapture(id, node) {
  const c = await config();
  if (!c.endpoint || !c.token || typeof id !== 'string' || !id || !captureURL(node?.url)) return;
  // This runs after the sync that emitted the event has persisted ownership.
  // User creations during that sync still reach this same per-ID check.
  const {mirrorState, pendingCaptures = []} = await chrome.storage.local.get(['mirrorState','pendingCaptures']);
  if (mirrorState?.links?.some(link=>link.id===id) || pendingCaptures.some(item=>item.id===id)) return;
  await chrome.storage.local.set({pendingCaptures:[...pendingCaptures,{id,url:node.url,title:node.title || node.url}]});
  await updateBadge();
}
async function updatePendingCapture(id, changes) {
  await trustedStorage;
  const {pendingCaptures = []} = await chrome.storage.local.get('pendingCaptures');
  if (!pendingCaptures.some(item=>item.id===id)) return;
  const updated = pendingCaptures.flatMap(item=>{
    if (item.id !== id) return [item];
    if (changes === null) return [];
    const next = {id, url:changes.url ?? item.url, title:changes.title ?? item.title};
    return captureURL(next.url) ? [next] : [];
  });
  await chrome.storage.local.set({pendingCaptures:updated});
  await updateBadge();
}
async function sync() {
  const c = await config();
  if (!c.token) throw new Error('Connect your hub in Settings first.');
  try {
    // Neither incomplete data nor failed tag reads may alter the bookmark tree.
    const [rows, tags] = await Promise.all([readBookmarks(c), readTags(c)]);
    const result = await syncMirror({bookmarks:chrome.bookmarks, storage:chrome.storage.local},rows);
    await chrome.storage.local.set({tagChoices:tags,syncStatus:{...result,lastSync:new Date().toISOString(),error:null}});
    await updateBadge();
    return status();
  } catch (e) {
    await reportError(e);
    throw e;
  }
}
async function dispatch(message) {
  if (message.type === 'status') return status();
  if (message.type === 'sync') return sync();
  if (message.type === 'configure') {
    const endpoint = endpointURL(message.endpoint);
    if (!(await chrome.permissions.contains({origins:[new URL(endpoint).origin+'/*']}))) throw new Error('Allow access to your hub to connect.');
    const previous = await config();
    const token = message.token?.trim() || previous.token;
    if (!token) throw new Error('Enter your bookmark-scoped token.');
    // A hub may move to a new address: the credential it issued still opens it
    // there, so an installation follows its own credential (validated below)
    // and only a new credential counts as another source.
    if (previous.endpoint && previous.endpoint !== endpoint && message.token?.trim()) throw new Error('This installation already mirrors another hub. Use a separate Chrome profile for another source.');
    const candidate = {endpoint,token};
    // Validate before replacing a working connection.
    await Promise.all([readBookmarks(candidate),readTags(candidate)]);
    await chrome.storage.local.set({connection:candidate});
    await chrome.alarms.create(ALARM,{periodInMinutes:5});
    return sync();
  }
  if (message.type === 'capture') {
    const c = await config();
    await captureBookmark(c,message);
    try {
      if (typeof message.bookmarkId === 'string') {
        const {pendingCaptures = []} = await chrome.storage.local.get('pendingCaptures');
        await chrome.storage.local.set({pendingCaptures:pendingCaptures.filter(item=>!(item.id===message.bookmarkId && item.url===message.url))});
        await updateBadge();
      }
      return await sync();
    }
    catch (e) {
      // Persistence is confirmed. A subsequent mirror/status failure cannot
      // turn that successful capture into a failed save.
      const out = await status().catch(()=>({ok:true,configured:true,status:{},tags:[],pendingCaptures:[]}));
      return {...out,status:{...out.status,error:e.message}};
    }
  }
  throw new Error('Unknown request.');
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  enqueue(()=>dispatch(message)).then(reply,e=>reply({ok:false,error:e.message}));
  return true;
});
function enqueueBookmarkEvent(action) {
  void enqueue(async()=>{
    try { await action(); }
    catch (e) { await reportError(e); }
  }).catch(()=>{});
}
chrome.bookmarks.onCreated.addListener((id,node)=>enqueueBookmarkEvent(()=>queueCapture(id,node)));
chrome.bookmarks.onChanged.addListener((id,changes)=>enqueueBookmarkEvent(()=>updatePendingCapture(id,changes)));
chrome.bookmarks.onRemoved.addListener(id=>enqueueBookmarkEvent(()=>updatePendingCapture(id,null)));
async function start() {
  await trustedStorage;
  await chrome.alarms.create(ALARM,{periodInMinutes:5});
  if ((await config()).token) await enqueue(sync).catch(()=>{});
}
chrome.runtime.onInstalled.addListener(()=>{void start();});
chrome.runtime.onStartup.addListener(()=>{void start();});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM)void enqueue(sync).catch(()=>{});});
// Restore the persistent queue's badge on every service-worker activation.
void enqueue(updateBadge).catch(()=>{});

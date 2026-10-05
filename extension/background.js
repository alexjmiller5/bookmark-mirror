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
  const {syncStatus = {}, tagChoices = []} = await chrome.storage.local.get(['syncStatus','tagChoices']);
  const c = await config();
  return {ok:true,configured:!!(c.endpoint && c.token),status:syncStatus,tags:tagChoices};
}
async function sync() {
  const c = await config();
  if (!c.token) throw new Error('Connect your hub in Settings first.');
  try {
    // Neither incomplete data nor failed tag reads may alter the bookmark tree.
    const [rows, tags] = await Promise.all([readBookmarks(c), readTags(c)]);
    const result = await syncMirror({bookmarks:chrome.bookmarks, storage:chrome.storage.local},rows);
    await chrome.storage.local.set({tagChoices:tags,syncStatus:{...result,lastSync:new Date().toISOString(),error:null}});
    await chrome.action.setBadgeText({text:''});
    return status();
  } catch (e) {
    const {syncStatus = {}} = await chrome.storage.local.get('syncStatus');
    await chrome.storage.local.set({syncStatus:{...syncStatus,error:e.message}});
    await chrome.action.setBadgeText({text:'!'});
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
    if (previous.endpoint && previous.endpoint !== endpoint) throw new Error('This installation already mirrors another hub. Use a separate Chrome profile for another source.');
    const token = message.token?.trim() || previous.token;
    if (!token) throw new Error('Enter your bookmark-scoped token.');
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
    return sync();
  }
  throw new Error('Unknown request.');
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  enqueue(()=>dispatch(message)).then(reply,e=>reply({ok:false,error:e.message}));
  return true;
});
async function start() {
  await trustedStorage;
  await chrome.alarms.create(ALARM,{periodInMinutes:5});
  if ((await config()).token) await enqueue(sync).catch(()=>{});
}
chrome.runtime.onInstalled.addListener(()=>{void start();});
chrome.runtime.onStartup.addListener(()=>{void start();});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM)void enqueue(sync).catch(()=>{});});

import {pullTable} from './table-pull.js';

export function endpointURL(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('Use an HTTPS hub endpoint (HTTP is allowed only on localhost).');
  }
  return url.href.replace(/\/$/, '');
}
const failed = status => new Error(`Hub request failed (${status}). Check your connection and bookmark permissions.`);
const options = {signal: () => AbortSignal.timeout(30000), redirect: 'error', credentials: 'omit', cache: 'no-store'};
async function request(config, path, body, transport) {
  const endpoint = endpointURL(config.endpoint);
  if (!config.token) throw new Error('Connect your hub in Settings first.');
  const response = await transport(endpoint + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    ...options, signal: options.signal()
  });
  if (!response.ok) throw failed(response.status);
  return response.json();
}
const COLUMNS = ['id','url','title','tags','description','deleted_at','updated_at'];
// One cursor request when nothing changed; otherwise the arrivals since `state`
// (the whole table when `state` is null). Persist the returned state only with
// the rows it was applied to.
export async function readBookmarkChanges(config, state, transport = fetch) {
  const endpoint = endpointURL(config.endpoint);
  if (!config.token) throw new Error('Connect your hub in Settings first.');
  try {
    return await pullTable({endpoint, token: config.token, table: 'bookmarks', columns: COLUMNS, state,
      fetch: (url, init) => transport(url, {...init, ...options, signal: options.signal()})});
  } catch (e) {
    if (e.status) throw failed(e.status);
    if (/^invalid /.test(e.message)) throw new Error('Invalid bookmark response; no bookmarks were changed.');
    throw e;
  }
}
// The live rows after a change: a full pull replaces them, otherwise upsert and drop tombstones.
export function applyBookmarkChanges(rows, change) {
  const byId = new Map(change.full ? [] : rows.map(row => [row.id, row]));
  for (const id of change.deleted) byId.delete(id);
  for (const row of change.rows) byId.set(row.id, row);
  return [...byId.values()];
}
async function pull(config, where, transport) {
  const rows = [], seen = new Set();
  let after;
  do {
    const result = await request(config, '/v1/rows/pull', {
      table: 'bookmarks', columns: COLUMNS,
      since: '', limit: 200, ...(where ? {where} : {}), ...(after === undefined ? {} : {after})
    }, transport);
    if (!Array.isArray(result.rows) || (result.next_cursor != null && typeof result.next_cursor !== 'string'))
      throw new Error('Invalid bookmark response; no bookmarks were changed.');
    rows.push(...result.rows);
    after = result.next_cursor;
    if (after != null) {
      if (!after || seen.has(after) || !result.rows.length) throw new Error('Invalid bookmark pagination; no bookmarks were changed.');
      seen.add(after);
    }
  } while (after != null);
  return rows;
}
export async function readTags(config, transport = fetch) {
  const result = await request(config, '/v1/catalog/options?table=bookmarks&column=tags', undefined, transport);
  if (!Array.isArray(result.options) || result.options.some(o => typeof o.v !== 'string')) throw new Error('Invalid tag choices from hub.');
  return result.options.map(o => o.v);
}
export async function captureBookmark(config, input, transport = fetch) {
  const url = new URL(input.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only ordinary web pages can be saved.');
  const title = String(input.title ?? '').trim();
  const description = String(input.description ?? '').trim().replace(/\.+$/, '');
  if (!title || !description || !Array.isArray(input.tags) || input.tags.some(t => typeof t !== 'string')) throw new Error('Provide a title, a short description, and valid tags.');
  const existing = (await pull(config, {url: input.url}, transport)).find(r => !r.deleted_at);
  const oldTags = existing ? (typeof existing.tags === 'string' ? JSON.parse(existing.tags) : existing.tags ?? []) : [];
  if (!Array.isArray(oldTags)) throw new Error('The existing bookmark has invalid tags.');
  const row = {id: existing?.id ?? crypto.randomUUID().replaceAll('-', ''), url: input.url, title, description,
    tags: [...new Set([...oldTags, ...input.tags])], updated_at: new Date().toISOString()};
  const result = await request(config, '/v1/rows/push', {table: 'bookmarks', columns: Object.keys(row), rows: [row]}, transport);
  if (!Array.isArray(result.rejected)) throw new Error('Hub did not return a write receipt.');
  if (result.rejected.length) throw new Error(result.rejected.map(r => r.message ?? 'Bookmark was rejected').join('; '));
  // A successful push receipt can acknowledge a stale LWW no-op. Confirm the
  // actual live values, not the receipt count or the client clock.
  const saved = (await pull(config, {url: row.url}, transport)).find(r => r.id === row.id);
  let savedTags;
  try { savedTags = typeof saved?.tags === 'string' ? JSON.parse(saved.tags) : saved?.tags; } catch {}
  if (!saved || saved.deleted_at != null
    || ['url','title','description'].some(field => saved[field] !== row[field])
    || !Array.isArray(savedTags) || savedTags.some(tag => !row.tags.includes(tag))
    || row.tags.some(tag => !savedTags.includes(tag))) {
    throw new Error('Could not confirm the saved bookmark. Refresh and check the source before retrying.');
  }
  return {id: row.id};
}

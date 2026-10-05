import { afterEach, expect, test } from 'bun:test';
import { startReviewHub, REVIEW_TOKEN } from '../scripts/review-hub.js';
import { readBookmarks, readTags, captureBookmark } from '../extension/hub.js';

const servers = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
function start() {
  const server = startReviewHub({ port: 0 });
  servers.push(server);
  return { endpoint: `http://127.0.0.1:${server.port}`, token: REVIEW_TOKEN };
}
function request(config, path, body, token = config.token, method = body === undefined ? 'GET' : 'POST') {
  return fetch(config.endpoint + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const pull = { table: 'bookmarks', columns: ['id', 'url', 'title', 'tags', 'description', 'deleted_at', 'updated_at'], since: '', limit: 200 };

test('real extension client reads only synthetic fixtures and catalog choices', async () => {
  const config = start();
  expect(await readTags(config)).toEqual(['Reading', 'Research']);
  const rows = await readBookmarks(config);
  expect(rows).toHaveLength(3);
  expect(rows.every(row => new URL(row.url).hostname === 'example.com')).toBe(true);
  expect(rows.map(row => row.tags)).toEqual([['Reading'], ['Reading', 'Research'], null]);
  expect(rows.every(row => row.deleted_at === null)).toBe(true);
});

test('real extension capture adds, then updates the same URL and preserves prior tags', async () => {
  const config = start();
  const input = { url: 'https://example.com/captured', title: 'Captured example', description: 'A review fixture.', tags: ['Reading'] };
  const first = await captureBookmark(config, input);
  const second = await captureBookmark(config, { ...input, title: 'Updated example', tags: ['Research'] });
  expect(second.id).toBe(first.id);
  const rows = await readBookmarks(config);
  expect(rows).toHaveLength(4);
  expect(rows.find(row => row.id === first.id)).toMatchObject({ title: 'Updated example', description: 'A review fixture', tags: ['Reading', 'Research'] });
});

test('independent server instances reset fixture data', async () => {
  const a = start();
  await captureBookmark(a, { url: 'https://example.com/new', title: 'New', description: 'Example capture', tags: [] });
  expect(await readBookmarks(a)).toHaveLength(4);
  expect(await readBookmarks(start())).toHaveLength(3);
});

test('pull supports exact URL filtering, column projection and pagination', async () => {
  const config = start();
  const first = await (await request(config, '/v1/rows/pull', { ...pull, columns: ['id', 'url'], limit: 1 })).json();
  expect(first.rows).toHaveLength(1);
  expect(Object.keys(first.rows[0]).sort()).toEqual(['id', 'url']);
  expect(typeof first.next_cursor).toBe('string');
  const second = await (await request(config, '/v1/rows/pull', { ...pull, limit: 1, after: first.next_cursor })).json();
  expect(second.rows[0].id).not.toBe(first.rows[0].id);
  const filtered = await (await request(config, '/v1/rows/pull', { ...pull, where: { url: first.rows[0].url } })).json();
  expect(filtered.rows.map(row => row.id)).toEqual([first.rows[0].id]);
  expect(filtered.next_cursor).toBeNull();
});

test('missing or incorrect bearer credentials cannot read or write fixtures', async () => {
  const config = start();
  expect((await fetch(config.endpoint + '/v1/catalog/options?table=bookmarks&column=tags')).status).toBe(401);
  for (const path of ['/v1/rows/pull', '/v1/rows/push']) {
    expect((await request(config, path, { ...pull, rows: [] }, 'wrong')).status).toBe(401);
  }
  expect(await readBookmarks(config)).toHaveLength(3);
});

test('rejects unknown routes, tables, columns, malformed JSON and invalid cursors', async () => {
  const config = start();
  expect((await request(config, '/unknown')).status).toBe(404);
  expect((await request(config, '/v1/catalog/options?table=other&column=tags')).status).toBe(400);
  for (const body of [{ ...pull, table: 'other' }, { ...pull, columns: ['unknown'] }, { ...pull, after: 'bad' }, { ...pull, limit: 0 }]) {
    expect((await request(config, '/v1/rows/pull', body)).status).toBe(400);
  }
  expect((await fetch(config.endpoint + '/v1/rows/push', { method: 'POST', headers: { Authorization: `Bearer ${config.token}` }, body: '{' })).status).toBe(400);
});

test('rejected captures return the receipt expected by the extension without changing data', async () => {
  const config = start();
  const before = await readBookmarks(config);
  await expect(captureBookmark(config, { url: 'https://example.com/rejected', title: 'Rejected', description: 'Invalid tag choice', tags: ['Unknown'] })).rejects.toThrow('tag');
  const reply = await (await request(config, '/v1/rows/push', { table: 'bookmarks', columns: ['id', 'url'], rows: [{ id: before[0].id, url: 'javascript:alert(1)' }] })).json();
  expect(reply.rejected).toHaveLength(1);
  expect(await readBookmarks(config)).toEqual(before);
});

test('supports browser preflight for authorization and JSON headers', async () => {
  const config = start();
  const response = await fetch(config.endpoint + '/v1/rows/push', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://review-fixture', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  expect(response.status).toBe(204);
  expect(response.headers.get('Access-Control-Allow-Headers').toLowerCase()).toContain('authorization');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
});

test('refuses every nonloopback binding before starting a server', () => {
  for (const hostname of ['0.0.0.0', '::', '192.0.2.1', 'example.com', 'localhost.example.com', '']) {
    expect(() => startReviewHub({ hostname, port: 0 })).toThrow('loopback');
  }
});

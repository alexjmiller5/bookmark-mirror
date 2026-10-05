import { parseArgs } from 'node:util';

// Public fixture credential, deliberately nonsecret. This is a local review harness.
export const REVIEW_TOKEN = 'review-only-not-a-secret';
const tags = ['Reading', 'Research'];
const columns = ['id', 'url', 'title', 'tags', 'description', 'deleted_at', 'updated_at'];
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Cache-Control': 'no-store',
};
const json = (body, status = 200) => Response.json(body, { status, headers });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;

function fixtures() {
  return [
    { id: 'review-1', url: 'https://example.com/', title: 'Example reading', description: 'A synthetic reading bookmark', tags: ['Reading'] },
    { id: 'review-2', url: 'https://example.com/research', title: 'Example research', description: 'A synthetic bookmark with two tags', tags: ['Reading', 'Research'] },
    { id: 'review-3', url: 'https://example.com/untagged', title: null, description: 'A synthetic untagged bookmark', tags: null },
  ].map(row => ({ ...row, deleted_at: null, updated_at: '2026-01-01T00:00:00.000Z' }));
}

function validateRow(row) {
  if (!text(row.id)) throw new Error('Invalid bookmark id');
  const url = new URL(row.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid bookmark URL');
  for (const key of ['title', 'description', 'deleted_at']) {
    if (row[key] !== null && typeof row[key] !== 'string') throw new Error(`Invalid ${key}`);
  }
  if (!text(row.updated_at)) throw new Error('Invalid updated_at');
  const choices = typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags ?? [];
  if (!Array.isArray(choices) || choices.some(tag => !tags.includes(tag))) throw new Error('Unknown or invalid tag');
}

export function startReviewHub({ hostname = '127.0.0.1', port = 8788 } = {}) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) throw new Error('Review hub requires a loopback binding');
  // Resolve the localhost spelling explicitly, never through an external resolver.
  if (hostname === 'localhost') hostname = '127.0.0.1';
  const rows = new Map(fixtures().map(row => [row.id, row]));
  return Bun.serve({ hostname, port, maxRequestBodySize: 1024 * 1024, async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.headers.get('Authorization') !== `Bearer ${REVIEW_TOKEN}`) return json({ error: 'Review bearer token required' }, 401);
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/v1/catalog/options') {
      if (url.searchParams.get('table') !== 'bookmarks' || url.searchParams.get('column') !== 'tags') return json({ error: 'Only bookmark tags are available' }, 400);
      return json({ options: tags.map(v => ({ v, d: `${v} review fixtures` })) });
    }
    if (request.method !== 'POST' || !['/v1/rows/pull', '/v1/rows/push'].includes(url.pathname)) return json({ error: 'Not found' }, 404);
    try {
      const body = await request.json();
      if (!object(body) || body.table !== 'bookmarks' || !Array.isArray(body.columns)
        || !body.columns.length || body.columns.some(column => !columns.includes(column))) throw new Error('Invalid table or columns');
      if (url.pathname === '/v1/rows/pull') {
        if (body.since !== '' || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 200
          || (body.after !== undefined && (typeof body.after !== 'string' || !/^\d+$/.test(body.after)))
          || (body.where !== undefined && (!object(body.where) || Object.keys(body.where).length !== 1 || typeof body.where.url !== 'string'))) throw new Error('Invalid pull parameters');
        const selected = [...rows.values()].filter(row => body.where === undefined || row.url === body.where.url);
        const offset = body.after === undefined ? 0 : Number(body.after);
        if (!Number.isSafeInteger(offset) || offset > selected.length) throw new Error('Invalid cursor');
        const page = selected.slice(offset, offset + body.limit);
        return json({ rows: page.map(row => Object.fromEntries(body.columns.map(column => [column, row[column]]))),
          next_cursor: offset + page.length < selected.length ? String(offset + page.length) : null });
      }
      if (!Array.isArray(body.rows) || !body.columns.includes('id')) throw new Error('Invalid push parameters');
      const updates = [], rejected = [];
      for (const [index, patch] of body.rows.entries()) {
        try {
          if (!object(patch) || !text(patch.id) || Object.keys(patch).some(key => !body.columns.includes(key))) throw new Error('Invalid row fields');
          const row = { title: null, description: null, tags: null, deleted_at: null, updated_at: new Date().toISOString(), ...rows.get(patch.id), ...patch };
          validateRow(row);
          updates.push(row);
        } catch (error) { rejected.push({ index, message: error.message }); }
      }
      // Validate the complete batch before writing any fixture state.
      if (rejected.length) return json({ accepted: 0, rejected });
      for (const row of updates) rows.set(row.id, row);
      return json({ accepted: updates.length, rejected: [] });
    } catch (error) { return json({ error: error.message }, 400); }
  } });
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '8788' } } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1-65535');
  const server = startReviewHub({ hostname: values.host, port });
  console.log(`Review-only hub: ${server.url}\nFixture token (public, nonsecret): ${REVIEW_TOKEN}\nMemory only; restart to reset. Ctrl-C to stop.`);
}

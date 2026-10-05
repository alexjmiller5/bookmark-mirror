import { describe, expect, test } from 'bun:test';

import { syncMirror as sync } from '../extension/mirror.js';
const row = (overrides = {}) => ({ id: 'r1', url: 'https://example.test/', title: 'Example', tags: ['Reading'], deleted_at: null, ...overrides });
const copy = (value) => structuredClone(value);

// Stateful Chrome boundary: nonrecursive remove, detached read results, durable storage.
function chrome({ barId = 'bar', folderType = true } = {}) {
  const nodes = new Map([
    ['0', { id: '0', title: '' }],
    [barId, { id: barId, parentId: '0', title: 'Bookmarks bar', ...(folderType ? { folderType: 'bookmarks-bar' } : {}) }],
    ['other', { id: 'other', parentId: '0', title: 'Other bookmarks' }],
  ]);
  let next = 10;
  const data = {};
  const events = [];
  const faults = { create: 0, set: 0, read: false };
  const children = (id) => [...nodes.values()].filter((node) => node.parentId === id);
  const tree = (id) => { const node = copy(nodes.get(id)); if (!node.url) node.children = children(id).map((n) => tree(n.id)); return node; };
  const seed = (node) => { const id = String(next++); nodes.set(id, { id, ...node }); return id; };
  const api = {
    bookmarks: {
      async getTree() { if (faults.read) throw new Error('read failed'); return [tree('0')]; },
      async create(details) {
        if (faults.create && --faults.create === 0) throw new Error('create failed');
        if (!nodes.has(details.parentId) || nodes.get(details.parentId).url) throw new Error('invalid parent');
        const id = seed(details); events.push(['create', id]); return copy(nodes.get(id));
      },
      async update(id, changes) {
        if (!nodes.has(id)) throw new Error('missing');
        Object.assign(nodes.get(id), changes); events.push(['update', id]); return copy(nodes.get(id));
      },
      async remove(id) {
        if (!nodes.has(id) || children(id).length) throw new Error('missing or nonempty');
        nodes.delete(id); events.push(['remove', id]);
      },
      async removeTree() { throw new Error('recursive removal forbidden'); },
    },
    storage: {
      async get(key) { expect(key).toBe('mirrorState'); return copy(data); },
      async set(value) {
        if (faults.set && --faults.set === 0) throw new Error('storage failed');
        Object.assign(data, copy(value)); events.push(['persist']);
      },
    },
  };
  return { api, nodes, data, events, faults, seed, children, barId, links: () => [...nodes.values()].filter((n) => n.url) };
}

function persistedEachMutation(events) {
  for (let i = 0; i < events.length; i++) {
    if (['create', 'update', 'remove'].includes(events[i][0])) expect(events[i + 1]?.[0]).toBe('persist');
  }
}

describe('syncMirror', () => {
  test('creates direct bar folders, normalizes URLs, deduplicates tags and is restart-idempotent', async () => {
    const c = chrome();
    const rows = [row({ url: ' HTTPS://EXAMPLE.TEST:443 ', tags: '["Reading"," Work ","Reading"]' }), row({ id: 2, tags: [] })];
    expect(await sync(c.api, rows)).toEqual({ bookmarks: 3, created: 3, updated: 0, removed: 0, folders: 3, skipped: 0 });
    expect(c.children(c.barId).map((n) => n.title).sort()).toEqual(['Reading', 'Untagged', 'Work']);
    expect(c.links().map((n) => n.url)).toEqual(Array(3).fill('https://example.test/'));
    persistedEachMutation(c.events);
    c.events.length = 0;
    expect(await sync(c.api, rows)).toEqual({ bookmarks: 3, created: 0, updated: 0, removed: 0, folders: 3, skipped: 0 });
    expect(c.events.filter(([type]) => type !== 'persist')).toEqual([]);
  });

  test('falls back to id 1 and fails safely without a bar', async () => {
    const fallback = chrome({ barId: '1', folderType: false });
    await sync(fallback.api, [row()]);
    expect(fallback.children('1')[0].title).toBe('Reading');
    const missing = chrome({ folderType: false });
    await expect(sync(missing.api, [row()])).rejects.toThrow();
    expect(missing.events).toEqual([]);
  });

  test('reuses a user folder but never claims identical existing bookmarks or name collisions', async () => {
    const c = chrome();
    const collision = c.seed({ parentId: c.barId, title: 'Reading', url: 'https://collision.test/' });
    const folder = c.seed({ parentId: c.barId, title: 'Reading' });
    const foreign = c.seed({ parentId: folder, title: 'Example', url: 'https://example.test/' });
    const before = copy(c.nodes.get(foreign));
    await sync(c.api, [row(), row({ id: 'r2' })]);
    expect(c.children(folder)).toHaveLength(3);
    await sync(c.api, []);
    expect(c.nodes.get(foreign)).toEqual(before);
    expect(c.nodes.has(collision)).toBe(true);
    expect(c.nodes.has(folder)).toBe(true);
    expect(c.links()).toHaveLength(2);
    persistedEachMutation(c.events);
  });

  test('updates only tracked unchanged links when source title and URL change', async () => {
    const c = chrome();
    await sync(c.api, [row()]);
    const id = c.links()[0].id;
    const result = await sync(c.api, [row({ title: 'New', url: 'https://new.test/path' })]);
    expect(result).toEqual({ bookmarks: 1, created: 0, updated: 1, removed: 0, folders: 1, skipped: 0 });
    expect(c.nodes.get(id)).toMatchObject({ title: 'New', url: 'https://new.test/path' });
    persistedEachMutation(c.events);
  });

  test('tag rename and tombstones remove tracked entries and empty owned folders', async () => {
    const c = chrome();
    await sync(c.api, [row({ tags: ['Reading', 'Work'] })]);
    const oldFolder = c.children(c.barId).find((n) => n.title === 'Reading').id;
    expect(await sync(c.api, [row({ tags: ['Later', 'Work'] })])).toEqual({ bookmarks: 2, created: 1, updated: 0, removed: 1, folders: 2, skipped: 0 });
    expect(c.nodes.has(oldFolder)).toBe(false);
    expect(await sync(c.api, [row({ deleted_at: '2026-01-01T00:00:00Z' })])).toEqual({ bookmarks: 0, created: 0, updated: 0, removed: 2, folders: 0, skipped: 0 });
    expect(c.children(c.barId)).toEqual([]);
    persistedEachMutation(c.events);
  });

  test('keeps foreign children and nested folders inside owned folders', async () => {
    const c = chrome();
    await sync(c.api, [row()]);
    const folder = c.children(c.barId)[0].id;
    const foreign = c.seed({ parentId: folder, title: 'Foreign', url: 'https://foreign.test/' });
    const nested = c.seed({ parentId: folder, title: 'Empty user folder' });
    await sync(c.api, []);
    expect(c.nodes.has(folder)).toBe(true);
    expect(c.nodes.has(foreign)).toBe(true);
    expect(c.nodes.has(nested)).toBe(true);
  });

  for (const change of [{ title: 'User title' }, { url: 'https://user.test/' }, { parentId: 'other' }]) {
    test(`preserves user-modified owned link ${JSON.stringify(change)} and replaces desired entry`, async () => {
      const c = chrome();
      await sync(c.api, [row()]);
      const id = c.links()[0].id;
      Object.assign(c.nodes.get(id), change);
      const userNode = copy(c.nodes.get(id));
      const result = await sync(c.api, [row()]);
      expect(result.created).toBe(1);
      expect(c.nodes.get(id)).toEqual(userNode);
      expect(c.links()).toHaveLength(2);
      await sync(c.api, []);
      expect(c.links()).toEqual([userNode]);
    });
  }

  for (const change of [{ title: 'User folder' }, { parentId: 'other' }]) {
    test(`preserves moved/renamed owned folder and contents ${JSON.stringify(change)}`, async () => {
      const c = chrome();
      await sync(c.api, [row()]);
      const folder = c.children(c.barId)[0].id;
      const link = copy(c.links()[0]);
      Object.assign(c.nodes.get(folder), change);
      expect((await sync(c.api, [row()])).created).toBe(1);
      await sync(c.api, []);
      expect(c.nodes.has(folder)).toBe(true);
      expect(c.nodes.get(link.id)).toEqual(link);
    });
  }

  test('recovers externally deleted links and folders', async () => {
    const c = chrome();
    await sync(c.api, [row()]);
    c.nodes.delete(c.links()[0].id);
    expect((await sync(c.api, [row()])).created).toBe(1);
    c.nodes.delete(c.links()[0].id);
    c.nodes.delete(c.children(c.barId)[0].id);
    expect((await sync(c.api, [row()])).created).toBe(1);
    expect(c.links()).toHaveLength(1);
  });

  test('treats tag and row keys as data, including prototype and separator collisions', async () => {
    const c = chrome();
    const rows = [row({ id: '__proto__', tags: ['__proto__', 'a:b'] }), row({ id: '__proto__:a', tags: ['b'] })];
    expect((await sync(c.api, rows)).bookmarks).toBe(3);
    expect((await sync(c.api, rows)).created).toBe(0);
    await sync(c.api, []);
    expect(c.links()).toEqual([]);
  });

  for (const [title, description, expected] of [
    [null, 'Description', 'Description'],
    ['', 'Description', 'Description'],
    ['  ', 'Description', 'Description'],
    [null, null, 'https://example.test/'],
    ['', '', 'https://example.test/'],
    [null, '  ', 'https://example.test/'],
    [null, undefined, 'https://example.test/'],
    ['Title', 'Description', 'Title'],
  ]) {
    test(`nullable title fallback ${JSON.stringify([title, description])}`, async () => {
      const c = chrome();
      const rows = [row({ title, description, tags: null })];
      expect(await sync(c.api, rows)).toEqual({ bookmarks: 1, created: 1, updated: 0, removed: 0, folders: 1, skipped: 0 });
      expect(c.links()[0].title).toBe(expected);
      expect(c.children(c.barId)[0].title).toBe('Untagged');
      expect((await sync(c.api, rows)).created).toBe(0);
    });
  }

  test('updates an owned title when its description fallback changes', async () => {
    const c = chrome();
    await sync(c.api, [row({ title: null, description: 'First' })]);
    const id = c.links()[0].id;
    expect((await sync(c.api, [row({ title: '', description: 'Second' })])).updated).toBe(1);
    expect(c.nodes.get(id).title).toBe('Second');
  });

  test('skips tombstone payload validation but still removes tracked stale links', async () => {
    const c = chrome();
    await sync(c.api, [row()]);
    const rows = [
      { id: 'r1', deleted_at: '2026-01-01', title: {}, url: null, tags: '{' },
      { id: 'r2', deleted_at: '2026-01-01' },
    ];
    expect(await sync(c.api, rows)).toEqual({ bookmarks: 0, created: 0, updated: 0, removed: 1, folders: 0, skipped: 0 });
    expect(c.links()).toEqual([]);
  });

  test('counts live null URLs as skipped rows, excludes them from desired links, and still handles other rows', async () => {
    const c = chrome();
    const rows = [row({ url: null, title: null, tags: null }), row({ id: 'r2' })];
    expect(await sync(c.api, rows)).toEqual({ bookmarks: 1, created: 1, updated: 0, removed: 0, folders: 1, skipped: 1 });
    expect(c.links()).toHaveLength(1);
    expect((await sync(c.api, rows)).created).toBe(0);
  });

  for (const url of [null, '', '  ']) {
    test(`preserves tracked links and ownership for skipped live URL ${JSON.stringify(url)}`, async () => {
      const c = chrome();
      await sync(c.api, [row({ tags: ['Reading', 'Work'] })]);
      const before = copy([...c.nodes]);
      const state = copy(c.data);
      c.events.length = 0;
      expect(await sync(c.api, [row({ url, title: null, tags: null })])).toEqual({ bookmarks: 0, created: 0, updated: 0, removed: 0, folders: 2, skipped: 1 });
      expect([...c.nodes]).toEqual(before);
      expect(c.data).toEqual(state);
      expect(c.events).toEqual([]);
      expect((await sync(c.api, [row({ tags: ['Reading', 'Work'] })])).created).toBe(0);
      expect((await sync(c.api, [{ id: 'r1', deleted_at: '2026-01-01' }])).removed).toBe(2);
    });
  }

  test('skips new empty URLs while removing only unrelated stale entries', async () => {
    const c = chrome();
    await sync(c.api, [row(), row({ id: 'r2', tags: ['Work'] })]);
    const preserved = copy(c.links().find((n) => n.parentId === c.children(c.barId).find((f) => f.title === 'Reading').id));
    expect(await sync(c.api, [row({ url: '' }), row({ id: 'r3', url: '  ' })])).toEqual({ bookmarks: 0, created: 0, updated: 0, removed: 1, folders: 1, skipped: 2 });
    expect(c.links()).toEqual([preserved]);
  });

  for (const rows of [
    [{ id: '', deleted_at: '2026-01-01' }],
    [{ id: 'r1', deleted_at: false }],
    [{ id: 'r1', deleted_at: '' }],
    [row(), { id: 'r1', deleted_at: '2026-01-01' }],
    [{ id: 'r1', deleted_at: '2026-01-01' }, row()],
    [row({ url: null }), row()],
    [row({ title: null, description: 42 })],
    [row({ url: false })],
    [row({ url: null, tags: [false] })],
    [row({ tags: 'null' })],
  ]) {
    test(`rejects malformed envelopes or non-null live fields ${JSON.stringify(rows)}`, async () => {
      const c = chrome();
      await sync(c.api, [row()]);
      const before = copy([...c.nodes]);
      c.events.length = 0;
      await expect(sync(c.api, rows)).rejects.toThrow();
      expect([...c.nodes]).toEqual(before);
      expect(c.events).toEqual([]);
    });
  }

  const badInputs = [null, {}, [null], [row({ id: '' })], [row(), row()], [row({ title: 12 })], [row({ url: 'bad' })], [row({ url: 'javascript:alert(1)' })], [row({ tags: '{' })], [row({ tags: '{}' })], [row({ tags: [1] })], [row({ tags: [' '] })], [row({ tags: false })], [row({ deleted_at: false })]];
  for (const [index, rows] of badInputs.entries()) {
    test(`rejects malformed input ${index} before any mutation, preserving prior mirror`, async () => {
      const c = chrome();
      await sync(c.api, [row()]);
      const before = copy([...c.nodes]);
      c.events.length = 0;
      await expect(sync(c.api, rows)).rejects.toThrow();
      expect([...c.nodes]).toEqual(before);
      expect(c.events).toEqual([]);
    });
  }

  test('validates every row before making even the first addition', async () => {
    const c = chrome();
    await expect(sync(c.api, [row(), row({ id: 'r2', tags: [false] })])).rejects.toThrow();
    expect(c.events).toEqual([]);
  });

  test('rejects unknown/corrupt ownership state without overwriting it', async () => {
    for (const state of [null, {}, { version: 99, links: [], folders: [] }, { version: 1, links: [{}], folders: [] }]) {
      const c = chrome();
      c.data.mirrorState = state;
      await expect(sync(c.api, [])).rejects.toThrow();
      expect(c.data.mirrorState).toEqual(state);
      expect(c.events).toEqual([]);
    }
  });

  test('failed bookmark reads do not turn into deletion or reset ownership', async () => {
    const c = chrome();
    await sync(c.api, [row()]);
    const state = copy(c.data);
    c.events.length = 0;
    c.faults.read = true;
    await expect(sync(c.api, [])).rejects.toThrow('read failed');
    expect(c.data).toEqual(state);
    expect(c.events).toEqual([]);
  });

  test('resumes partial creation from the last persisted mutation', async () => {
    const c = chrome();
    c.faults.create = 3;
    await expect(sync(c.api, [row({ tags: ['Reading', 'Work'] })])).rejects.toThrow('create failed');
    expect(c.links()).toHaveLength(1);
    persistedEachMutation(c.events);
    expect((await sync(c.api, [row({ tags: ['Reading', 'Work'] })])).created).toBe(1);
    expect(c.links()).toHaveLength(2);
  });

  test('stops on storage failure, preserves orphaned creations, and never adopts them on recovery', async () => {
    const c = chrome();
    c.faults.set = 2;
    await expect(sync(c.api, [row({ tags: ['Reading', 'Work'] })])).rejects.toThrow('storage failed');
    expect(c.links()).toHaveLength(1);
    const orphan = copy(c.links()[0]);
    expect((await sync(c.api, [row()])).created).toBe(1);
    await sync(c.api, []);
    expect(c.links()).toEqual([orphan]);
  });
});

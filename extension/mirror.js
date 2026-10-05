const keyOf = ({ rowId, tag }) => JSON.stringify([rowId, tag]);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

function desiredEntries(rows) {
  if (!Array.isArray(rows)) throw new Error('Mirror rows must be an array');
  const desired = new Map();
  const skippedIds = new Set();
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || !(nonempty(row.id) || (Number.isSafeInteger(row.id) && row.id >= 0))
      || (row.deleted_at != null && !nonempty(row.deleted_at))) {
      throw new Error('Malformed mirror row');
    }
    const rowId = String(row.id);
    if (ids.has(rowId)) throw new Error('Duplicate mirror row id');
    ids.add(rowId);
    // Tombstones may have no usable payload, but IDs and envelope must be valid.
    if (row.deleted_at != null) continue;
    if ((row.title !== null && typeof row.title !== 'string')
      || (row.description != null && typeof row.description !== 'string')
      || (row.url !== null && typeof row.url !== 'string')) {
      throw new Error('Malformed mirror row');
    }
    const rawTags = row.tags === null ? [] : typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags;
    if (!Array.isArray(rawTags) || rawTags.some((tag) => !nonempty(tag))) {
      throw new Error('Malformed mirror tags');
    }
    const tags = [...new Set(rawTags.map((tag) => tag.trim()))];
    // An absent live URL is incomplete source data, never a deletion signal.
    if (row.url === null || !row.url.trim()) {
      skippedIds.add(rowId);
      continue;
    }
    const url = new URL(row.url.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Mirror URL must use HTTP(S)');
    const title = nonempty(row.title) ? row.title : nonempty(row.description) ? row.description : url.href;
    for (const tag of tags.length ? tags : ['Untagged']) {
      const entry = { rowId, tag, title, url: url.href };
      desired.set(keyOf(entry), entry);
    }
  }
  return { desired, skippedIds };
}

function ownership(value) {
  if (value === undefined) return { version: 1, links: [], folders: [] };
  if (!value || value.version !== 1 || !Array.isArray(value.links) || !Array.isArray(value.folders)) {
    throw new Error('Invalid mirrorState');
  }
  const ids = new Set();
  const keys = new Set();
  for (const [records, fields] of [
    [value.folders, ['id', 'parentId', 'title']],
    [value.links, ['id', 'parentId', 'rowId', 'tag', 'url']],
  ]) {
    for (const record of records) {
      if (!record || fields.some((field) => !nonempty(record[field]))
        || typeof record.title !== 'string' || ids.has(record.id)) throw new Error('Invalid mirrorState record');
      ids.add(record.id);
      if (records === value.links) {
        if (keys.has(keyOf(record))) throw new Error('Duplicate mirrorState entry');
        keys.add(keyOf(record));
      }
    }
  }
  return structuredClone(value);
}

async function readTree(bookmarks) {
  const nodes = new Map();
  const visit = (node) => {
    nodes.set(node.id, node);
    for (const child of node.children ?? []) visit(child);
  };
  for (const root of await bookmarks.getTree()) visit(root);
  const bar = [...nodes.values()].find((node) => node.folderType === 'bookmarks-bar') ?? nodes.get('1');
  if (!bar || bar.url || bar.unmodifiable) throw new Error('Bookmarks bar unavailable');
  return { nodes, bar };
}

function sameFolder(node, parentId, title) {
  return Boolean(node && !node.url && !node.unmodifiable && node.parentId === parentId && node.title === title);
}

function unchangedLink(entry, { nodes, bar }) {
  const node = nodes.get(entry.id);
  return Boolean(node && !node.unmodifiable && node.parentId === entry.parentId
    && node.title === entry.title && node.url === entry.url
    && sameFolder(nodes.get(entry.parentId), bar.id, entry.tag));
}

/**
 * Reconcile a complete, validated hub snapshot. The caller serializes syncs.
 * Counters created/updated/removed count links; bookmarks counts desired links.
 * skipped counts live rows without URLs, whose existing ownership is retained.
 * folders counts used tag folders, including those retained for skipped rows.
 * Never adopt links by URL or title. A changed fingerprint relinquishes ownership.
 * Chrome and storage are not transactional: a failed persistence may leave an
 * untracked creation, which subsequent runs preserve as user content.
 */
export async function syncMirror({ bookmarks, storage }, rows) {
  // Validate the entire snapshot before reading ownership or mutating Chrome.
  const { desired, skippedIds } = desiredEntries(rows);
  const state = ownership((await storage.get('mirrorState')).mirrorState);
  const persist = () => storage.set({ mirrorState: state });
  const result = { bookmarks: desired.size, created: 0, updated: 0, removed: 0, folders: 0, skipped: skippedIds.size };
  await readTree(bookmarks);

  // Re-read before each destructive operation, including after awaited storage.
  // There is no compare-and-swap Chrome API; remove (never removeTree) additionally
  // protects a folder if a user inserts children between this read and removal.
  for (const entry of [...state.links]) {
    if (skippedIds.has(entry.rowId)) continue;
    const tree = await readTree(bookmarks);
    const intact = unchangedLink(entry, tree);
    if (!intact || !desired.has(keyOf(entry))) {
      if (intact) {
        await bookmarks.remove(entry.id);
        result.removed++;
      }
      state.links = state.links.filter((link) => link.id !== entry.id);
      await persist();
    }
  }

  const usedFolders = new Set(state.links.filter((entry) => skippedIds.has(entry.rowId)).map((entry) => entry.parentId));
  for (const [key, wanted] of desired) {
    let entry = state.links.find((link) => keyOf(link) === key);
    let tree = await readTree(bookmarks);
    // A user may have changed a link while earlier mutations awaited persistence.
    if (entry && !unchangedLink(entry, tree)) {
      state.links = state.links.filter((link) => link.id !== entry.id);
      await persist();
      entry = undefined;
      tree = await readTree(bookmarks);
    }
    if (entry) {
      if (entry.title !== wanted.title || entry.url !== wanted.url) {
        const updated = await bookmarks.update(entry.id, { title: wanted.title, url: wanted.url });
        entry.title = updated.title;
        entry.url = updated.url;
        await persist();
        result.updated++;
      }
      usedFolders.add(entry.parentId);
      continue;
    }

    let folder = [...tree.nodes.values()].find((node) => sameFolder(node, tree.bar.id, wanted.tag));
    if (!folder) {
      folder = await bookmarks.create({ parentId: tree.bar.id, title: wanted.tag });
      state.folders.push({ id: folder.id, parentId: folder.parentId, title: folder.title });
      await persist();
    }
    const created = await bookmarks.create({ parentId: folder.id, title: wanted.title, url: wanted.url });
    state.links.push({ ...wanted, id: created.id, parentId: created.parentId, title: created.title, url: created.url });
    await persist();
    result.created++;
    usedFolders.add(folder.id);
  }

  for (const entry of [...state.folders]) {
    const { nodes, bar } = await readTree(bookmarks);
    const folder = nodes.get(entry.id);
    const intact = entry.parentId === bar.id && sameFolder(folder, entry.parentId, entry.title);
    if (intact && (usedFolders.has(entry.id) || folder.children?.length)) continue;
    if (intact) await bookmarks.remove(entry.id);
    state.folders = state.folders.filter((item) => item.id !== entry.id);
    await persist();
  }
  result.folders = usedFolders.size;
  return result;
}

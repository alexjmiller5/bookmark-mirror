const byId = (id) => document.getElementById(id);
let configured = false;
let validTab = false;
let busy = false;
let captured = false;
let currentPage = null;
let currentPageCaptured = false;
let pendingCaptures = [];
let selectedId = '';
let queueLoaded = false;
const savedPendingIds = new Set();

function selectCandidate(id) {
  selectedId = id;
  byId('capture-source').value = id;
  const candidate = id ? pendingCaptures.find((item) => item.id === id) : currentPage;
  byId('url').value = candidate?.url || '';
  byId('title').value = candidate?.title || candidate?.url || '';
  byId('description').value = '';
  for (const field of ['title', 'description']) byId(field).setCustomValidity('');
  for (const input of byId('tags').querySelectorAll('input:checked')) input.checked = false;
  validTab = false;
  try {
    const url = new URL(candidate?.url || '');
    validTab = ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch { /* A missing or unsupported page cannot be captured. */ }
  captured = id ? savedPendingIds.has(id) : currentPageCaptured;
  byId('page-help').textContent = id ? 'The new Chrome bookmark selected for review.' : 'The page in your active tab.';
  showError('capture-error', candidate && !validTab ? 'Choose a bookmark with a regular web page URL.' : '');
  updateButtons();
}

function renderQueue(result) {
  const queue = result.pendingCaptures ?? result.status?.pendingCaptures;
  if (!Array.isArray(queue)) return;
  pendingCaptures = queue;
  const selector = byId('capture-source');
  selector.replaceChildren();
  const current = document.createElement('option');
  current.value = '';
  current.textContent = 'Current page';
  selector.append(current);
  for (const item of pendingCaptures) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${item.title || item.url} (${item.url})`;
    selector.append(option);
  }
  byId('review-prompt').hidden = !pendingCaptures.length;
  byId('pending-count').textContent = pendingCaptures.length
    ? `${pendingCaptures.length} new bookmark${pendingCaptures.length === 1 ? '' : 's'} waiting for review.` : '';
  if ((!queueLoaded && pendingCaptures.length) || (selectedId && !pendingCaptures.some((item) => item.id === selectedId))) {
    selectCandidate(pendingCaptures[0]?.id || '');
  } else selector.value = selectedId;
  queueLoaded = true;
}

function showError(id, error = '') {
  byId(id).textContent = error instanceof Error ? error.message : String(error);
  byId(id).hidden = !error;
}

function updateButtons() {
  byId('capture-source').disabled = busy;
  byId('capture').textContent = captured ? 'Saved' : 'Save bookmark';
  byId('sync').disabled = busy || !configured;
  byId('capture').disabled = busy || !configured || !validTab || captured;
}

async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || 'The extension could not complete this request. Try again.');
  return result;
}

function render(result) {
  if (typeof result.configured === 'boolean') configured = result.configured;
  const status = result.status || {};
  byId('connection-state').textContent = configured ? 'Configured on this device' : 'Connect this device in Settings to sync and save bookmarks.';
  const date = status.lastSync ? new Date(status.lastSync) : null;
  byId('last-sync').textContent = date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : 'Not yet synced';
  byId('bookmarks').textContent = String(status.bookmarks ?? 0);
  const skipped = status.skipped ?? 0;
  byId('sync-skipped').textContent = skipped > 0
    ? `${skipped} source bookmark${skipped === 1 ? ' has' : 's have'} no URL and ${skipped === 1 ? 'was' : 'were'} skipped.`
    : '';
  byId('sync-skipped').hidden = !(skipped > 0);
  showError('sync-error', status.error || '');
  if (Array.isArray(result.tags)) {
    const selected = new Set(Array.from(byId('tags').querySelectorAll('input:checked'), (input) => input.value));
    byId('tags').replaceChildren();
    for (const tag of new Set(result.tags.filter((value) => typeof value === 'string' && value.trim()))) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.name = 'tags';
      checkbox.value = tag;
      checkbox.checked = selected.has(tag);
      const text = document.createElement('span');
      text.textContent = tag;
      label.append(checkbox, text);
      byId('tags').append(label);
    }
    byId('tags-help').textContent = byId('tags').childElementCount ? 'Choose any tags that fit.' : 'No tags available. You can save without tags.';
  }
  renderQueue(result);
  updateButtons();
}

byId('capture-source').addEventListener('change', () => {
  if (busy) return;
  selectCandidate(byId('capture-source').value);
  byId('capture-message').textContent = '';
});

byId('settings').addEventListener('click', async () => {
  try { await chrome.runtime.openOptionsPage(); }
  catch { showError('sync-error', 'Settings could not open. Try the extension’s options from Chrome’s extensions page.'); }
});
byId('sync').addEventListener('click', async () => {
  if (busy || !configured) return;
  busy = true;
  updateButtons();
  showError('sync-error');
  byId('sync-message').textContent = 'Syncing…';
  try {
    const result = await request({ type: 'sync' });
    render(result);
    byId('sync-message').textContent = result.status?.error ? 'Sync needs attention.' : 'Sync complete.';
  } catch (error) {
    showError('sync-error', error);
    byId('sync-message').textContent = '';
  } finally { busy = false; updateButtons(); }
});
byId('capture-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !configured || !validTab || captured) return;
  for (const id of ['title', 'description']) {
    byId(id).setCustomValidity(byId(id).value.trim() ? '' : `Enter a ${id === 'title' ? 'title' : 'brief summary'}.`);
  }
  if (!byId('capture-form').reportValidity()) return;
  const message = {
    type: 'capture', url: byId('url').value, title: byId('title').value.trim(),
    description: byId('description').value.trim(),
    tags: Array.from(byId('tags').querySelectorAll('input:checked'), (input) => input.value),
  };
  if (selectedId) message.bookmarkId = selectedId;
  busy = true;
  updateButtons();
  showError('capture-error');
  byId('capture-message').textContent = 'Saving bookmark…';
  try {
    const result = await request(message);
    captured = true;
    if (message.bookmarkId) savedPendingIds.add(message.bookmarkId);
    else currentPageCaptured = true;
    render(result);
    if (message.bookmarkId && !Array.isArray(result.pendingCaptures ?? result.status?.pendingCaptures)) {
      try {
        const refreshed = await request({ type: 'status' });
        render(refreshed);
        // A refresh must not hide the mirror failure returned by this save.
        if (result.status?.error) showError('sync-error', result.status.error);
      } catch {
        showError('sync-error', 'Bookmark saved, but the review queue could not refresh. Reopen the popup to continue.');
      }
    }
    byId('capture-message').textContent = result.status?.error
      ? 'Bookmark saved; mirror sync needs attention.' : 'Bookmark saved to the source.';
  } catch (error) {
    showError('capture-error', error);
    byId('capture-message').textContent = '';
  } finally { busy = false; updateButtons(); }
});
for (const id of ['title', 'description']) {
  byId(id).addEventListener('input', () => byId(id).setCustomValidity(''));
}

async function loadStatus() {
  try { render(await request({ type: 'status' })); }
  catch (error) {
    byId('connection-state').textContent = 'Connection status unavailable. Open Settings to check the connection.';
    byId('tags-help').textContent = 'Tags unavailable until the connection can be checked.';
    showError('sync-error', error);
  }
}
async function loadTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url || '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
    currentPage = { url: url.href, title: tab.title || url.hostname };
    if (!selectedId) selectCandidate('');
  } catch {
    if (!selectedId) showError('capture-error', 'Open a regular web page, then reopen Bookmark Mirror to save it.');
  }
  updateButtons();
}
loadStatus();
loadTab();

const byId = (id) => document.getElementById(id);
let configured = false;
let validTab = false;
let busy = false;
let captured = false;

function showError(id, error = '') {
  byId(id).textContent = error instanceof Error ? error.message : String(error);
  byId(id).hidden = !error;
}

function updateButtons() {
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
  updateButtons();
}

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
  busy = true;
  updateButtons();
  showError('capture-error');
  byId('capture-message').textContent = 'Saving bookmark…';
  try {
    await request(message);
    captured = true;
    byId('capture-message').textContent = 'Bookmark saved to the source.';
    byId('capture').textContent = 'Saved';
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
    byId('url').value = url.href;
    byId('title').value = tab.title || url.hostname;
    validTab = true;
  } catch {
    showError('capture-error', 'Open a regular web page, then reopen Bookmark Mirror to save it.');
  }
  updateButtons();
}
loadStatus();
loadTab();

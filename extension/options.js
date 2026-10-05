/* Connection secrets are sent only to the extension background. */
const byId = (id) => document.getElementById(id);
let configured = false;
let busy = false;

function errorText(error, secret = '') {
  const message = error instanceof Error ? error.message : String(error || 'Something went wrong. Try again.');
  return secret ? message.split(secret).join('[redacted]') : message;
}

function showError(id, message = '') {
  byId(id).textContent = message;
  byId(id).hidden = !message;
}

function setBusy(value) {
  busy = value;
  byId('connect').disabled = value;
  byId('refresh').disabled = value;
  byId('sync').disabled = value || !configured;
  byId('endpoint').disabled = value;
  byId('token').disabled = value;
}

async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || 'The extension could not complete this request. Try again.');
  return result;
}

function render(result) {
  if (typeof result.configured === 'boolean') configured = result.configured;
  const status = result.status || {};
  byId('connection-state').textContent = configured ? 'Configured on this device' : 'Not connected. Enter your endpoint and device credential above.';
  const date = status.lastSync ? new Date(status.lastSync) : null;
  byId('last-sync').textContent = date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : 'Not yet synced';
  byId('bookmarks').textContent = String(status.bookmarks ?? 0);
  byId('sync-detail').textContent = `Last sync: ${status.created ?? 0} created, ${status.updated ?? 0} updated, ${status.removed ?? 0} removed.`;
  showError('sync-error', status.error ? errorText(status.error, byId('token').value) : '');
  setBusy(busy);
}

async function refresh() {
  if (busy) return;
  setBusy(true);
  showError('sync-error');
  byId('sync-message').textContent = 'Checking connection…';
  try {
    render(await request({ type: 'status' }));
    byId('sync-message').textContent = 'Connection status updated.';
  } catch (error) {
    showError('sync-error', errorText(error, byId('token').value));
    byId('sync-message').textContent = '';
  } finally { setBusy(false); }
}

// Request host access directly in the click event, before any asynchronous work.
byId('connect').addEventListener('click', async (event) => {
  event.preventDefault();
  if (busy) return;
  const endpointField = byId('endpoint');
  endpointField.setCustomValidity('');
  let endpoint;
  try {
    endpoint = new URL(endpointField.value.trim());
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if (!(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && local))) {
      throw new Error('Use an HTTPS URL, or HTTP on localhost.');
    }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error('Use an endpoint URL without embedded credentials, a query, or a fragment.');
    }
  } catch (error) {
    const message = error instanceof TypeError ? 'Enter a valid endpoint URL.' : error.message;
    endpointField.setCustomValidity(message);
    showError('connection-error', message);
    endpointField.reportValidity();
    return;
  }
  if (!byId('connection-form').reportValidity()) return;
  const token = byId('token').value.trim();
  if (!configured && !token) {
    showError('connection-error', 'Enter a device credential to connect for the first time.');
    byId('token').focus();
    return;
  }
  showError('connection-error');
  byId('connection-message').textContent = 'Requesting host access…';
  try {
    const permission = chrome.permissions.request({ origins: [endpoint.origin + '/*'] });
    setBusy(true);
    if (!(await permission)) throw new Error('Host access was not granted. Allow access to connect this device.');
    byId('connection-message').textContent = 'Connecting…';
    await request({ type: 'configure', endpoint: endpoint.href, token });
    configured = true;
    byId('token').value = '';
    byId('connection-message').textContent = 'Connection saved. Your credential stays on this device.';
    render(await request({ type: 'status' }));
  } catch (error) {
    showError('connection-error', errorText(error, token));
    byId('connection-message').textContent = '';
  } finally { setBusy(false); }
});
byId('connection-form').addEventListener('submit', (event) => {
  event.preventDefault();
  byId('connect').click();
});
byId('endpoint').addEventListener('input', () => byId('endpoint').setCustomValidity(''));
byId('refresh').addEventListener('click', refresh);
byId('sync').addEventListener('click', async () => {
  if (busy || !configured) return;
  setBusy(true);
  showError('sync-error');
  byId('sync-message').textContent = 'Syncing…';
  try {
    const result = await request({ type: 'sync' });
    render(result);
    byId('sync-message').textContent = result.status?.error ? 'Sync needs attention.' : 'Sync complete.';
  } catch (error) {
    showError('sync-error', errorText(error, byId('token').value));
    byId('sync-message').textContent = '';
  } finally { setBusy(false); }
});
refresh();

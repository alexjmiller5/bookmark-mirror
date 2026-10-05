import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Minimal DOM tied to real HTML IDs: a missing status element must fail.
async function loadUI(page, initialStatus, captureResult, pendingCaptures = [], { failRefresh = false, tabUrl = 'https://example.com/' } = {}) {
  const html = readFileSync(new URL(`../extension/${page}.html`, import.meta.url), 'utf8');
  const element = () => ({
    textContent: '', value: '', hidden: false, disabled: false, events: {}, children: [],
    setCustomValidity(message) { this.validationMessage = message; },
    reportValidity() { return !this.validationMessage; },
    querySelectorAll() { return this.children.flatMap((label) => label.children.filter((input) => input.checked)); },
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    get childElementCount() { return this.children.length; },
    addEventListener(type, handler) { this.events[type] = handler; },
  });
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, element()]));
  elements.get('capture-form') && (elements.get('capture-form').reportValidity = () =>
    ['title', 'description'].every((id) => !elements.get(id).validationMessage));
  let status = initialStatus;
  const calls = [];
  const messages = [];
  runInNewContext(readFileSync(new URL(`../extension/${page}.js`, import.meta.url), 'utf8'), {
    document: { getElementById: (id) => elements.get(id), createElement: element },
    chrome: {
      runtime: { sendMessage: async (message) => {
        calls.push(message.type);
        messages.push(message);
        if (failRefresh && message.type === 'status' && calls.length > 1) throw new Error('Example refresh failure');
        if (message.type === 'capture') {
          if (captureResult?.ok && message.bookmarkId) pendingCaptures = pendingCaptures.filter((item) => item.id !== message.bookmarkId);
          return captureResult;
        }
        return { ok: true, configured: true, status, pendingCaptures };
      } },
      tabs: { query: async () => [{ url: tabUrl, title: 'Example' }] },
    }, URL,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    html, get: (id) => elements.get(id), calls, messages,
    async sync(nextStatus) {
      status = nextStatus;
      await elements.get('sync').events.click();
    },
  };
}

for (const page of ['options', 'popup']) {
  describe(`${page} mirror status`, () => {
    test('labels the copy count as mirrored bookmarks', async () => {
      const ui = await loadUI(page, { bookmarks: 7 });
      expect(ui.html).toContain('<dt>Mirrored bookmarks</dt>');
      expect(ui.html).not.toContain('<dt>Source bookmarks</dt>');
      expect(ui.get('bookmarks').textContent).toBe('7');
    });
    test('shows one skipped source bookmark on initial status', async () => {
      const ui = await loadUI(page, { bookmarks: 7, skipped: 1 });
      expect(ui.get('sync-skipped').textContent).toBe('1 source bookmark has no URL and was skipped.');
      expect(ui.get('sync-skipped').hidden).toBe(false);
      expect(ui.html).toMatch(/id="sync-skipped"[^>]*role="status"/);
    });
    test('sync updates the count and plural message without hiding errors', async () => {
      const ui = await loadUI(page, { bookmarks: 7, skipped: 1 });
      await ui.sync({ bookmarks: 9, skipped: 3, error: 'Example sync failure' });
      expect(ui.calls).toEqual(['status', 'sync']);
      expect(ui.get('bookmarks').textContent).toBe('9');
      expect(ui.get('sync-skipped').textContent).toBe('3 source bookmarks have no URL and were skipped.');
      expect(ui.get('sync-skipped').hidden).toBe(false);
      expect(ui.get('sync-error').textContent).toBe('Example sync failure');
      expect(ui.get('sync-error').hidden).toBe(false);
    });
    for (const skipped of [0, undefined]) {
      test(`clears stale skipped message when count is ${skipped}`, async () => {
        const ui = await loadUI(page, { skipped: 3 });
        await ui.sync({ bookmarks: 7, skipped });
        expect(ui.get('sync-skipped').textContent).toBe('');
        expect(ui.get('sync-skipped').hidden).toBe(true);
      });
    }
  });
}

for (const error of [null, 'Example mirror failure']) {
  test(`capture stays saved when mirror result is ${error ? 'failed' : 'successful'}`, async () => {
    const ui = await loadUI('popup', { bookmarks: 7 }, {
      ok: true, status: { bookmarks: 8, skipped: 1, error },
    });
    ui.get('description').value = 'Example summary';
    await ui.get('capture-form').events.submit({ preventDefault() {} });
    expect(ui.calls).toEqual(['status', 'capture']);
    expect(ui.get('bookmarks').textContent).toBe('8');
    expect(ui.get('sync-skipped').textContent).toBe('1 source bookmark has no URL and was skipped.');
    expect(ui.get('sync-error').textContent).toBe(error || '');
    expect(ui.get('sync-error').hidden).toBe(!error);
    expect(ui.get('capture-message').textContent).toBe(error
      ? 'Bookmark saved; mirror sync needs attention.' : 'Bookmark saved to the source.');
    expect(ui.get('capture-error').hidden).toBe(true);
    expect(ui.get('capture').textContent).toBe('Saved');
    expect(ui.get('capture').disabled).toBe(true);
    expect(ui.get('sync').disabled).toBe(false);
    await ui.get('capture-form').events.submit({ preventDefault() {} });
    expect(ui.calls).toEqual(['status', 'capture']);
  });
}

test('a rejected capture remains retryable and does not claim success', async () => {
  const ui = await loadUI('popup', { bookmarks: 7 }, { ok: false, error: 'Example capture failure' });
  ui.get('description').value = 'Example summary';
  await ui.get('capture-form').events.submit({ preventDefault() {} });
  expect(ui.get('capture-error').hidden).toBe(false);
  expect(ui.get('capture-error').textContent).toContain('Example capture failure');
  expect(ui.get('capture-message').textContent).toBe('');
  expect(ui.get('capture').disabled).toBe(false);
  expect(ui.get('bookmarks').textContent).toBe('7');
});

const pendingExamples = [
  { id: 'native-1', url: 'https://example.com/one', title: '<b>First bookmark</b>' },
  { id: 'native-2', url: 'https://example.com/two', title: 'Second bookmark' },
];

test('pending bookmarks prompt for explicit review and keep the current page available', async () => {
  const ui = await loadUI('popup', {}, undefined, pendingExamples);
  expect(ui.get('review-prompt').hidden).toBe(false);
  expect(ui.get('capture-source').value).toBe('native-1');
  expect(ui.get('url').value).toBe(pendingExamples[0].url);
  expect(ui.get('title').value).toBe(pendingExamples[0].title);
  expect(ui.get('description').value).toBe('');
  expect(ui.calls).toEqual(['status']);
  expect(ui.get('capture-source').children[1].textContent).toContain('<b>First bookmark</b>');
  ui.get('capture-source').value = '';
  ui.get('capture-source').events.change();
  expect(ui.get('url').value).toBe('https://example.com/');
  expect(ui.get('title').value).toBe('Example');
  expect(ui.calls).toEqual(['status']);
});

test('saving a queued bookmark sends its ID and tags, refreshes the queue and selects the next', async () => {
  const ui = await loadUI('popup', {}, { ok: true, status: { error: 'Example mirror failure' } }, pendingExamples);
  ui.get('description').value = 'User supplied summary';
  const checkbox = { checked: true, value: 'Example tag' };
  ui.get('tags').children = [{ children: [checkbox] }];
  await ui.get('capture-form').events.submit({ preventDefault() {} });
  expect(ui.messages[1]).toEqual({ type: 'capture', bookmarkId: 'native-1', url: pendingExamples[0].url,
    title: pendingExamples[0].title, description: 'User supplied summary', tags: ['Example tag'] });
  expect(ui.calls).toEqual(['status', 'capture', 'status']);
  expect(ui.get('capture-source').value).toBe('native-2');
  expect(ui.get('url').value).toBe(pendingExamples[1].url);
  expect(ui.get('description').value).toBe('');
  expect(checkbox.checked).toBe(false);
  expect(ui.get('capture').disabled).toBe(false);
  expect(ui.get('capture-message').textContent).toBe('Bookmark saved; mirror sync needs attention.');
  expect(ui.get('capture-error').hidden).toBe(true);
  ui.get('description').value = 'Another summary';
  await ui.get('capture-form').events.submit({ preventDefault() {} });
  expect(ui.messages[3].bookmarkId).toBe('native-2');
  expect(ui.get('review-prompt').hidden).toBe(true);
  expect(ui.get('capture-source').value).toBe('');
  expect(ui.get('url').value).toBe('https://example.com/');
});

test('rejected pending capture preserves selection and draft for retry', async () => {
  const ui = await loadUI('popup', {}, { ok: false, error: 'Example rejection' }, pendingExamples);
  ui.get('description').value = 'Keep this summary';
  await ui.get('capture-form').events.submit({ preventDefault() {} });
  expect(ui.get('capture-source').value).toBe('native-1');
  expect(ui.get('description').value).toBe('Keep this summary');
  expect(ui.get('capture').disabled).toBe(false);
  expect(ui.calls).toEqual(['status', 'capture']);
});

test('current page capture never acknowledges a queued bookmark', async () => {
  const ui = await loadUI('popup', {}, { ok: true, status: {} }, pendingExamples);
  ui.get('capture-source').value = '';
  ui.get('capture-source').events.change();
  ui.get('description').value = 'Current page summary';
  await ui.get('capture-form').events.submit({ preventDefault() {} });
  expect(ui.messages[1].bookmarkId).toBeUndefined();
  expect(ui.messages[1].url).toBe('https://example.com/');
});

test('a pending review requires a nonblank summary before sending capture', async () => {
  const ui = await loadUI('popup', {}, undefined, pendingExamples);
  ui.get('description').value = '   ';
  await ui.get('capture-form').events.submit({ preventDefault() {} });
  expect(ui.calls).toEqual(['status']);
  expect(ui.get('description').validationMessage).toBe('Enter a brief summary.');
});

test('capture can supply the acknowledged queue directly without another request', async () => {
  const ui = await loadUI('popup', {}, {
    ok: true, status: { bookmarks: 8 }, pendingCaptures: [pendingExamples[1]],
  }, pendingExamples);
  ui.get('description').value = 'Example summary';
  await ui.get('capture-form').events.submit({ preventDefault() {} });
  expect(ui.calls).toEqual(['status', 'capture']);
  expect(ui.get('capture-source').value).toBe('native-2');
  expect(ui.get('bookmarks').textContent).toBe('8');
});

test('failed queue refresh after persisted capture cannot invite a duplicate save', async () => {
  const ui = await loadUI('popup', {}, { ok: true, status: {} }, pendingExamples, { failRefresh: true });
  ui.get('description').value = 'Example summary';
  await ui.get('capture-form').events.submit({ preventDefault() {} });
  expect(ui.get('capture-message').textContent).toBe('Bookmark saved to the source.');
  expect(ui.get('capture-error').hidden).toBe(true);
  expect(ui.get('sync-error').textContent).toContain('review queue could not refresh');
  expect(ui.get('capture').disabled).toBe(true);
  ui.get('capture-source').value = '';
  ui.get('capture-source').events.change();
  ui.get('capture-source').value = 'native-1';
  ui.get('capture-source').events.change();
  expect(ui.get('capture').disabled).toBe(true);
});

test('pending review works even when the active tab is a Chrome settings page', async () => {
  const ui = await loadUI('popup', {}, undefined, pendingExamples, { tabUrl: 'chrome://settings' });
  expect(ui.get('capture').disabled).toBe(false);
  expect(ui.get('url').value).toBe(pendingExamples[0].url);
  expect(ui.get('capture-error').hidden).toBe(true);
  ui.get('capture-source').value = '';
  ui.get('capture-source').events.change();
  expect(ui.get('capture').disabled).toBe(true);
});

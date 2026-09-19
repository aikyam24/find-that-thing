import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Settings refresh preserves unsaved assisted-search edits and sends preset days', async () => {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: false, hidden: false, disabled: false,
      classList: { toggle() {} }, handlers: {},
      addEventListener(type, callback) { this.handlers[type] = callback; },
    });
    return elements.get(id);
  }
  let listener;
  let importRequest;
  globalThis.document = { getElementById: element, activeElement: null };
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener(callback) { listener = callback; } },
      async sendMessage(message) {
        if (message.type === 'GET_SETTINGS') return { ok: true, data: {
          assisted: false, count: 1, bytes: 100, hasKey: true,
          historyPermission: true, policy: { retentionDays: 90, historyEnabled: false },
        } };
        if (message.type === 'START_HISTORY_IMPORT') {
          importRequest = message;
          return { ok: true, data: { jobId: 'test' } };
        }
        if (message.type === 'GET_HISTORY_IMPORT') return { ok: true, data: { status: 'complete', accepted: 1, inserted: 1 } };
        return { ok: true, data: {} };
      },
    },
    commands: { async getAll() { return []; } },
  };
  await import('../options.js');
  element('assisted').checked = true;
  element('assisted').handlers.change?.();
  document.activeElement = element('api-key');
  listener({ type: 'EVENT', kind: 'changed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('assisted').checked, true);
  element('import-days').value = '90';
  element('import-limit').value = '2000';
  await element('history-import-form').handlers.submit({ preventDefault() {} });
  assert.equal(importRequest.days, 90);
  assert.equal(importRequest.from, undefined);
  assert.equal(importRequest.to, undefined);
});

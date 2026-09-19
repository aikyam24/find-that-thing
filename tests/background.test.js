import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureDatabase, closeDatabase, commitPage, readMeta } from '../lib/db.js';
import { createRecord } from '../lib/records.js';

test('background listeners and local-to-Jev search survive worker startup and maintenance', async t => {
  const events = {};
  const event = name => ({ addListener(callback) { events[name] = callback; } });
  let resolvePermission;
  const permission = new Promise(resolve => { resolvePermission = resolve; });
  globalThis.chrome = {
    runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, sendMessage: async () => {},
      onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup') },
    storage: { local: { setAccessLevel: async () => {}, get: async () => ({ apiKey: 'fixture', assisted: true }) } },
    permissions: { contains: () => permission, onRemoved: event('removed') },
    history: { onVisited: event('visit'), onVisitRemoved: event('historyRemoved') },
    alarms: { get: async () => ({}), onAlarm: event('alarm') },
    action: { onClicked: event('click') }, commands: { onCommand: event('command') },
  };
  await configureDatabase({ name: `background-review-${Date.now()}` });
  const previousFetch = globalThis.fetch;
  try {
    await import('../background.js');
    await t.test('history listeners exist before asynchronous permission resolution', () => {
      assert.equal(typeof events.visit, 'function');
      assert.equal(typeof events.historyRemoved, 'function');
    });
    resolvePermission(true);
    await t.test('a local search revision reaches Jev and returns a ranked result', async () => {
      const record = await createRecord({ url: 'https://public.example/', title: 'File sharing', text: 'Share files without signing up.' });
      await commitPage(record, await readMeta());
      let calls = 0;
      globalThis.fetch = async (_url, options) => {
        calls++;
        const packet = JSON.parse(options.body);
        return { ok: true, json: async () => ({ answers: {
          relevance: { type: 'score', score: 3, confidence: 0.9 },
          detail_support: { type: 'choice', choice: 'supported' },
          best_passage: { type: 'choice', choice: packet.state.candidate.passages[0].id },
        } }) };
      };
      const send = message => new Promise(resolve => events.message(message, {
        id: 'test', url: 'chrome-extension://test/sidepanel.html',
      }, resolve));
      const local = await send({ type: 'SEARCH_LOCAL', clientId: 'test', query: 'share files' });
      assert.equal(local.ok, true);
      const ranked = await send({ type: 'SEARCH_JEV', clientId: 'test', query: 'share files', revision: local.data.revision });
      assert.equal(ranked.ok, true);
      assert.equal(ranked.data.mode, 'jev');
      assert.equal(ranked.data.results[0].id, record.page.id);
      assert.equal(calls, 1);
    });
  } finally {
    resolvePermission(true);
    globalThis.fetch = previousFetch;
    await closeDatabase();
  }
});

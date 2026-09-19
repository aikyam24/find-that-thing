import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRecord, createHistoryRecord, mergePage, migrateLegacyRecord, pageMetadata,
} from '../lib/records.js';
import {
  configureDatabase, closeDatabase, readMeta, getPage, getChunks, commitPage,
  deletePages, keepPage, listPages, runMigration, updatePolicy, getUsage,
  openDatabase,
} from '../lib/db.js';
import { DAY_MS, validatePolicy } from '../lib/policy.js';
import { runMaintenance } from '../lib/maintenance.js';

const capture = (text, overrides = {}) => ({
  url: 'https://example.com/tool?utm_source=news', title: 'Example tool', text, ...overrides,
});

let dbSeq = 0;

function dbName() {
  return `ftt-lifecycle-${Date.now()}-${++dbSeq}`;
}

function deleteDb(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = request.onblocked = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function seedV1(name, records) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('pages', { keyPath: 'id' });
      request.result.createObjectStore('meta');
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['pages', 'meta'], 'readwrite');
      for (const record of records) tx.objectStore('pages').put(record);
      tx.objectStore('meta').put(1, 'revision');
      tx.objectStore('meta').put(0, 'deletionGeneration');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Could not seed v1 database.'));
    };
    request.onerror = () => reject(request.error);
  });
}

async function asV1(text, overrides) {
  const { page, chunks } = await createRecord(capture(text, overrides));
  return {
    id: page.id, schemaVersion: 1, originalUrl: page.originalUrl, normalizedIdentity: page.normalizedIdentity,
    hostname: page.hostname, title: page.title, source: 'manual', createdAt: page.createdAt,
    capturedAt: page.capturedAt, contentHash: page.contentHash, extractorVersion: page.extractorVersion,
    truncated: page.truncated, userNote: '', chunks,
  };
}

async function withDatabase(options, run) {
  const name = dbName();
  await configureDatabase({ name, ...options });
  try {
    return await run(name);
  } finally {
    await closeDatabase();
    await deleteDb(name);
  }
}

function guardsFrom(meta) {
  return { deletionGeneration: meta.deletionGeneration, policyRevision: meta.policyRevision };
}

test('v1 manual records migrate without dropping late text', async () => {
  const late = `${'General introduction to our platform. '.repeat(160)}\n\nSend large files without an account. No signup is required.`;
  const record = await asV1(late, { title: 'A useful website' });
  await withDatabase({ autoMigrate: true }, async name => {
    await seedV1(name, [record]);
    const page = await getPage(record.id);
    const chunks = await getChunks(record.id);
    const meta = await readMeta();
    assert.equal(page.schemaVersion, 2);
    assert.equal(page.pinned, true);
    assert.equal(page.savedAt, record.createdAt);
    assert.equal(page.textExpiresAt, null);
    assert.equal(page.captureSource, 'manual');
    assert.equal(page.chunks, undefined);
    assert.ok(chunks.some(chunk => /No signup is required/.test(chunk.text)));
    assert.equal(meta.migrationStatus.state, 'complete');
    assert.equal(meta.pageCount, 1);
    assert.equal(meta.pinnedCount, 1);
    assert.ok(meta.metaBytes > 0);
    assert.equal(meta.pinnedBytes, meta.metaBytes + meta.bodyBytes);
    const listed = await listPages({ limit: 10 });
    assert.equal(listed.pages.length, 1);
    assert.equal(listed.pages[0].id, record.id);
  });
});

test('migration can be interrupted and resumed from a checkpoint', async () => {
  const records = [
    await asV1('first page', { url: 'https://example.com/a' }),
    await asV1('second page', { url: 'https://example.com/b' }),
    await asV1('third page', { url: 'https://example.com/c' }),
  ];
  await withDatabase({ autoMigrate: false, batchSize: 1 }, async name => {
    await seedV1(name, records);
    const paused = await runMigration({ batchSize: 1, maxBatches: 1 });
    assert.equal(paused.migrationStatus.state, 'pending');
    assert.ok(paused.migrationStatus.migrated >= 1);
    assert.ok(paused.migrationStatus.migrated < 3);
    await assert.rejects(commitPage({
      page: migrateLegacyRecord(records[0]).page, chunks: [], historyAliases: [],
    }, guardsFrom(paused)), /upgrading/);
    const done = await runMigration({ batchSize: 1 });
    assert.equal(done.migrationStatus.state, 'complete');
    assert.equal(done.pageCount, 3);
    assert.equal(done.pinnedCount, 3);
    assert.equal(done.pinnedBytes, done.metaBytes + done.bodyBytes);
    for (const record of records) {
      const page = await getPage(record.id);
      assert.equal(page.schemaVersion, 2);
      assert.equal((await getChunks(record.id))[0].text, record.chunks[0].text);
    }
  });
});

test('saving identical chunks and derived records twice preserves replacements', async () => {
  await withDatabase({}, async () => {
    const record = await createRecord(capture('A saved paragraph that must survive recapture.'));
    const terms = [{ id: 'term', pageId: record.page.id, token: 'paragraph' }];
    for (let i = 0; i < 2; i++) {
      await commitPage({ ...record, terms }, guardsFrom(await readMeta()));
    }
    assert.equal((await getChunks(record.page.id)).map(c => c.text).join(''), 'A saved paragraph that must survive recapture.');
    const db = await openDatabase();
    const stored = await new Promise(resolve => {
      const request = db.transaction('terms').objectStore('terms').get('term');
      request.onsuccess = () => resolve(request.result);
    });
    assert.equal(stored.token, 'paragraph');
  });
});

test('no-op maintenance preserves the search revision but actual expiry advances it', async () => {
  await withDatabase({}, async () => {
    const now = Date.now();
    const record = await createRecord(capture('fresh saved paragraph'), now);
    await commitPage(record, guardsFrom(await readMeta()));
    const revision = (await readMeta()).revision;
    await runMaintenance({ now });
    await runMaintenance({ now });
    assert.equal((await readMeta()).revision, revision);
    const old = await createHistoryRecord({ url: 'https://old.example/', lastVisitedAt: now - 91 * DAY_MS }, now);
    await commitPage(old, guardsFrom(await readMeta()));
    const beforeExpiry = (await readMeta()).revision;
    await runMaintenance({ now });
    assert.ok((await readMeta()).revision > beforeExpiry);
  });
});

test('metadata merge keeps captured text, timestamps, and a manual pin', async () => {
  await withDatabase({ autoMigrate: true }, async () => {
    const { page, chunks } = await createRecord(capture('Keep this distinctive paragraph about large files.'));
    const capturedAt = page.capturedAt;
    await commitPage({ page, chunks, historyAliases: [] }, guardsFrom(await readMeta()));
    const laterVisit = Date.now() + 60_000;
    const history = await createHistoryRecord({
      url: 'https://example.com/tool?utm_source=later', title: 'Example tool', lastVisitedAt: laterVisit,
    });
    const merged = mergePage(await getPage(page.id), history.page);
    await commitPage({ page: merged, historyAliases: history.historyAliases }, guardsFrom(await readMeta()));
    const after = await getPage(page.id);
    assert.equal(after.pinned, true);
    assert.equal(after.captureSource, 'manual');
    assert.equal(after.capturedAt, capturedAt);
    assert.equal(after.contentHash, page.contentHash);
    assert.equal(after.lastVisitedAt, laterVisit);
    assert.equal(after.historyPresent, true);
    assert.match((await getChunks(page.id)).map(chunk => chunk.text).join('\n'), /large files/);
  });
});

test('keepPage promotes a history-only record without inventing text', async () => {
  await withDatabase({ autoMigrate: true }, async () => {
    const history = await createHistoryRecord({
      url: 'https://example.org/notes', title: 'Notes', lastVisitedAt: 1_700_000_000_000,
    });
    await commitPage({
      page: history.page, chunks: [], historyAliases: history.historyAliases,
    }, guardsFrom(await readMeta()));
    const kept = await keepPage(history.page.id, 1_700_000_100_000);
    assert.equal(kept.pinned, true);
    assert.equal(kept.savedAt, 1_700_000_100_000);
    assert.equal(kept.contentHash, null);
    assert.equal(kept.capturedAt, null);
    assert.equal(kept.indexingStatus, 'metadata_only');
    assert.deepEqual(await getChunks(history.page.id), []);
  });
});

test('stale commit after forget cannot restore a deleted page', async () => {
  await withDatabase({ autoMigrate: true }, async () => {
    const { page, chunks } = await createRecord(capture('text that should stay forgotten'));
    await commitPage({ page, chunks, historyAliases: [] }, guardsFrom(await readMeta()));
    const before = await readMeta();
    const guards = {
      deletionGeneration: before.deletionGeneration,
      policyRevision: before.policyRevision,
    };
    const stored = await getPage(page.id);
    const storedChunks = await getChunks(page.id);
    await deletePages([page.id], 'forget');
    await assert.rejects(commitPage({ page: stored, chunks: storedChunks, historyAliases: [] }, guards));
    assert.equal(await getPage(page.id), undefined);
    assert.deepEqual(await getChunks(page.id), []);
    assert.equal((await readMeta()).pageCount, 0);
  });
});

test('policy validation rejects invalid retention, dates, and ranges', () => {
  const now = 1_700_000_000_000;
  assert.equal(validatePolicy({}, now).retentionDays, 90);
  assert.throws(() => validatePolicy({ retentionDays: 0 }, now), /1 and 90/);
  assert.throws(() => validatePolicy({ retentionDays: 91 }, now), /1 and 90/);
  assert.throws(() => validatePolicy({ importDays: 91 }, now), /retention/);
  assert.throws(() => validatePolicy({ from: now + DAY_MS }, now), /future/);
  assert.throws(() => validatePolicy({ from: now - 10 * DAY_MS, to: now - 20 * DAY_MS }, now), /before the end/);
  assert.throws(() => validatePolicy({ from: now - 91 * DAY_MS }, now), /90 days/);
});

test('automatic data expires at the 90-day boundary and already-expired imports stay expired', async () => {
  const now = 1_800_000_000_000;
  await withDatabase({ autoMigrate: true }, async () => {
    const history = await createHistoryRecord({
      url: 'https://example.com/old', title: 'Old', lastVisitedAt: now - 90 * DAY_MS,
    }, now);
    await commitPage({ page: history.page, chunks: [], historyAliases: history.historyAliases }, guardsFrom(await readMeta()));
    assert.equal(await getPage(history.page.id, { now }), undefined);
    const report = await runMaintenance({ now, batchSize: 10 });
    assert.ok(report.expiredPages >= 1);
    assert.equal(await getPage(history.page.id, { now, includeExpired: true }), undefined);
    const tooOld = await createHistoryRecord({
      url: 'https://example.com/ancient', title: 'Ancient', lastVisitedAt: now - 91 * DAY_MS,
    }, now);
    await commitPage({ page: tooOld.page, chunks: [], historyAliases: tooOld.historyAliases }, guardsFrom(await readMeta()));
    assert.equal(await getPage(tooOld.page.id, { now }), undefined);
    await runMaintenance({ now });
    assert.equal((await listPages({ now, includeExpired: true })).pages.length, 0);
  });
});

test('shorter retention and old bodies expire independently of recent visits', async () => {
  const now = 1_800_100_000_000;
  await withDatabase({ autoMigrate: true }, async () => {
    const { page, chunks } = await createRecord(capture('Automatic body that should expire independently.'), now - 40 * DAY_MS);
    const unpinned = pageMetadata({
      ...page, pinned: false, savedAt: null, captureSource: 'site_capture',
      capturedAt: now - 40 * DAY_MS, lastVisitedAt: now, historyPresent: true,
    });
    await commitPage({ page: unpinned, chunks, historyAliases: [] }, guardsFrom(await readMeta()));
    assert.match((await getChunks(unpinned.id, { now })).map(chunk => chunk.text).join(''), /expire independently/);
    await updatePolicy({ retentionDays: 30, importDays: 30 }, now);
    const visible = await getPage(unpinned.id, { now });
    assert.equal(visible.contentHash, null);
    assert.equal(visible.historyPresent, true);
    assert.deepEqual(await getChunks(unpinned.id, { now }), []);
    const report = await runMaintenance({ now });
    assert.ok(report.expiredBodies >= 1);
    const after = await getPage(unpinned.id, { now, includeExpired: true });
    assert.equal(after.contentHash, null);
    assert.equal(after.historyPresent, true);
  });
});

test('pinned pages keep text past automatic retention', async () => {
  const now = 1_800_200_000_000;
  await withDatabase({ autoMigrate: true }, async () => {
    const { page, chunks } = await createRecord(capture('Pinned text remains available.'), now - 100 * DAY_MS);
    await commitPage({ page: { ...page, capturedAt: now - 100 * DAY_MS }, chunks, historyAliases: [] }, guardsFrom(await readMeta()));
    await runMaintenance({ now });
    const kept = await getPage(page.id, { now });
    assert.equal(kept.pinned, true);
    assert.match((await getChunks(page.id, { now })).map(chunk => chunk.text).join(''), /Pinned text/);
  });
});

test('budget pressure evicts oldest unpinned pages and refuses a manual save over budget', async () => {
  const now = 1_800_300_000_000;
  await withDatabase({ autoMigrate: true }, async () => {
    const first = await createRecord(capture('first automatic snapshot'), now - DAY_MS);
    const unpinnedFirst = pageMetadata({
      ...first.page, pinned: false, savedAt: null, captureSource: 'site_capture', lastVisitedAt: now - DAY_MS,
    });
    await commitPage({ page: unpinnedFirst, chunks: first.chunks, historyAliases: [] }, guardsFrom(await readMeta()));
    const afterFirst = await getUsage(now);
    await updatePolicy({ collectionBudgetBytes: Math.max(1, afterFirst.estimatedBytes - 10) }, now, { unsafe: true });
    const report = await runMaintenance({ now });
    assert.ok(report.evictedPages >= 1);
    assert.equal(await getPage(unpinnedFirst.id, { now }), undefined);

    await updatePolicy({ collectionBudgetBytes: 100 * 1024 * 1024 }, now, { unsafe: true });
    const pinned = await createRecord(capture('pinned page that fills the budget'), now);
    await commitPage({ page: pinned.page, chunks: pinned.chunks, historyAliases: [] }, guardsFrom(await readMeta()));
    const filled = await getUsage(now);
    await updatePolicy({ collectionBudgetBytes: filled.estimatedBytes }, now, { unsafe: true });
    const extra = await createRecord(capture('manual save that needs space', { url: 'https://example.com/other' }), now);
    await assert.rejects(commitPage({
      page: extra.page, chunks: extra.chunks, historyAliases: [],
    }, guardsFrom(await readMeta())), /collection space|collection is full/);
    assert.ok(await getPage(pinned.page.id, { now }));
    assert.equal(await getPage(extra.page.id, { now }), undefined);
    assert.equal((await readMeta()).budgetBlocked, true);
  });
});

test('an insertion evicts eligible history before rejecting a near-full collection', async () => {
  await withDatabase({}, async () => {
    const now = Date.now();
    const old = await createHistoryRecord({ url: 'https://old.example/', lastVisitedAt: now - DAY_MS }, now);
    await commitPage(old, guardsFrom(await readMeta()));
    const incoming = await createHistoryRecord({ url: 'https://new.example/', lastVisitedAt: now }, now);
    const used = (await getUsage()).estimatedBytes;
    await updatePolicy({ collectionBudgetBytes: used + 20 }, now, { unsafe: true });
    await commitPage(incoming, guardsFrom(await readMeta()));
    assert.equal(await getPage(old.page.id), undefined);
    assert.ok(await getPage(incoming.page.id));
    assert.ok((await getUsage()).estimatedBytes <= used + 20);
  });
});

test('admission counts freed derived bytes and evicts only enough pages', async () => {
  await withDatabase({}, async () => {
    const now = Date.now();
    const old = await createHistoryRecord({ url: 'https://old.example/', lastVisitedAt: now - DAY_MS }, now);
    await commitPage({ ...old, terms: [{ id: 'large-index', pageId: old.page.id, text: 'x'.repeat(2000) }] }, guardsFrom(await readMeta()));
    const recent = await createHistoryRecord({ url: 'https://recent.example/', lastVisitedAt: now - 1000 }, now);
    await commitPage(recent, guardsFrom(await readMeta()));
    const usage = await getUsage();
    await updatePolicy({ collectionBudgetBytes: usage.estimatedBytes }, now, { unsafe: true });
    const incoming = await createHistoryRecord({ url: 'https://incoming.example/', lastVisitedAt: now }, now);
    await commitPage(incoming, guardsFrom(await readMeta()));
    assert.equal(await getPage(old.page.id), undefined);
    assert.ok(await getPage(recent.page.id));
    assert.ok(await getPage(incoming.page.id));
    assert.equal((await getUsage()).termBytes, 0);
  });
});

import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureDatabase, closeDatabase, commitPage, deletePages, getPage, readMeta, clearCollection, getJob, getUsage, updatePolicy, openDatabase } from '../lib/db.js';
import { createRecord, createHistoryRecord } from '../lib/records.js';
import { IDBObjectStore } from 'fake-indexeddb';
import { DAY_MS } from '../lib/policy.js';
import {
  startHistoryImport, getHistoryImport, cancelHistoryImport, processHistoryImport,
  ingestHistoryItem, removeHistoryItems, setHistoryEnabled,
} from '../lib/history.js';

let dbSeq = 0;
const now = 1_800_400_000_000;

function dbName() {
  return `ftt-history-${Date.now()}-${++dbSeq}`;
}

function deleteDb(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = request.onblocked = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function withDatabase(run) {
  const name = dbName();
  await configureDatabase({ name, autoMigrate: true });
  try {
    return await run();
  } finally {
    await closeDatabase();
    await deleteDb(name);
  }
}

function fakeHistory(items) {
  return {
    search: async ({ startTime, endTime, maxResults }) => items
      .filter(item => item.lastVisitTime >= startTime && item.lastVisitTime <= endTime)
      .sort((a, b) => b.lastVisitTime - a.lastVisitTime || a.url.localeCompare(b.url))
      .slice(0, maxResults),
  };
}

function item(path, minutesAgo, host = 'example.com') {
  return {
    url: `https://${host}${path}`,
    title: path,
    lastVisitTime: now - minutesAgo * 60_000,
  };
}

test('import caps at 2,000 newest eligible pages and excludes hosts before the cap', async () => {
  await withDatabase(async () => {
    const items = [
      item('/private', 1, 'private.example'),
      ...Array.from({ length: 2001 }, (_, index) => item(`/p/${index}`, index + 2)),
    ];
    const { jobId } = await startHistoryImport({
      from: now - 30 * DAY_MS, to: now, limit: 2000,
      includeHosts: [], excludeHosts: ['private.example'],
    }, { historyApi: fakeHistory(items), now, batchSize: 200 });
    const result = await getHistoryImport(jobId);
    assert.equal(result.status, 'complete');
    assert.equal(result.accepted, 2000);
    assert.equal(result.inserted, 2000);
    assert.equal(await getPage((await createRecord({
      url: 'https://private.example/private', title: 'x', text: 'nope',
    })).page.id, { now }), undefined);
    const newest = await createRecord({ url: 'https://example.com/p/0', title: 'x', text: 'keep' });
    assert.ok(await getPage(newest.page.id, { now, includeExpired: true }));
  });
});

test('normalization collisions merge and oldest timestamps stay outside the window', async () => {
  await withDatabase(async () => {
    const items = [
      { url: 'https://example.com/tool?utm_source=a', title: 'A', lastVisitTime: now - 1000 },
      { url: 'https://example.com/tool?utm_source=b', title: 'B', lastVisitTime: now - 500 },
      { url: 'https://example.com/old', title: 'Old', lastVisitTime: now - 91 * DAY_MS },
    ];
    const { jobId } = await startHistoryImport({
      from: now - 30 * DAY_MS, to: now, limit: 2000,
    }, { historyApi: fakeHistory(items), now });
    const result = await getHistoryImport(jobId);
    assert.equal(result.inserted, 1);
    assert.equal(result.accepted, 1);
    const page = await getPage((await createRecord({
      url: 'https://example.com/tool', title: 'x', text: 'body',
    })).page.id, { now, includeExpired: true });
    assert.equal(page.historyPresent, true);
    assert.equal(page.lastVisitedAt, now - 500);
  });
});

test('partial saturation is labelled instead of silently skipping timestamps', async () => {
  await withDatabase(async () => {
    const items = Array.from({ length: 12 }, (_, index) => item(`/sat/${index}`, 1));
    const { jobId } = await startHistoryImport({
      from: now - 30 * DAY_MS, to: now, limit: 20,
    }, { historyApi: fakeHistory(items), now, startRaw: 2, rawCeiling: 8 });
    const result = await getHistoryImport(jobId);
    assert.equal(result.status, 'partial');
    assert.equal(result.partialReason, 'raw-ceiling');
    assert.ok(result.accepted <= 8);
  });
});

test('import can be cancelled and resumed without duplicating pages', async () => {
  await withDatabase(async () => {
    const items = [item('/a', 1), item('/b', 2)];
    const { jobId } = await startHistoryImport({
      from: now - 30 * DAY_MS, to: now, limit: 2000,
    }, { historyApi: fakeHistory(items), now, autoRun: false });
    await cancelHistoryImport(jobId);
    const cancelled = await processHistoryImport(jobId, { historyApi: fakeHistory(items), now });
    assert.equal(cancelled.status, 'cancelled');
    const { jobId: again } = await startHistoryImport({
      from: now - 30 * DAY_MS, to: now, limit: 2000,
    }, { historyApi: fakeHistory(items), now });
    const done = await getHistoryImport(again);
    assert.equal(done.status, 'complete');
    assert.equal(done.inserted, 2);
    const rerun = await processHistoryImport(again, { historyApi: fakeHistory(items), now });
    assert.equal(rerun.status, 'complete');
  });
});

test('history deletion preserves a manual overlap and removes history-only pages', async () => {
  await withDatabase(async () => {
    await setHistoryEnabled(true, now);
    const manual = await createRecord({ url: 'https://example.com/keep', title: 'Keep', text: 'saved body' }, now);
    await commitPage({ page: manual.page, chunks: manual.chunks, historyAliases: [] }, {
      deletionGeneration: (await readMeta()).deletionGeneration,
      policyRevision: (await readMeta()).policyRevision,
    });
    await ingestHistoryItem({ url: 'https://example.com/keep', title: 'Keep', lastVisitTime: now }, { now });
    await ingestHistoryItem({ url: 'https://example.com/temp', title: 'Temp', lastVisitTime: now }, { now });
    const temp = await getPage((await createRecord({
      url: 'https://example.com/temp', title: 'x', text: 'nope',
    })).page.id, { now, includeExpired: true });
    assert.ok(temp);
    await removeHistoryItems({ urls: ['https://example.com/keep', 'https://example.com/temp'] }, { now });
    const kept = await getPage(manual.page.id, { now });
    assert.equal(kept.pinned, true);
    assert.match((await (await import('../lib/db.js')).getChunks(manual.page.id, { now })).map(chunk => chunk.text).join(''), /saved body/);
    assert.equal(await getPage(temp.id, { now, includeExpired: true }), undefined);
  });
});

test('forget suppresses reimport until a later visit', async () => {
  await withDatabase(async () => {
    const { jobId } = await startHistoryImport({
      from: now - 30 * DAY_MS, to: now, limit: 10,
    }, { historyApi: fakeHistory([item('/gone', 3)]), now });
    const imported = await getHistoryImport(jobId);
    assert.equal(imported.inserted, 1);
    const page = await getPage((await createRecord({
      url: 'https://example.com/gone', title: 'x', text: 'nope',
    })).page.id, { now, includeExpired: true });
    await deletePages([page.id], 'forget', now);
    await startHistoryImport({
      from: now - 30 * DAY_MS, to: now, limit: 10,
    }, { historyApi: fakeHistory([item('/gone', 3)]), now });
    assert.equal(await getPage(page.id, { now, includeExpired: true }), undefined);
    await setHistoryEnabled(true, now);
    await ingestHistoryItem({ url: 'https://example.com/gone', title: 'Gone', lastVisitTime: now + 1 }, { now: now + 1 });
    assert.ok(await getPage(page.id, { now: now + 1, includeExpired: true }));
  });
});

test('clear and policy revocation during history lookup cannot authorize old import work', async () => {
  for (const invalidate of [() => clearCollection(now), () => setHistoryEnabled(false, now)]) {
    await withDatabase(async () => {
      const { jobId } = await startHistoryImport({}, { now, autoRun: false });
      const result = await processHistoryImport(jobId, {
        now, historyApi: { search: async () => { await invalidate(); return [item('/late', 1)]; } },
      });
      assert.equal((await readMeta()).pageCount, 0);
      assert.equal(result.status, 'cancelled');
      assert.notEqual((await getJob(jobId))?.status, 'running');
    });
  }
});

test('cancellation after a committed page cannot be overwritten by its batch checkpoint', async () => {
  await withDatabase(async () => {
    const { jobId } = await startHistoryImport({}, { now, autoRun: false });
    const originalPut = IDBObjectStore.prototype.put;
    let cancelling;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'pages' && !cancelling) {
        cancelling = new Promise(resolve => this.transaction.addEventListener('complete', () => {
          cancelHistoryImport(jobId).then(resolve);
        }, { once: true }));
      }
      return originalPut.apply(this, args);
    };
    try {
      await processHistoryImport(jobId, { now, batchSize: 100, historyApi: fakeHistory([item('/a', 1), item('/b', 2), item('/c', 3)]) });
      await cancelling;
      const status = await getHistoryImport(jobId);
      assert.equal(status.status, 'cancelled');
      assert.equal(status.accepted, 1);
      assert.equal((await readMeta()).pageCount, 1);
    } finally { IDBObjectStore.prototype.put = originalPut; }
  });
});

test('preset 90-day bounds use the background validation clock', async () => {
  await withDatabase(async () => {
    const { jobId } = await startHistoryImport({ days: 90 }, { now: now + 25, autoRun: false });
    const job = await getJob(jobId);
    assert.equal(job.from, now + 25 - 90 * DAY_MS);
    assert.equal(job.to, now + 25);
    await assert.rejects(startHistoryImport({ from: now - 90 * DAY_MS }, { now: now + 25, autoRun: false }), /lookback/);
  });
});

test('lookup and budget failures persist terminal progress and error', async () => {
  await withDatabase(async () => {
    const { jobId } = await startHistoryImport({}, { now, autoRun: false });
    await processHistoryImport(jobId, { now, historyApi: { search: async () => { throw new Error('Lookup unavailable'); } } }).catch(() => {});
    const failed = await getHistoryImport(jobId);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /Lookup unavailable/);
  });
  await withDatabase(async () => {
    const record = await createRecord({ url: 'https://pinned.example/', title: 'Pinned', text: 'x'.repeat(500) }, now);
    await commitPage(record, await readMeta());
    await updatePolicy({ collectionBudgetBytes: (await getUsage()).estimatedBytes + 800 }, now, { unsafe: true });
    const { jobId } = await startHistoryImport({}, { now, autoRun: false });
    await processHistoryImport(jobId, { now, historyApi: fakeHistory([item('/no-room', 1)]) }).catch(() => {});
    const failed = await getHistoryImport(jobId);
    assert.ok(['failed', 'partial'].includes(failed.status));
    assert.match(failed.error, /space|full|budget/);
  });
  await withDatabase(async () => {
    const manual = await createRecord({ url: 'https://example.com/a', title: 'A', text: 'Saved text' }, now);
    await commitPage(manual, await readMeta());
    await updatePolicy({ collectionBudgetBytes: (await getUsage()).estimatedBytes + 2000 }, now, { unsafe: true });
    const { jobId } = await startHistoryImport({}, { now, autoRun: false });
    await processHistoryImport(jobId, { now, historyApi: fakeHistory([item('/a', 1), item(`/${'x'.repeat(5000)}`, 2)]) });
    const result = await getHistoryImport(jobId);
    assert.equal(result.status, 'partial');
    assert.equal(result.accepted, 1);
    assert.equal(result.updated, 1);
    assert.match(result.error, /full/);
    assert.equal((await getJob(jobId)).acceptedIds, undefined);
  });
});

test('import retains all normalized aliases and only removes the last remaining history alias', async () => {
  await withDatabase(async () => {
    const a = item('/tool?utm_source=a', 2);
    const b = item('/tool?utm_source=b', 1);
    await startHistoryImport({}, { now, historyApi: fakeHistory([a, b]) });
    const id = (await createHistoryRecord({ url: a.url }, now)).page.id;
    await removeHistoryItems({ urls: [b.url] }, { now });
    const retained = await getPage(id, { now });
    assert.ok(retained);
    assert.equal(retained.lastVisitedAt, a.lastVisitTime);
    await removeHistoryItems({ urls: [a.url] }, { now });
    assert.equal(await getPage(id, { now }), undefined);
  });
});

test('bulk history removal strips provenance and aliases but preserves manual content', async () => {
  await withDatabase(async () => {
    await setHistoryEnabled(true, now);
    const manual = await createRecord({ url: 'https://example.com/kept', text: 'Keep my text' }, now);
    await commitPage(manual, await readMeta());
    await ingestHistoryItem(item('/kept', 0), { now });
    await removeHistoryItems({ allHistory: true }, { now });
    const page = await getPage(manual.page.id, { now });
    assert.equal(page.historyPresent, false);
    assert.equal(page.lastVisitedAt, null);
    assert.equal(page.contentHash, manual.page.contentHash);
    const db = await openDatabase();
    const count = await new Promise(resolve => {
      const request = db.transaction('historyAliases').objectStore('historyAliases').count();
      request.onsuccess = () => resolve(request.result);
    });
    assert.equal(count, 0);
  });
});

test('job bytes are counted and terminal imports discard accepted identities', async () => {
  await withDatabase(async () => {
    const { jobId } = await startHistoryImport({}, { now, autoRun: false });
    assert.ok((await getUsage()).jobBytes > 0);
    await processHistoryImport(jobId, { now, historyApi: fakeHistory([item('/one', 1)]) });
    const job = await getJob(jobId);
    assert.equal(job.acceptedIds, undefined);
    assert.equal((await getUsage()).jobBytes, new TextEncoder().encode(JSON.stringify(job)).length);
    await clearCollection(now);
    assert.equal((await getUsage()).jobBytes, 0);
  });
});

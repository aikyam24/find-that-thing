import { migrateLegacyRecord, pageMetadata, splitRecord } from './records.js';
import {
  DEFAULT_POLICY, applyExpiries, estimatedUsage, pageVisibility, projectVisible, validatePolicy,
} from './policy.js';

export const SCHEMA_VERSION = 2;
const DEFAULT_NAME = 'find-that-thing';
const WRITE_STORES = ['pages', 'chunks', 'terms', 'vectors', 'jobs', 'historyAliases', 'tombstones', 'meta'];
const DERIVED_COUNTERS = { terms: 'termBytes', vectors: 'vectorBytes', jobs: 'jobBytes', historyAliases: 'aliasBytes' };
const counterUpdates = new WeakMap();

let connection;
let config = { name: DEFAULT_NAME, autoMigrate: true, batchSize: 100 };

function utf8Bytes(text) {
  return new TextEncoder().encode(String(text || '')).length;
}

function chunkBytes(chunks) {
  return (chunks || []).reduce((sum, chunk) => sum + utf8Bytes(chunk.text), 0);
}

function metaBytesFor(page) {
  return utf8Bytes(JSON.stringify(page));
}

function adjustDerivedBytes(store, delta) {
  const key = DERIVED_COUNTERS[store.name];
  if (!key || !delta) return;
  const tx = store.transaction;
  const meta = tx.objectStore('meta');
  let counters = counterUpdates.get(tx);
  if (!counters) { counters = new Map(); counterUpdates.set(tx, counters); }
  let counter = counters.get(key);
  if (!counter) {
    counter = { delta: 0, value: null };
    counters.set(key, counter);
    const request = meta.get(key);
    request.onsuccess = () => {
      counter.value = (request.result || 0) + counter.delta;
      meta.put(Math.max(0, counter.value), key);
    };
  }
  counter.delta += delta;
  if (counter.value !== null) {
    counter.value += delta;
    meta.put(Math.max(0, counter.value), key);
  }
}

function putAccounted(store, value) {
  const previous = store.get(value.id);
  previous.onsuccess = () => {
    adjustDerivedBytes(store, metaBytesFor(value) - (previous.result ? metaBytesFor(previous.result) : 0));
    store.put(value);
  };
}

function recordUsage(page, chunks) {
  const metaSize = page ? metaBytesFor(page) : 0;
  const bodySize = chunkBytes(chunks);
  return {
    metaBytes: metaSize,
    bodyBytes: bodySize,
    pinnedBytes: page?.pinned ? metaSize + bodySize : 0,
    pinnedCount: page?.pinned ? 1 : 0,
  };
}

function needsMigration(record) {
  return Boolean(record) && (record.schemaVersion !== 2 || Array.isArray(record.chunks));
}

function asPage(record) {
  if (!record) return undefined;
  return needsMigration(record) ? migrateLegacyRecord(record).page : record;
}

function asChunks(record, stored) {
  if (record && Array.isArray(record.chunks)) return record.chunks;
  return (stored || []).slice().sort((a, b) => a.ordinal - b.ordinal);
}

function matchesFilters(page, filters = {}) {
  if (filters.hostname && page.hostname !== filters.hostname) return false;
  if (filters.pinned === true && !page.pinned) return false;
  if (filters.pinned === false && page.pinned) return false;
  return true;
}

function defaultStatus(state = 'complete') {
  return { state, cursor: null, migrated: 0, total: state === 'complete' ? 0 : null };
}

function metaFrom(values) {
  return {
    revision: values.revision || 0,
    deletionGeneration: values.deletionGeneration || 0,
    policyRevision: values.policyRevision || 0,
    migrationStatus: values.migrationStatus || defaultStatus('complete'),
    pageCount: values.pageCount || 0,
    bodyBytes: values.bodyBytes || 0,
    metaBytes: values.metaBytes || 0,
    pinnedBytes: values.pinnedBytes || 0,
    pinnedCount: values.pinnedCount || 0,
    termBytes: values.termBytes || 0,
    vectorBytes: values.vectorBytes || 0,
    jobBytes: values.jobBytes || 0,
    aliasBytes: values.aliasBytes || 0,
    modelBytes: values.modelBytes || 0,
    budgetBlocked: Boolean(values.budgetBlocked),
    suppressionCutoff: values.suppressionCutoff || 0,
    policy: values.policy || { ...DEFAULT_POLICY },
  };
}

function readMetaKeys(meta, done) {
  const keys = [
    'revision', 'deletionGeneration', 'policyRevision', 'migrationStatus', 'pageCount', 'bodyBytes',
    'metaBytes', 'pinnedBytes', 'pinnedCount', 'termBytes', 'vectorBytes', 'jobBytes', 'aliasBytes',
    'modelBytes', 'budgetBlocked', 'suppressionCutoff', 'policy',
  ];
  const values = {};
  let pending = keys.length;
  for (const key of keys) {
    const request = meta.get(key);
    request.onsuccess = () => {
      values[key] = request.result;
      if (--pending === 0) done(metaFrom(values));
    };
  }
}

function ensureStore(db, tx, name, options) {
  return db.objectStoreNames.contains(name) ? tx.objectStore(name) : db.createObjectStore(name, options);
}

function ensureIndex(store, name, keyPath) {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath);
}

function createSchema(db, tx, oldVersion) {
  const pages = ensureStore(db, tx, 'pages', { keyPath: 'id' });
  const meta = ensureStore(db, tx, 'meta');
  ensureIndex(pages, 'hostname', 'hostname');
  ensureIndex(pages, 'lastVisitedAt', 'lastVisitedAt');
  ensureIndex(pages, 'capturedAt', 'capturedAt');
  ensureIndex(pages, 'pinnedValue', 'pinnedValue');
  ensureIndex(pages, 'historyExpiresAt', 'historyExpiresAt');
  ensureIndex(pages, 'textExpiresAt', 'textExpiresAt');
  ensureIndex(ensureStore(db, tx, 'chunks', { keyPath: 'id' }), 'pageId', 'pageId');
  ensureIndex(ensureStore(db, tx, 'terms', { keyPath: 'id' }), 'pageId', 'pageId');
  const vectors = ensureStore(db, tx, 'vectors', { keyPath: 'id' });
  ensureIndex(vectors, 'pageId', 'pageId');
  ensureIndex(vectors, 'modelVersion', 'modelVersion');
  ensureIndex(ensureStore(db, tx, 'jobs', { keyPath: 'id' }), 'pageId', 'pageId');
  ensureIndex(ensureStore(db, tx, 'historyAliases', { keyPath: 'id' }), 'pageId', 'pageId');
  ensureStore(db, tx, 'tombstones', { keyPath: 'id' });
  if (oldVersion < 2) {
    meta.put(SCHEMA_VERSION, 'schemaVersion');
    if (oldVersion === 0) {
      meta.put(0, 'revision');
      meta.put(0, 'deletionGeneration');
      meta.put(0, 'policyRevision');
      meta.put(defaultStatus('complete'), 'migrationStatus');
      meta.put(0, 'pageCount');
      meta.put(0, 'bodyBytes');
      meta.put(0, 'metaBytes');
      meta.put(0, 'pinnedBytes');
      meta.put(0, 'pinnedCount');
      meta.put(0, 'termBytes');
      meta.put(0, 'vectorBytes');
      meta.put(0, 'jobBytes');
      meta.put(0, 'aliasBytes');
      meta.put(0, 'modelBytes');
      meta.put(false, 'budgetBlocked');
      meta.put(0, 'suppressionCutoff');
      meta.put({ ...DEFAULT_POLICY }, 'policy');
    } else {
      meta.put(defaultStatus('pending'), 'migrationStatus');
    }
  }
}

function transact(db, stores, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let output;
    let outdated = false;
    let failed;
    work(tx, {
      set(value) { output = value; },
      stale() { outdated = true; tx.abort(); },
      fail(error) { failed = error; try { tx.abort(); } catch { /* already aborting */ } },
    });
    tx.oncomplete = () => { if (failed) reject(failed); else resolve(output); };
    tx.onabort = tx.onerror = () => {
      if (failed) reject(failed);
      else if (outdated) reject(new Error('The collection changed while saving. Save the page again.'));
      else if (tx.error?.name === 'QuotaExceededError') {
        reject(new Error('This browser profile is out of space for Find That Thing. Free space or raise the collection budget.'));
      } else reject(tx.error || new Error(mode === 'readonly' ? 'Could not read saved pages.' : 'Could not update your saved pages.'));
    };
  });
}

function deleteByIndex(store, indexName, key, done = () => {}) {
  const request = store.index(indexName).openCursor(IDBKeyRange.only(key));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) { done(); return; }
    adjustDerivedBytes(store, -metaBytesFor(cursor.value));
    cursor.delete();
    cursor.continue();
  };
}

function putDerived(store, pageId, records) {
  deleteByIndex(store, 'pageId', pageId, () => {
    for (const record of records || []) {
      if (DERIVED_COUNTERS[store.name]) putAccounted(store, record);
      else store.put(record);
    }
  });
}

function replaceChunks(store, pageId, chunks) {
  putDerived(store, pageId, (chunks || []).map(chunk => ({ id: chunk.id, pageId, text: chunk.text, ordinal: chunk.ordinal })));
}

function writableError(meta) {
  if (meta.migrationStatus?.state && meta.migrationStatus.state !== 'complete') {
    return new Error('Find That Thing is still upgrading saved pages. Try again in a moment.');
  }
  return null;
}

function writeUsage(meta, current, delta = {}) {
  const next = {
    pageCount: Math.max(0, current.pageCount + (delta.pageCount || 0)),
    bodyBytes: Math.max(0, current.bodyBytes + (delta.bodyBytes || 0)),
    metaBytes: Math.max(0, current.metaBytes + (delta.metaBytes || 0)),
    pinnedBytes: Math.max(0, current.pinnedBytes + (delta.pinnedBytes || 0)),
    pinnedCount: Math.max(0, current.pinnedCount + (delta.pinnedCount || 0)),
    budgetBlocked: delta.budgetBlocked ?? current.budgetBlocked,
  };
  meta.put(next.pageCount, 'pageCount');
  meta.put(next.bodyBytes, 'bodyBytes');
  meta.put(next.metaBytes, 'metaBytes');
  meta.put(next.pinnedBytes, 'pinnedBytes');
  meta.put(next.pinnedCount, 'pinnedCount');
  meta.put(Boolean(next.budgetBlocked), 'budgetBlocked');
  return next;
}

function usageDelta(from, to, pageDelta = 0) {
  return {
    pageCount: pageDelta,
    bodyBytes: to.bodyBytes - from.bodyBytes,
    metaBytes: to.metaBytes - from.metaBytes,
    pinnedBytes: to.pinnedBytes - from.pinnedBytes,
    pinnedCount: to.pinnedCount - from.pinnedCount,
  };
}

function logicalBytes(current) {
  return (current.metaBytes || 0) + (current.bodyBytes || 0) + (current.termBytes || 0)
    + (current.vectorBytes || 0) + (current.jobBytes || 0) + (current.aliasBytes || 0);
}

function openRaw() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(config.name, SCHEMA_VERSION);
    request.onupgradeneeded = event => createSchema(request.result, request.transaction, event.oldVersion);
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); connection = null; };
      resolve(request.result);
    };
    request.onerror = () => { connection = null; reject(request.error); };
    request.onblocked = () => { connection = null; reject(new Error('Close other Find That Thing windows and try again.')); };
  });
}

function planMigration(db) {
  return transact(db, ['pages', 'meta'], 'readwrite', (tx, { set }) => {
    const meta = tx.objectStore('meta');
    const pages = tx.objectStore('pages');
    readMetaKeys(meta, current => {
      const status = current.migrationStatus;
      if (status.state === 'complete' || status.total != null) {
        set(current);
        return;
      }
      const count = pages.count();
      count.onsuccess = () => {
        const next = { ...status, state: 'pending', total: count.result, migrated: status.migrated || 0 };
        meta.put(next, 'migrationStatus');
        meta.put(count.result, 'pageCount');
        set({ ...current, migrationStatus: next, pageCount: count.result });
      };
    });
  });
}

function migrateBatch(db, batchSize) {
  return transact(db, ['pages', 'chunks', 'meta'], 'readwrite', (tx, { set }) => {
    const pages = tx.objectStore('pages');
    const chunks = tx.objectStore('chunks');
    const meta = tx.objectStore('meta');
    readMetaKeys(meta, current => {
      const status = current.migrationStatus;
      if (!status || status.state === 'complete') {
        set({ complete: true, migrated: status?.migrated || 0 });
        return;
      }
      const range = status.cursor ? IDBKeyRange.lowerBound(status.cursor, true) : null;
      let scanned = 0;
      let migrated = 0;
      let lastKey = status.cursor;
      const delta = { bodyBytes: 0, metaBytes: 0, pinnedBytes: 0, pinnedCount: 0 };
      const request = pages.openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || scanned >= batchSize) {
          const complete = !cursor;
          meta.put({
            state: complete ? 'complete' : 'pending',
            cursor: complete ? null : lastKey,
            migrated: (status.migrated || 0) + migrated,
            total: status.total,
          }, 'migrationStatus');
          writeUsage(meta, current, delta);
          meta.put(current.revision + 1, 'revision');
          set({ complete, migrated: (status.migrated || 0) + migrated });
          return;
        }
        lastKey = cursor.key;
        scanned += 1;
        if (needsMigration(cursor.value)) {
          const { page, chunks: parts } = migrateLegacyRecord(cursor.value);
          replaceChunks(chunks, page.id, parts);
          pages.put(page);
          const usage = recordUsage(page, parts);
          for (const key of Object.keys(delta)) delta[key] += usage[key];
          migrated += 1;
        }
        cursor.continue();
      };
    });
  });
}

async function finishMigration(db) {
  await planMigration(db);
  for (;;) {
    if ((await migrateBatch(db, config.batchSize)).complete) return;
  }
}

export async function configureDatabase(options = {}) {
  await closeDatabase();
  config = { name: DEFAULT_NAME, autoMigrate: true, batchSize: 100, ...options };
}

export async function closeDatabase() {
  if (!connection) return;
  const pending = connection;
  connection = null;
  try { (await pending).close(); } catch { /* already closed */ }
}

export function openDatabase() {
  if (!connection) {
    connection = (async () => {
      const db = await openRaw();
      if (config.autoMigrate) await finishMigration(db);
      return db;
    })().catch(error => { connection = null; throw error; });
  }
  return connection;
}

export async function runMigration({ batchSize = config.batchSize, maxBatches = Infinity } = {}) {
  const db = await openDatabase();
  await planMigration(db);
  let result = { complete: false };
  for (let batches = 0; batches < maxBatches; batches += 1) {
    result = await migrateBatch(db, batchSize);
    if (result.complete) break;
  }
  return readMeta();
}

export async function readMeta() {
  const db = await openDatabase();
  return transact(db, ['meta'], 'readonly', (tx, { set }) => {
    readMetaKeys(tx.objectStore('meta'), set);
  });
}

export async function getPage(id, { now = Date.now(), includeExpired = false } = {}) {
  const db = await openDatabase();
  return transact(db, ['pages', 'meta'], 'readonly', (tx, { set }) => {
    const request = tx.objectStore('pages').get(id);
    let record;
    let current;
    let pending = 2;
    const finish = () => {
      if (--pending !== 0) return;
      const page = asPage(record);
      if (includeExpired) {
        set(page);
        return;
      }
      set(projectVisible(page, current.policy, now)?.page);
    };
    request.onsuccess = () => { record = request.result; finish(); };
    readMetaKeys(tx.objectStore('meta'), value => { current = value; finish(); });
  });
}

export async function getChunks(pageId, { now = Date.now(), includeExpired = false } = {}) {
  const db = await openDatabase();
  return transact(db, ['pages', 'chunks', 'meta'], 'readonly', (tx, { set }) => {
    const pageReq = tx.objectStore('pages').get(pageId);
    const chunkReq = tx.objectStore('chunks').index('pageId').getAll(pageId);
    let record;
    let stored;
    let current;
    let pending = 3;
    const finish = () => {
      if (--pending !== 0) return;
      const page = asPage(record);
      const chunks = asChunks(record, stored);
      if (includeExpired) {
        set(chunks);
        return;
      }
      set(projectVisible(page, current.policy, now, chunks)?.chunks || []);
    };
    pageReq.onsuccess = () => { record = pageReq.result; finish(); };
    chunkReq.onsuccess = () => { stored = chunkReq.result; finish(); };
    readMetaKeys(tx.objectStore('meta'), value => { current = value; finish(); });
  });
}

export async function listPages({ cursor, limit = 100, filters = {}, now = Date.now(), includeExpired = false } = {}) {
  const db = await openDatabase();
  return transact(db, ['pages', 'meta'], 'readonly', (tx, { set }) => {
    readMetaKeys(tx.objectStore('meta'), current => {
      const pages = [];
      const range = cursor ? IDBKeyRange.lowerBound(cursor, true) : null;
      const request = tx.objectStore('pages').openCursor(range);
      request.onsuccess = () => {
        const next = request.result;
        if (!next) {
          set({ pages, nextCursor: null });
          return;
        }
        const raw = asPage(next.value);
        const page = includeExpired ? raw : projectVisible(raw, current.policy, now)?.page;
        if (page && matchesFilters(page, filters)) pages.push(page);
        if (pages.length >= limit) {
          set({ pages, nextCursor: next.key });
          return;
        }
        next.continue();
      };
    });
  });
}

async function commitPageAttempt(input, guards) {
  const db = await openDatabase();
  const page = pageMetadata(input.page);
  const replaceText = Array.isArray(input.chunks);
  const aliases = input.historyAliases || [];
  return transact(db, WRITE_STORES, 'readwrite', (tx, { set, stale, fail }) => {
    const pages = tx.objectStore('pages');
    const chunks = tx.objectStore('chunks');
    const terms = tx.objectStore('terms');
    const vectors = tx.objectStore('vectors');
    const jobs = tx.objectStore('jobs');
    const historyAliases = tx.objectStore('historyAliases');
    const meta = tx.objectStore('meta');
    const previousReq = pages.get(page.id);
    const oldChunkReq = chunks.index('pageId').getAll(page.id);
    let current;
    let previous;
    let oldStored;
    let importJob;
    let aliasDelta = 0;
    let derivedDelta = 0;
    let pending = 4 + (input.importJobId ? 1 : 0);
    const finish = () => {
      if (--pending !== 0) return;
      const blocked = writableError(current);
      if (blocked) {
        fail(blocked);
        return;
      }
      if (current.deletionGeneration !== guards.deletionGeneration || current.policyRevision !== guards.policyRevision) {
        stale();
        return;
      }
      if (input.importJobId && (!importJob || importJob.status !== 'running')) {
        fail(new Error('History import was cancelled.'));
        return;
      }
      const existing = asPage(previous);
      const nextJob = importJob ? {
        ...importJob,
        accepted: importJob.accepted + 1,
        acceptedIds: [...importJob.acceptedIds, page.id],
        inserted: importJob.inserted + (existing ? 0 : 1),
        updated: importJob.updated + (existing ? 1 : 0),
      } : null;
      if (importJob?.acceptedIds.includes(page.id)) { set({ skipped: true }); return; }
      const jobDelta = nextJob ? metaBytesFor(nextJob) - metaBytesFor(importJob) : 0;
      const storedPage = applyExpiries(page, current.policy);
      const oldChunks = existing ? asChunks(previous, oldStored) : [];
      const nextChunks = replaceText ? input.chunks : oldChunks;
      const oldUsage = recordUsage(existing, oldChunks);
      const nextUsage = recordUsage(storedPage, nextChunks);
      const nextLogical = logicalBytes(current) - oldUsage.metaBytes - oldUsage.bodyBytes + nextUsage.metaBytes + nextUsage.bodyBytes + aliasDelta + derivedDelta + jobDelta;
      if (nextLogical > current.policy.collectionBudgetBytes) {
        writeUsage(meta, current, { budgetBlocked: true });
        const manual = storedPage.pinned || storedPage.captureSource === 'manual';
        set({
          reserveBytes: nextLogical - logicalBytes(current),
          error: new Error(manual
            ? 'Not enough collection space to save this page. Free space or raise the collection budget.'
            : 'The collection is full. Automatic saving is paused until you free space.'),
        });
        return;
      }
      pages.put(storedPage);
      if (replaceText) replaceChunks(chunks, storedPage.id, nextChunks);
      if (input.terms) putDerived(terms, storedPage.id, input.terms);
      if (input.jobs) putDerived(jobs, storedPage.id, input.jobs);
      if (input.vectors) putDerived(vectors, storedPage.id, input.vectors);
      for (const alias of aliases) putAccounted(historyAliases, alias);
      if (nextJob) putAccounted(jobs, nextJob);
      meta.put(current.revision + 1, 'revision');
      writeUsage(meta, current, {
        ...usageDelta(oldUsage, nextUsage, existing ? 0 : 1),
        budgetBlocked: false,
      });
      set({ revision: current.revision + 1 });
    };
    if (input.importJobId) {
      const request = jobs.get(input.importJobId);
      request.onsuccess = () => { importJob = request.result; finish(); };
    }
    // Account only for the incoming page's derived changes before admission.
    let remaining = aliases.length + ['terms', 'jobs', 'vectors'].filter(name => input[name]).length;
    if (!remaining) finish();
    const counted = () => { if (--remaining === 0) finish(); };
    for (const alias of aliases) {
      const request = historyAliases.get(alias.id);
      request.onsuccess = () => {
        aliasDelta += metaBytesFor(alias) - (request.result ? metaBytesFor(request.result) : 0);
        counted();
      };
    }
    for (const name of ['terms', 'jobs', 'vectors']) {
      if (!input[name]) continue;
      const request = tx.objectStore(name).index('pageId').getAll(page.id);
      request.onsuccess = () => {
        derivedDelta += input[name].reduce((sum, entry) => sum + metaBytesFor(entry), 0)
          - request.result.reduce((sum, entry) => sum + metaBytesFor(entry), 0);
        counted();
      };
    }
    previousReq.onsuccess = () => { previous = previousReq.result; finish(); };
    oldChunkReq.onsuccess = () => { oldStored = oldChunkReq.result; finish(); };
    readMetaKeys(meta, value => { current = value; finish(); });
  });
}

export async function commitPage(input, guards) {
  let checkedExpiry = false;
  for (;;) {
    const result = await commitPageAttempt(input, guards);
    if (!result?.error) return result;
    if (!checkedExpiry) {
      checkedExpiry = true;
      let cursor = null;
      do { cursor = (await expireBatch({ cursor })).nextCursor; } while (cursor);
      continue; // Recompute admission against the post-expiry record and counters.
    }
    const evicted = await evictOldestUnpinned({
      reserveBytes: result.reserveBytes, excludeId: input.page.id, guards, importJobId: input.importJobId,
    });
    if (!evicted.evictedPages) throw result.error;
  }
}

export async function deletePages(ids, reason = 'forget', now = Date.now()) {
  const db = await openDatabase();
  return transact(db, WRITE_STORES, 'readwrite', (tx, { set }) => {
    const pages = tx.objectStore('pages');
    const chunks = tx.objectStore('chunks');
    const terms = tx.objectStore('terms');
    const vectors = tx.objectStore('vectors');
    const jobs = tx.objectStore('jobs');
    const historyAliases = tx.objectStore('historyAliases');
    const tombstones = tx.objectStore('tombstones');
    const meta = tx.objectStore('meta');
    let current;
    let applied = false;
    const lookups = ids.map(id => {
      const pageReq = pages.get(id);
      const chunkReq = chunks.index('pageId').getAll(id);
      const lookup = { id, record: undefined, stored: undefined, pending: 2, ready: false };
      const next = () => {
        if (--lookup.pending !== 0) return;
        lookup.ready = true;
        apply();
      };
      pageReq.onsuccess = () => { lookup.record = pageReq.result; next(); };
      chunkReq.onsuccess = () => { lookup.stored = chunkReq.result; next(); };
      return lookup;
    });
    const apply = () => {
      if (applied || !current || lookups.some(lookup => !lookup.ready)) return;
      applied = true;
      let removed = 0;
      let delta = {};
      for (const lookup of lookups) {
        const page = asPage(lookup.record);
        if (!page) continue;
        const chunksForPage = asChunks(lookup.record, lookup.stored);
        const usage = recordUsage(page, chunksForPage);
        removed += 1;
        delta = {
          pageCount: (delta.pageCount || 0) - 1,
          bodyBytes: (delta.bodyBytes || 0) - usage.bodyBytes,
          metaBytes: (delta.metaBytes || 0) - usage.metaBytes,
          pinnedBytes: (delta.pinnedBytes || 0) - usage.pinnedBytes,
          pinnedCount: (delta.pinnedCount || 0) - usage.pinnedCount,
        };
        pages.delete(lookup.id);
        deleteByIndex(chunks, 'pageId', lookup.id);
        deleteByIndex(terms, 'pageId', lookup.id);
        deleteByIndex(vectors, 'pageId', lookup.id);
        deleteByIndex(jobs, 'pageId', lookup.id);
        deleteByIndex(historyAliases, 'pageId', lookup.id);
        if (reason === 'forget' || reason === 'site-forget') {
          tombstones.put({
            id: page.id, normalizedIdentity: page.normalizedIdentity,
            forgottenAt: now, forgetThrough: now, reason,
          });
        }
      }
      meta.put(current.revision + 1, 'revision');
      meta.put(current.deletionGeneration + 1, 'deletionGeneration');
      writeUsage(meta, current, delta);
      set({ removed, revision: current.revision + 1 });
    };
    readMetaKeys(meta, value => { current = value; apply(); });
  });
}

export async function keepPage(id, now = Date.now()) {
  const page = await getPage(id, { now, includeExpired: true });
  if (!page) throw new Error('This page has been forgotten.');
  const meta = await readMeta();
  await commitPage({
    page: pageMetadata({ ...page, pinned: true, savedAt: page.savedAt ?? now, textExpiresAt: null }),
  }, { deletionGeneration: meta.deletionGeneration, policyRevision: meta.policyRevision });
  return getPage(id);
}

export async function clearCollection(now = Date.now()) {
  const db = await openDatabase();
  return transact(db, WRITE_STORES, 'readwrite', (tx, { set }) => {
    for (const name of ['pages', 'chunks', 'terms', 'vectors', 'jobs', 'historyAliases', 'tombstones']) {
      tx.objectStore(name).clear();
    }
    const meta = tx.objectStore('meta');
    readMetaKeys(meta, current => {
      meta.put(current.revision + 1, 'revision');
      meta.put(current.deletionGeneration + 1, 'deletionGeneration');
      meta.put(now, 'suppressionCutoff');
      writeUsage(meta, current, {
        pageCount: -current.pageCount,
        bodyBytes: -current.bodyBytes,
        metaBytes: -current.metaBytes,
        pinnedBytes: -current.pinnedBytes,
        pinnedCount: -current.pinnedCount,
        budgetBlocked: false,
      });
      for (const key of Object.values(DERIVED_COUNTERS)) meta.put(0, key);
      meta.put({ ...defaultStatus('complete') }, 'migrationStatus');
      set({ revision: current.revision + 1 });
    });
  });
}

export async function snapshot(now = Date.now()) {
  const db = await openDatabase();
  return transact(db, ['pages', 'chunks', 'meta'], 'readonly', (tx, { set }) => {
    const pages = [];
    const pageReq = tx.objectStore('pages').openCursor();
    const chunkReq = tx.objectStore('chunks').getAll();
    const metaStore = tx.objectStore('meta');
    let current;
    let chunksReady = false;
    let pagesDone = false;
    const finish = () => {
      if (!current || !chunksReady || !pagesDone) return;
      const byPage = new Map();
      for (const chunk of chunkReq.result || []) {
        const list = byPage.get(chunk.pageId) || [];
        list.push(chunk);
        byPage.set(chunk.pageId, list);
      }
      set({
        pages: pages.map(record => {
          const projected = projectVisible(asPage(record), current.policy, now, asChunks(record, byPage.get(record.id)));
          return projected ? { ...projected.page, chunks: projected.chunks } : null;
        }).filter(Boolean),
        revision: current.revision,
        generation: current.deletionGeneration,
      });
    };
    pageReq.onsuccess = () => {
      const cursor = pageReq.result;
      if (cursor) {
        pages.push(cursor.value);
        cursor.continue();
        return;
      }
      pagesDone = true;
      finish();
    };
    chunkReq.onsuccess = () => { chunksReady = true; finish(); };
    readMetaKeys(metaStore, value => { current = value; finish(); });
  });
}

export async function saveRecord(record, expectedGeneration) {
  const meta = await readMeta();
  const { page, chunks, historyAliases } = splitRecord(record);
  return commitPage({ page, chunks, historyAliases }, {
    deletionGeneration: expectedGeneration ?? meta.deletionGeneration,
    policyRevision: meta.policyRevision,
  });
}

export function forgetRecord(id) {
  return deletePages([id], 'forget');
}

export function clearRecords() {
  return clearCollection();
}

export async function exportCollection() {
  const pages = [];
  let cursor;
  do {
    const batch = await listPages({ cursor, limit: 100 });
    for (const page of batch.pages) pages.push({ ...page, chunks: await getChunks(page.id) });
    cursor = batch.nextCursor;
  } while (cursor);
  return { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), pages };
}

function compactJob(job) {
  if (job.status === 'running') return job;
  const { acceptedIds, ...terminal } = job;
  return terminal;
}

export async function putJob(job) {
  const db = await openDatabase();
  return transact(db, ['jobs', 'meta'], 'readwrite', (tx, { set, fail }) => {
    const store = tx.objectStore('jobs');
    readMetaKeys(tx.objectStore('meta'), current => {
      const request = store.get(job.id);
      request.onsuccess = () => {
        const value = compactJob(job);
        const delta = metaBytesFor(value) - (request.result ? metaBytesFor(request.result) : 0);
        if (delta > 0 && logicalBytes(current) + delta > current.policy.collectionBudgetBytes) {
          fail(new Error('Not enough collection space for this import.'));
          return;
        }
        putAccounted(store, value);
        set(value);
      };
    });
  });
}

// Read/modify/write a running job atomically; a missing or terminal job wins.
export async function updateRunningJob(id, changes, guards) {
  const db = await openDatabase();
  return transact(db, ['jobs', 'meta'], 'readwrite', (tx, { set }) => {
    readMetaKeys(tx.objectStore('meta'), current => {
      const store = tx.objectStore('jobs');
      const request = store.get(id);
      request.onsuccess = () => {
        const previous = request.result;
        if (!previous || previous.status !== 'running') { set(previous); return; }
        const invalid = guards && (guards.deletionGeneration !== current.deletionGeneration || guards.policyRevision !== current.policyRevision);
        let next = compactJob({ ...previous, ...(invalid ? { status: 'cancelled', partialReason: 'policy-changed' } : changes) });
        const delta = metaBytesFor(next) - metaBytesFor(previous);
        if (delta > 0 && logicalBytes(current) + delta > current.policy.collectionBudgetBytes) {
          next = compactJob({ ...previous, status: previous.accepted ? 'partial' : 'failed', error: 'Collection budget reached.', partialReason: 'budget' });
        }
        putAccounted(store, next);
        set(next);
      };
    });
  });
}

export async function getJob(id) {
  const db = await openDatabase();
  return transact(db, ['jobs'], 'readonly', (tx, { set }) => {
    const request = tx.objectStore('jobs').get(id);
    request.onsuccess = () => set(request.result);
  });
}

export async function deleteJob(id) {
  const db = await openDatabase();
  return transact(db, ['jobs', 'meta'], 'readwrite', tx => {
    const store = tx.objectStore('jobs');
    const request = store.get(id);
    request.onsuccess = () => {
      if (request.result) adjustDerivedBytes(store, -metaBytesFor(request.result));
      store.delete(id);
    };
  });
}

export async function getTombstone(id) {
  const db = await openDatabase();
  return transact(db, ['tombstones'], 'readonly', (tx, { set }) => {
    const request = tx.objectStore('tombstones').get(id);
    request.onsuccess = () => set(request.result);
  });
}

export async function deleteTombstone(id) {
  const db = await openDatabase();
  return transact(db, ['tombstones'], 'readwrite', (tx, { set }) => {
    tx.objectStore('tombstones').delete(id);
    set();
  });
}

export async function listHistoryOnlyIds({ batchSize = 100, cursor = null } = {}) {
  const batch = await listPages({ cursor, limit: batchSize, includeExpired: true });
  return {
    ids: batch.pages.filter(page => page.historyPresent && !page.pinned && !page.contentHash).map(page => page.id),
    nextCursor: batch.nextCursor,
  };
}

// null means all browser history; otherwise remove only the named raw-URL aliases.
export async function removeHistoryAliases(aliasIds, now = Date.now()) {
  const db = await openDatabase();
  return transact(db, WRITE_STORES, 'readwrite', (tx, { set }) => {
    const pages = tx.objectStore('pages');
    const aliases = tx.objectStore('historyAliases');
    const meta = tx.objectStore('meta');
    const ids = aliasIds === null ? null : new Set(aliasIds);
    readMetaKeys(meta, initial => {
      let current = initial;
      let removed = 0;
      let changed = false;
      const request = pages.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          // Also invalidate an import that has not yet written its first page.
          meta.put(initial.deletionGeneration + 1, 'deletionGeneration');
          if (changed) meta.put(initial.revision + 1, 'revision');
          set({ removed });
          return;
        }
        const page = asPage(cursor.value);
        const lookup = aliases.index('pageId').getAll(page.id);
        lookup.onsuccess = () => {
          const deleted = lookup.result.filter(alias => ids === null || ids.has(alias.id));
          if (!deleted.length && !(ids === null && page.historyPresent)) { cursor.continue(); return; }
          changed = true;
          for (const alias of deleted) {
            aliases.delete(alias.id);
            adjustDerivedBytes(aliases, -metaBytesFor(alias));
          }
          const remaining = lookup.result.filter(alias => ids !== null && !ids.has(alias.id));
          const chunkReq = tx.objectStore('chunks').index('pageId').getAll(page.id);
          chunkReq.onsuccess = () => {
            const chunks = asChunks(cursor.value, chunkReq.result);
            const oldUsage = recordUsage(page, chunks);
            if (!remaining.length && !page.pinned && !page.contentHash) {
              pages.delete(page.id);
              for (const name of ['chunks', 'terms', 'vectors', 'jobs']) deleteByIndex(tx.objectStore(name), 'pageId', page.id);
              current = { ...current, ...writeUsage(meta, current, usageDelta(oldUsage, recordUsage(null, []), -1)) };
              removed++;
            } else {
              const next = applyExpiries(pageMetadata({
                ...page, historyPresent: remaining.length > 0,
                lastVisitedAt: remaining.length ? Math.max(...remaining.map(alias => alias.lastVisitedAt)) : null,
                historyExpiresAt: null,
              }), current.policy);
              pages.put(next);
              current = { ...current, ...writeUsage(meta, current, usageDelta(oldUsage, recordUsage(next, chunks))) };
            }
            cursor.continue();
          };
        };
      };
    });
  });
}

export async function getUsage(now = Date.now()) {
  const meta = await readMeta();
  const usage = estimatedUsage(meta, meta.policy);
  let browserQuota;
  try {
    if (globalThis.navigator?.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      browserQuota = { usage: estimate.usage || 0, quota: estimate.quota || 0 };
    }
  } catch { /* optional */ }
  return { ...usage, browserQuota, checkedAt: now };
}

export async function updatePolicy(input, now = Date.now(), { unsafe = false } = {}) {
  const policy = unsafe ? { ...DEFAULT_POLICY, ...input } : validatePolicy(input, now);
  const db = await openDatabase();
  await transact(db, ['meta'], 'readwrite', (tx, { set }) => {
    const meta = tx.objectStore('meta');
    readMetaKeys(meta, current => {
      meta.put(current.policyRevision + 1, 'policyRevision');
      meta.put(policy, 'policy');
      meta.put(current.revision + 1, 'revision');
      set({ policyRevision: current.policyRevision + 1, policy });
    });
  });
  return readMeta();
}

function ageOf(page) {
  return page.lastVisitedAt ?? page.capturedAt ?? page.createdAt ?? 0;
}

function stripText(page) {
  return pageMetadata({
    ...page,
    contentHash: null,
    extractorVersion: null,
    truncated: false,
    capturedAt: null,
    captureSource: page.pinned ? page.captureSource : null,
    textExpiresAt: null,
    indexingStatus: 'metadata_only',
  });
}

function stripHistory(page) {
  return pageMetadata({
    ...page,
    historyPresent: false,
    historyExpiresAt: null,
  });
}

export async function expireBatch({ now = Date.now(), batchSize = 100, cursor = null } = {}) {
  const db = await openDatabase();
  return transact(db, WRITE_STORES, 'readwrite', (tx, { set }) => {
    const pages = tx.objectStore('pages');
    const chunks = tx.objectStore('chunks');
    const terms = tx.objectStore('terms');
    const vectors = tx.objectStore('vectors');
    const jobs = tx.objectStore('jobs');
    const historyAliases = tx.objectStore('historyAliases');
    const meta = tx.objectStore('meta');
    readMetaKeys(meta, current => {
      const range = cursor ? IDBKeyRange.lowerBound(cursor, true) : null;
      let scanned = 0;
      let lastKey = cursor;
      let expiredPages = 0;
      let expiredBodies = 0;
      let collectionChanged = false;
      let delta = {};
      const request = pages.openCursor(range);
      request.onsuccess = () => {
        const next = request.result;
        if (!next || scanned >= batchSize) {
          if (collectionChanged) {
            meta.put(current.revision + 1, 'revision');
            writeUsage(meta, current, delta);
          }
          set({ expiredPages, expiredBodies, nextCursor: next ? lastKey : null });
          return;
        }
        lastKey = next.key;
        scanned += 1;
        const existing = asPage(next.value);
        const oldChunksReq = chunks.index('pageId').getAll(existing.id);
        oldChunksReq.onsuccess = () => {
          const oldChunks = asChunks(next.value, oldChunksReq.result);
          const oldUsage = recordUsage(existing, oldChunks);
          let page = applyExpiries(existing, current.policy);
          let vis = pageVisibility(page, current.policy, now);
          let changed = page.historyExpiresAt !== existing.historyExpiresAt || page.textExpiresAt !== existing.textExpiresAt;
          if (!vis.textLive && page.contentHash && !page.pinned) {
            replaceChunks(chunks, page.id, []);
            deleteByIndex(terms, 'pageId', page.id);
            deleteByIndex(vectors, 'pageId', page.id);
            deleteByIndex(jobs, 'pageId', page.id);
            page = stripText(page);
            expiredBodies += 1;
            changed = true;
            vis = pageVisibility(page, current.policy, now);
          }
          if (!vis.historyLive && page.historyPresent) {
            deleteByIndex(historyAliases, 'pageId', page.id);
            page = stripHistory(page);
            changed = true;
            vis = pageVisibility(page, current.policy, now);
          }
          if (!vis.live && !page.pinned) {
            collectionChanged = true;
            pages.delete(page.id);
            deleteByIndex(chunks, 'pageId', page.id);
            deleteByIndex(terms, 'pageId', page.id);
            deleteByIndex(vectors, 'pageId', page.id);
            deleteByIndex(jobs, 'pageId', page.id);
            deleteByIndex(historyAliases, 'pageId', page.id);
            expiredPages += 1;
            delta = {
              pageCount: (delta.pageCount || 0) - 1,
              bodyBytes: (delta.bodyBytes || 0) - oldUsage.bodyBytes,
              metaBytes: (delta.metaBytes || 0) - oldUsage.metaBytes,
              pinnedBytes: (delta.pinnedBytes || 0) - oldUsage.pinnedBytes,
              pinnedCount: (delta.pinnedCount || 0) - oldUsage.pinnedCount,
            };
          } else if (changed) {
            collectionChanged = true;
            pages.put(page);
            const nextUsage = recordUsage(page, vis.textLive ? oldChunks : []);
            const usage = usageDelta(oldUsage, nextUsage, 0);
            delta = {
              pageCount: (delta.pageCount || 0) + usage.pageCount,
              bodyBytes: (delta.bodyBytes || 0) + usage.bodyBytes,
              metaBytes: (delta.metaBytes || 0) + usage.metaBytes,
              pinnedBytes: (delta.pinnedBytes || 0) + usage.pinnedBytes,
              pinnedCount: (delta.pinnedCount || 0) + usage.pinnedCount,
            };
          }
          next.continue();
        };
      };
    });
  });
}

export async function evictOldestUnpinned({ now = Date.now(), batchSize = 100, reserveBytes = 0, excludeId = null, guards, importJobId } = {}) {
  const db = await openDatabase();
  return transact(db, WRITE_STORES, 'readwrite', (tx, { set, stale }) => {
    const pages = tx.objectStore('pages');
    const meta = tx.objectStore('meta');
    readMetaKeys(meta, current => {
      if (guards && (guards.deletionGeneration !== current.deletionGeneration || guards.policyRevision !== current.policyRevision)) { stale(); return; }
      const begin = () => {
        const budget = current.policy.collectionBudgetBytes - reserveBytes;
        if (logicalBytes(current) <= budget) {
          writeUsage(meta, current, { budgetBlocked: false });
          set({ evictedPages: 0, budgetBlocked: false });
          return;
        }
        if (budget < 0) { set({ evictedPages: 0, budgetBlocked: true }); return; }
        const found = [];
        const request = pages.index('pinnedValue').openCursor(IDBKeyRange.only(0));
        request.onsuccess = () => {
          const next = request.result;
          if (next) {
            if (next.value.id !== excludeId) found.push(asPage(next.value));
            next.continue();
            return;
          }
          found.sort((a, b) => Number(pageVisibility(a, current.policy, now).live) - Number(pageVisibility(b, current.policy, now).live) || ageOf(a) - ageOf(b) || a.id.localeCompare(b.id));
          const targets = found.slice(0, batchSize);
          let evictedPages = 0;
          let logical = logicalBytes(current);
          let delta = {};
          const removeNext = index => {
            if (index >= targets.length || logical <= budget) {
              const budgetBlocked = logical > budget;
              writeUsage(meta, current, { ...delta, budgetBlocked });
              if (evictedPages) meta.put(current.revision + 1, 'revision');
              set({ evictedPages, budgetBlocked });
              return;
            }
            const page = targets[index];
            const stored = {};
            const names = ['chunks', ...Object.keys(DERIVED_COUNTERS)];
            let pending = names.length;
            for (const name of names) {
              const lookup = tx.objectStore(name).index('pageId').getAll(page.id);
              lookup.onsuccess = () => {
                stored[name] = lookup.result;
                if (--pending) return;
                const usage = recordUsage(page, stored.chunks);
                const derivedBytes = Object.keys(DERIVED_COUNTERS).reduce((sum, storeName) =>
                  sum + stored[storeName].reduce((bytes, entry) => bytes + metaBytesFor(entry), 0), 0);
                pages.delete(page.id);
                for (const storeName of names) deleteByIndex(tx.objectStore(storeName), 'pageId', page.id);
                logical -= usage.metaBytes + usage.bodyBytes + derivedBytes;
                evictedPages++;
                const change = usageDelta(usage, recordUsage(null, []), -1);
                for (const key of Object.keys(change)) delta[key] = (delta[key] || 0) + change[key];
                removeNext(index + 1);
              };
            }
          };
          removeNext(0);
        };
      };
      if (importJobId) {
        const request = tx.objectStore('jobs').get(importJobId);
        request.onsuccess = () => {
          if (request.result?.status !== 'running') { set({ evictedPages: 0, budgetBlocked: false }); return; }
          begin();
        };
      } else begin();
    });
  });
}

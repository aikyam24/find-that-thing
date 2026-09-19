import {
  commitPage, getJob, getPage, getTombstone, putJob, readMeta, updatePolicy, updateRunningJob, removeHistoryAliases,
} from './db.js';
import { createHistoryRecord, hashText, mergePage, normalizeUrl } from './records.js';
import { validateImportRange } from './policy.js';

const RAW_CEILING = 50_000;
const START_RAW = 2_000;

function matchesHost(hostname, rule) {
  const host = String(rule || '').trim().toLowerCase().replace(/^\./, '');
  const name = String(hostname || '').toLowerCase();
  return Boolean(host) && (name === host || name.endsWith(`.${host}`));
}

function hostAllowed(hostname, includeHosts, excludeHosts) {
  if ((excludeHosts || []).some(rule => matchesHost(hostname, rule))) return false;
  if ((includeHosts || []).length && !(includeHosts || []).some(rule => matchesHost(hostname, rule))) return false;
  return true;
}

function publicJob(job) {
  if (!job) return undefined;
  const { acceptedIds, guards, ...rest } = job;
  return rest;
}

function compareItems(a, b) {
  return (b.lastVisitTime || 0) - (a.lastVisitTime || 0) || String(a.url).localeCompare(String(b.url));
}

async function eligibleItem(item, job, now) {
  let identity;
  try {
    identity = normalizeUrl(item.url);
  } catch {
    return { excluded: true };
  }
  const hostname = new URL(identity).hostname;
  if (!hostAllowed(hostname, job.includeHosts, job.excludeHosts)) return { excluded: true };
  const record = await createHistoryRecord({
    url: item.url, title: item.title, lastVisitedAt: item.lastVisitTime || now,
  }, now);
  const tombstone = await getTombstone(record.page.id);
  if (tombstone && (item.lastVisitTime || now) <= tombstone.forgetThrough) return { excluded: true };
  return { identity, record, hostname };
}

async function loadRaw(historyApi, job, deps = {}) {
  const ceiling = deps.rawCeiling || RAW_CEILING;
  let maxResults = deps.startRaw || START_RAW;
  let raw = [];
  for (;;) {
    raw = await historyApi.search({
      text: '', startTime: job.from, endTime: job.to, maxResults,
    }) || [];
    if (raw.length < maxResults || maxResults >= ceiling) break;
    maxResults = Math.min(ceiling, maxResults * 2);
  }
  return { raw, maxResults, ceiling };
}

export async function startHistoryImport(input = {}, deps = {}) {
  const now = deps.now ?? Date.now();
  const meta = await readMeta();
  const range = validateImportRange(input, meta.policy, now);
  const job = {
    id: deps.jobId || crypto.randomUUID(),
    kind: 'history-import',
    status: 'running',
    from: range.from,
    to: range.to,
    limit: range.limit,
    includeHosts: [...(input.includeHosts || [])],
    excludeHosts: [...(input.excludeHosts || [])],
    scanned: 0,
    accepted: 0,
    inserted: 0,
    updated: 0,
    excluded: 0,
    acceptedIds: [],
    partialReason: null,
    guards: { deletionGeneration: meta.deletionGeneration, policyRevision: meta.policyRevision },
    createdAt: now,
  };
  await putJob(job);
  if (deps.autoRun === false) return { jobId: job.id };
  return { jobId: job.id, ...(await processHistoryImport(job.id, deps)) };
}

export async function getHistoryImport(jobId) {
  return publicJob(await getJob(jobId));
}

export async function cancelHistoryImport(jobId) {
  return publicJob(await updateRunningJob(jobId, { status: 'cancelled' }));
}

function cancelledJob(jobId) {
  return { id: jobId, status: 'cancelled', partialReason: 'collection-cleared' };
}

export async function processHistoryImport(jobId, deps = {}) {
  const now = deps.now ?? Date.now();
  const historyApi = deps.historyApi;
  let job = await getJob(jobId);
  if (!job) return cancelledJob(jobId);
  if (job.status !== 'running') return publicJob(job);
  const guards = job.guards;
  // The job and each page write retain the original guards for their entire lifetime.
  const checkpoint = async changes => {
    job = await updateRunningJob(jobId, changes, guards);
    return job?.status === 'running';
  };
  try {
    if (!await checkpoint({})) return publicJob(job) || cancelledJob(jobId);
    if (!historyApi?.search) throw new Error('History access is not available.');
    const { raw, maxResults, ceiling } = await loadRaw(historyApi, job, deps);
    if (deps.hasPermission && !await deps.hasPermission()) {
      return publicJob(await updateRunningJob(jobId, { status: 'cancelled', partialReason: 'permission-removed' })) || cancelledJob(jobId);
    }
    if (!await checkpoint({ scanned: raw.length, excluded: 0 })) return publicJob(job) || cancelledJob(jobId);
    const unique = new Map();
    let excluded = 0;
    let equalTimeBoundary = false;
    for (const item of raw.slice().sort(compareItems)) {
      if (!Number.isFinite(item.lastVisitTime) || item.lastVisitTime < job.from || item.lastVisitTime > job.to) { excluded++; continue; }
      const judged = await eligibleItem(item, job, now);
      if (judged.excluded) { excluded++; continue; }
      const existing = unique.get(judged.identity);
      if (existing) {
        existing.record.historyAliases.push(...judged.record.historyAliases);
        continue;
      }
      if (unique.size >= job.limit) {
        const last = [...unique.values()].at(-1);
        if (item.lastVisitTime === last.item.lastVisitTime) equalTimeBoundary = true;
        // Continue collecting raw aliases for pages already selected within the cap.
        continue;
      }
      unique.set(judged.identity, { item, ...judged });
    }
    if (!await checkpoint({ excluded })) return publicJob(job) || cancelledJob(jobId);
    for (const entry of unique.values()) {
      const current = await getJob(jobId);
      if (!current || current.status !== 'running') return publicJob(current) || cancelledJob(jobId);
      if (current.acceptedIds.includes(entry.record.page.id)) continue;
      if (deps.hasPermission && !await deps.hasPermission()) {
        return publicJob(await updateRunningJob(jobId, { status: 'cancelled', partialReason: 'permission-removed' })) || cancelledJob(jobId);
      }
      const existing = await getPage(entry.record.page.id, { now, includeExpired: true });
      const page = existing ? mergePage(existing, entry.record.page) : entry.record.page;
      // Page and durable progress commit in the same transaction, conditional on running status.
      await commitPage({
        page, chunks: existing ? undefined : [], historyAliases: entry.record.historyAliases, importJobId: jobId,
      }, guards);
    }
    const partialReason = raw.length >= Math.min(maxResults, ceiling) && unique.size < job.limit
      ? 'raw-ceiling' : equalTimeBoundary ? 'equal-time' : null;
    await checkpoint({ status: partialReason ? 'partial' : 'complete', partialReason });
    return publicJob(job) || cancelledJob(jobId);
  } catch (error) {
    const current = await getJob(jobId);
    if (!current || current.status !== 'running') return publicJob(current) || cancelledJob(jobId);
    // Guard invalidation becomes cancellation; operational errors preserve committed progress.
    return publicJob(await updateRunningJob(jobId, {
      status: current.accepted ? 'partial' : 'failed',
      partialReason: 'error', error: String(error.message || error).slice(0, 500),
    }, guards)) || cancelledJob(jobId);
  }
}

export async function ingestHistoryItem(item, deps = {}) {
  const now = deps.now ?? Date.now();
  const meta = await readMeta();
  if (!meta.policy.historyEnabled) return { skipped: true };
  const job = {
    includeHosts: [],
    excludeHosts: deps.excludeHosts || [],
  };
  const judged = await eligibleItem(item, job, now);
  if (judged.excluded) return { skipped: true };
  const existing = await getPage(judged.record.page.id, { now, includeExpired: true });
  const page = existing ? mergePage(existing, judged.record.page) : judged.record.page;
  await commitPage({
    page, chunks: existing ? undefined : [], historyAliases: judged.record.historyAliases,
  }, { deletionGeneration: meta.deletionGeneration, policyRevision: meta.policyRevision });
  return { pageId: page.id, updated: Boolean(existing) };
}

export async function removeHistoryItems({ allHistory = false, urls = [] } = {}, deps = {}) {
  const ids = allHistory ? null : await Promise.all(urls.map(url => hashText(url)));
  return removeHistoryAliases(ids, deps.now ?? Date.now());
}

export async function setHistoryEnabled(enabled, now = Date.now()) {
  const meta = await readMeta();
  return updatePolicy({ ...meta.policy, historyEnabled: Boolean(enabled) }, now);
}

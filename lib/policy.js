export const DAY_MS = 86_400_000;
const MIN_BUDGET = 10 * 1024 * 1024;
const MAX_BUDGET = 500 * 1024 * 1024;
const MAX_IMPORT_LIMIT = 10_000;

export const DEFAULT_POLICY = Object.freeze({
  importDays: 30,
  importLimit: 2000,
  maxLookbackDays: 90,
  retentionDays: 90,
  collectionBudgetBytes: 100 * 1024 * 1024,
  historyEnabled: false,
  capturePaused: true,
});

function integer(value, label) {
  if (!Number.isInteger(value) || !Number.isFinite(value)) {
    throw new Error(`Choose a whole number for ${label}.`);
  }
  return value;
}

export function lookbackFloor(now, policy) {
  const days = Math.min(policy.maxLookbackDays, policy.retentionDays);
  return now - days * DAY_MS;
}

export function effectiveHistoryExpiry(page, policy) {
  if (!page?.historyPresent || page.lastVisitedAt == null) return page?.historyExpiresAt ?? null;
  return page.lastVisitedAt + policy.retentionDays * DAY_MS;
}

export function effectiveTextExpiry(page, policy) {
  if (!page || page.pinned || !page.contentHash || page.capturedAt == null) return null;
  return page.capturedAt + policy.retentionDays * DAY_MS;
}

export function pageVisibility(page, policy, now) {
  if (!page) return { live: false, historyLive: false, textLive: false };
  const historyExpiry = effectiveHistoryExpiry(page, policy);
  const textExpiry = effectiveTextExpiry(page, policy);
  const historyLive = Boolean(page.historyPresent) && (historyExpiry == null || historyExpiry > now);
  const textLive = Boolean(page.contentHash) && (page.pinned || textExpiry == null || textExpiry > now);
  return { historyLive, textLive, live: page.pinned || historyLive || textLive };
}

export function applyExpiries(page, policy) {
  return {
    ...page,
    historyExpiresAt: page.historyPresent && page.lastVisitedAt != null
      ? page.lastVisitedAt + policy.retentionDays * DAY_MS
      : null,
    textExpiresAt: page.pinned || !page.contentHash || page.capturedAt == null
      ? null
      : page.capturedAt + policy.retentionDays * DAY_MS,
  };
}

export function projectVisible(page, policy, now, chunks = []) {
  const visibility = pageVisibility(page, policy, now);
  if (!visibility.live) return undefined;
  if (visibility.textLive) return { page, chunks };
  return {
    page: {
      ...page,
      contentHash: null,
      extractorVersion: null,
      truncated: false,
      capturedAt: null,
      captureSource: page.pinned ? page.captureSource : null,
      textExpiresAt: null,
      indexingStatus: page.historyPresent || page.pinned ? 'metadata_only' : page.indexingStatus,
    },
    chunks: [],
  };
}

export function validateImportRange({ from, to, limit, days } = {}, policy, now = Date.now()) {
  const floor = lookbackFloor(now, policy);
  if (days != null) {
    integer(days, 'import range');
    if (days < 1 || days > 90) throw new Error('Import range must be between 1 and 90 days.');
    if (from != null || to != null) throw new Error('Choose either preset days or custom dates.');
    from = now - Math.min(days, policy.retentionDays) * DAY_MS;
    to = now;
  }
  if (from != null) {
    if (!Number.isFinite(from)) throw new Error('Choose a valid start date.');
    if (from > now) throw new Error('Start date cannot be in the future.');
    if (from < floor) throw new Error('History lookback cannot go past 90 days or your retention period.');
  }
  if (to != null) {
    if (!Number.isFinite(to)) throw new Error('Choose a valid end date.');
    if (to > now) throw new Error('End date cannot be in the future.');
    if (to < floor) throw new Error('History lookback cannot go past 90 days or your retention period.');
  }
  if (from != null && to != null && from > to) throw new Error('Start date must be before the end date.');
  if (limit != null) {
    const value = integer(limit, 'the page cap');
    if (value <= 0 || value > MAX_IMPORT_LIMIT) throw new Error('Choose a page cap between 1 and 10,000.');
  }
  return {
    from: from ?? lookbackFloor(now, { ...policy, retentionDays: Math.min(policy.retentionDays, policy.importDays) }),
    to: to ?? now,
    limit: limit ?? policy.importLimit,
  };
}

export function validatePolicy(input = {}, now = Date.now()) {
  const src = { ...DEFAULT_POLICY, ...input };
  const retentionDays = integer(src.retentionDays, 'retention');
  if (retentionDays < 1 || retentionDays > 90) throw new Error('Choose a retention period between 1 and 90 days.');
  const maxLookbackDays = integer(src.maxLookbackDays, 'lookback');
  if (maxLookbackDays !== 90) throw new Error('History lookback cannot exceed 90 days.');
  const importDays = integer(src.importDays, 'import range');
  if (importDays < 1 || importDays > Math.min(90, retentionDays, maxLookbackDays)) {
    throw new Error('Import range cannot exceed 90 days or your retention period.');
  }
  const importLimit = integer(src.importLimit, 'the page cap');
  if (importLimit <= 0 || importLimit > MAX_IMPORT_LIMIT) throw new Error('Choose a page cap between 1 and 10,000.');
  const collectionBudgetBytes = integer(src.collectionBudgetBytes, 'collection budget');
  if (collectionBudgetBytes < MIN_BUDGET || collectionBudgetBytes > MAX_BUDGET) {
    throw new Error('Choose a collection budget between 10 MB and 500 MB.');
  }
  validateImportRange({ from: src.from, to: src.to, limit: src.limit }, { ...src, retentionDays, maxLookbackDays, importDays }, now);
  return {
    importDays,
    importLimit,
    maxLookbackDays,
    retentionDays,
    collectionBudgetBytes,
    historyEnabled: Boolean(src.historyEnabled),
    capturePaused: src.capturePaused !== false,
  };
}

export function estimatedUsage(counters, policy) {
  const estimatedBytes = (counters.metaBytes || 0) + (counters.bodyBytes || 0) + (counters.termBytes || 0)
    + (counters.vectorBytes || 0) + (counters.jobBytes || 0) + (counters.aliasBytes || 0);
  return {
    pageCount: counters.pageCount || 0,
    pinnedCount: counters.pinnedCount || 0,
    bodyBytes: counters.bodyBytes || 0,
    metaBytes: counters.metaBytes || 0,
    pinnedBytes: counters.pinnedBytes || 0,
    termBytes: counters.termBytes || 0,
    vectorBytes: counters.vectorBytes || 0,
    jobBytes: counters.jobBytes || 0,
    aliasBytes: counters.aliasBytes || 0,
    modelBytes: counters.modelBytes || 0,
    estimatedBytes,
    collectionBudgetBytes: policy.collectionBudgetBytes,
    budgetBlocked: Boolean(counters.budgetBlocked),
  };
}

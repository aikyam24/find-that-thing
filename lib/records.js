const TRACKING = /^(utm_.+|fbclid|gclid|dclid|msclkid)$/i;
export const MAX_TEXT = 50_000;

export function normalizeUrl(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only ordinary HTTP or HTTPS pages can be saved.');
  }
  // Hash-router paths identify different pages; ordinary section anchors do not.
  if (!/^#(?:\/|!)/.test(url.hash)) url.hash = '';
  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING.test(name)) url.searchParams.delete(name);
  }
  return url.href;
}

export async function hashText(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function chunkText(text, prefix) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + 1400, text.length);
    if (end < text.length) {
      const paragraph = text.lastIndexOf('\n', end);
      const space = text.lastIndexOf(' ', end);
      if (paragraph > start + 600) end = paragraph;
      else if (space > start + 600) end = space;
    }
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push({ id: `${prefix}_${chunks.length}`, text: piece, ordinal: chunks.length });
    start = end;
    while (/\s/.test(text[start] ?? '') && start < text.length) start++;
  }
  return chunks;
}

function later(left, right) {
  if (left == null) return right ?? null;
  if (right == null) return left;
  return Math.max(left, right);
}

function titleFrom(value, identity) {
  return String(value || new URL(identity).hostname).slice(0, 500);
}

export function pageMetadata(fields) {
  const pinned = Boolean(fields.pinned);
  return {
    id: fields.id,
    schemaVersion: 2,
    normalizedIdentity: fields.normalizedIdentity,
    originalUrl: fields.originalUrl,
    hostname: fields.hostname || new URL(fields.normalizedIdentity).hostname,
    title: titleFrom(fields.title, fields.normalizedIdentity),
    userNote: fields.userNote || '',
    createdAt: fields.createdAt,
    savedAt: pinned ? fields.savedAt ?? fields.createdAt : fields.savedAt ?? null,
    pinned,
    pinnedValue: pinned ? 1 : 0,
    lastVisitedAt: fields.lastVisitedAt ?? null,
    capturedAt: fields.capturedAt ?? null,
    historyPresent: Boolean(fields.historyPresent),
    captureSource: fields.captureSource ?? null,
    historyExpiresAt: fields.historyExpiresAt ?? null,
    textExpiresAt: pinned ? null : fields.textExpiresAt ?? null,
    contentHash: fields.contentHash ?? null,
    extractorVersion: fields.extractorVersion ?? null,
    truncated: Boolean(fields.truncated),
    indexingStatus: fields.indexingStatus || (fields.contentHash ? 'pending' : 'metadata_only'),
  };
}

export async function createRecord(capture, now = Date.now()) {
  const identity = normalizeUrl(capture.url);
  const raw = String(capture.text ?? '').replace(/\r\n?/g, '\n').replace(/[\t ]+/g, ' ').trim();
  if (!raw) throw new Error('No readable text was found on this page.');
  const text = raw.slice(0, MAX_TEXT);
  const id = await hashText(identity);
  const contentHash = await hashText(text);
  const page = pageMetadata({
    id, normalizedIdentity: identity, originalUrl: capture.url,
    title: capture.title, createdAt: now, savedAt: now, pinned: true,
    capturedAt: now, captureSource: 'manual', contentHash, extractorVersion: '1',
    truncated: raw.length > MAX_TEXT || Boolean(capture.truncated), indexingStatus: 'pending',
  });
  return { page, chunks: chunkText(text, `${id.slice(0, 16)}_${contentHash.slice(0, 12)}`) };
}

export async function createHistoryRecord(item, now = Date.now()) {
  const identity = normalizeUrl(item.url);
  const id = await hashText(identity);
  const lastVisitedAt = item.lastVisitedAt ?? now;
  const page = pageMetadata({
    id, normalizedIdentity: identity, originalUrl: item.url, title: item.title,
    createdAt: now, pinned: false, lastVisitedAt, historyPresent: true,
    historyExpiresAt: item.historyExpiresAt ?? null, indexingStatus: 'metadata_only',
  });
  return {
    page,
    chunks: [],
    historyAliases: [{ id: await hashText(item.url), pageId: id, lastVisitedAt }],
  };
}

export function migrateLegacyRecord(record) {
  const chunks = Array.isArray(record.chunks) ? record.chunks.map(chunk => ({
    id: chunk.id, text: chunk.text, ordinal: chunk.ordinal,
  })) : [];
  const page = pageMetadata({
    id: record.id, normalizedIdentity: record.normalizedIdentity, originalUrl: record.originalUrl,
    hostname: record.hostname, title: record.title, userNote: record.userNote || '',
    createdAt: record.createdAt, savedAt: record.createdAt, pinned: true,
    capturedAt: record.capturedAt ?? record.createdAt, captureSource: 'manual',
    contentHash: record.contentHash ?? null, extractorVersion: record.extractorVersion ?? '1',
    truncated: record.truncated, indexingStatus: record.contentHash ? 'pending' : 'metadata_only',
  });
  return { page, chunks };
}

export function mergePage(existing, incoming) {
  const pinned = Boolean(existing.pinned || incoming.pinned);
  const incomingHasText = Boolean(incoming.contentHash);
  const manual = existing.captureSource === 'manual' || incoming.captureSource === 'manual' || pinned;
  return pageMetadata({
    id: existing.id,
    normalizedIdentity: existing.normalizedIdentity,
    originalUrl: incoming.originalUrl || existing.originalUrl,
    hostname: existing.hostname,
    title: incoming.title || existing.title,
    userNote: incoming.userNote ?? existing.userNote,
    createdAt: Math.min(existing.createdAt, incoming.createdAt ?? existing.createdAt),
    savedAt: pinned ? existing.savedAt ?? incoming.savedAt ?? incoming.capturedAt ?? existing.createdAt : existing.savedAt,
    pinned,
    lastVisitedAt: later(existing.lastVisitedAt, incoming.lastVisitedAt),
    capturedAt: incomingHasText ? incoming.capturedAt ?? existing.capturedAt : existing.capturedAt,
    historyPresent: Boolean(existing.historyPresent || incoming.historyPresent),
    captureSource: manual ? 'manual' : incomingHasText ? incoming.captureSource : existing.captureSource,
    historyExpiresAt: incoming.historyPresent ? incoming.historyExpiresAt ?? existing.historyExpiresAt : existing.historyExpiresAt,
    textExpiresAt: incomingHasText ? incoming.textExpiresAt : existing.textExpiresAt,
    contentHash: incomingHasText ? incoming.contentHash : existing.contentHash,
    extractorVersion: incomingHasText ? incoming.extractorVersion : existing.extractorVersion,
    truncated: incomingHasText ? incoming.truncated : existing.truncated,
    indexingStatus: incomingHasText ? incoming.indexingStatus || 'pending'
      : existing.contentHash ? existing.indexingStatus : incoming.indexingStatus || existing.indexingStatus || 'metadata_only',
  });
}

export function splitRecord(record) {
  if (record?.page) {
    return { page: record.page, chunks: record.chunks || [], historyAliases: record.historyAliases || [] };
  }
  const { chunks = [], historyAliases = [], ...page } = record || {};
  return { page, chunks, historyAliases };
}

export function toSearchable(page, chunks = []) {
  return { ...page, chunks };
}

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

async function hash(text) {
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

export async function createRecord(capture, now = Date.now()) {
  const identity = normalizeUrl(capture.url);
  const raw = String(capture.text ?? '').replace(/\r\n?/g, '\n').replace(/[\t ]+/g, ' ').trim();
  if (!raw) throw new Error('No readable text was found on this page.');
  const text = raw.slice(0, MAX_TEXT);
  const id = await hash(identity);
  const contentHash = await hash(text);
  return {
    id, schemaVersion: 1, originalUrl: capture.url, normalizedIdentity: identity,
    hostname: new URL(identity).hostname, title: String(capture.title || new URL(identity).hostname).slice(0, 500),
    source: 'manual', createdAt: now, capturedAt: now,
    contentHash, extractorVersion: '1', truncated: raw.length > MAX_TEXT || Boolean(capture.truncated),
    userNote: '', chunks: chunkText(text, `${id.slice(0, 16)}_${contentHash.slice(0, 12)}`),
  };
}

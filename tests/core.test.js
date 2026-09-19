import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecord, createHistoryRecord, normalizeUrl, toSearchable } from '../lib/records.js';
import { searchLocal, excerptFor, toResult } from '../lib/search.js';
import { buildRequest, parseAnswer, evaluateCandidate } from '../lib/typesafe.js';

const capture = (text, overrides = {}) => ({ url: 'https://example.com/tool?utm_source=news', title: 'Example tool', text, ...overrides });
const saved = async (text, overrides) => {
  const { page, chunks } = await createRecord(capture(text, overrides));
  return toSearchable(page, chunks);
};

test('history-only results select the newest visits and display their visit date', async () => {
  const pages = await Promise.all(Array.from({ length: 101 }, async (_, i) => {
    const { page } = await createHistoryRecord({ url: `https://example.com/${i}`, title: 'History', lastVisitedAt: 1_800_000_000_000 + i });
    return toSearchable(page);
  }));
  const results = searchLocal(pages, '', { limit: 100 });
  assert.equal(results[0].page.id, pages[100].id);
  assert.ok(!results.some(result => result.page.id === pages[0].id));
  assert.equal(toResult(results[0]).displayedAt, 1_800_000_000_100);
  assert.equal(toResult(results[0]).capturedAt, null);
});

test('deduplication removes tracking but retains meaningful URL parameters', async () => {
  assert.equal(normalizeUrl('https://example.com/tool?plan=free&utm_source=email#part'), 'https://example.com/tool?plan=free');
  const a = await createRecord(capture('hello'));
  const b = await createRecord(capture('updated', { url: 'https://example.com/tool#section' }));
  assert.equal(a.page.id, b.page.id);
  assert.notEqual(a.page.contentHash, b.page.contentHash);
  assert.notEqual(normalizeUrl('https://example.com/?id=1'), normalizeUrl('https://example.com/?id=2'));
  assert.notEqual(normalizeUrl('https://example.com/#/first'), normalizeUrl('https://example.com/#/second'));
  assert.throws(() => normalizeUrl('javascript:alert(1)'), /HTTP/);
});

test('search retrieves a late original passage and omits unrelated pages', async () => {
  const page = await saved(`${'General introduction to our platform. '.repeat(160)}\n\nSend large files without an account. No signup is required.`, { title: 'A useful website' });
  const other = await saved('A recipe for chocolate cake.', { url: 'https://example.org/cake', title: 'Cake recipe' });
  const results = searchLocal([other, page], 'large files without an account');
  assert.equal(results[0].page.id, page.id);
  assert.match(results[0].passages[0].text, /No signup is required/);
  assert.match(excerptFor(results[0].passages[0].text, 'large files without an account'), /No signup is required/);
  assert.equal(searchLocal([other, page], 'underwater photography').length, 0);
});

test('Jev packets are bounded and contain no reopening URL or unrelated text', async () => {
  const page = await saved('Send files without an account.', { url: 'https://example.com/tool?private_token=secret' });
  const candidate = searchLocal([page], 'send files')[0];
  const request = buildRequest('send files', candidate);
  const serialized = JSON.stringify(request);
  assert.equal(request.state.candidate.id, page.id);
  assert.ok(!serialized.includes('private_token'));
  assert.ok(!serialized.includes('secret'));
  assert.ok(request.state.candidate.passages.length <= 2);
});

test('Jev answers must reference existing passages and valid typed scores', async () => {
  const page = await saved('Send files without an account.');
  const candidate = searchLocal([page], 'send files')[0];
  const body = { model: 'test', answers: {
    relevance: { type: 'score', score: 2.8, confidence: 0.8 },
    detail_support: { type: 'choice', choice: 'supported' },
    best_passage: { type: 'choice', choice: candidate.passages[0].id },
  } };
  assert.equal(parseAnswer(body, candidate).relevance, 2.8);
  assert.throws(() => parseAnswer({ answers: {} }, candidate), /Invalid/);
  assert.throws(() => parseAnswer({ ...body, answers: { ...body.answers, best_passage: { type: 'choice', choice: 'invented' } } }, candidate), /Invalid/);
  assert.throws(() => parseAnswer({ ...body, answers: { ...body.answers, relevance: { type: 'score', score: NaN, confidence: 1 } } }, candidate), /Invalid/);
});

test('provider deadlines cover a body that stalls after headers', async () => {
  const page = await saved('Send files without an account.');
  const candidate = searchLocal([page], 'send files')[0];
  const fetchImpl = async (_url, { signal }) => ({ ok: true, json: () => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  await assert.rejects(evaluateCandidate('files', candidate, { apiKey: 'test', fetchImpl, timeoutMs: 20 }), /timed out/);
});

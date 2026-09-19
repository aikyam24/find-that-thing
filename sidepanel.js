import { request, element } from './lib/client.js';
import { excerptFor } from './lib/search.js';

const $ = id => document.getElementById(id);
const clientId = crypto.randomUUID();
let generation = 0;
let results = [];
let visible = 5;
let count = 0;
let activeQuery = '';
let captureTime = 0;

function notice(message = '', error = false) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
  $('notice').classList.toggle('error', error);
}

function action(label, handler, className = '') {
  const button = element('button', `text-button ${className}`, label);
  button.type = 'button';
  button.addEventListener('click', () => Promise.resolve(handler(button)).catch(error => notice(error.message, true)));
  return button;
}

function render() {
  const focused = document.activeElement;
  const focusKey = focused?.dataset?.focusKey;
  $('results').replaceChildren();
  for (const result of results.slice(0, visible)) {
    const card = element('article', 'result');
    const meta = element('div', 'result-meta');
    meta.append(element('span', 'domain', result.hostname), element('span', 'date', new Date(result.displayedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));
    card.append(meta, element('h3', '', result.title));
    const excerpt = element('blockquote', 'excerpt');
    excerpt.textContent = `“${excerptFor(result.excerpt, activeQuery)}”`;
    card.append(excerpt);
    if (result.judgement?.detailSupport === 'contradicted') card.append(element('p', 'detail-note', 'A remembered detail appears to differ.'));
    if (result.truncated) card.append(element('p', 'detail-note', 'Part of this page was saved.'));
    const actions = element('div', 'result-actions');
    const open = action('Open page', () => request('OPEN_PAGE', { id: result.id }));
    open.dataset.focusKey = `${result.id}:open`;
    const found = action('This is the one', button => {
      button.textContent = 'Found it ✓'; notice('Glad you found it. Your search feedback stays in this session.');
    });
    found.dataset.focusKey = `${result.id}:found`;
    const forget = action('Forget', async () => {
      generation++;
      await request('FORGET', { id: result.id });
      await runSearch(false);
      notice('Page forgotten. Your browser history is unchanged.');
    }, 'muted forget');
    forget.dataset.focusKey = `${result.id}:forget`;
    actions.append(open, found, forget); card.append(actions); $('results').append(card);
  }
  $('result-count').textContent = activeQuery ? `${results.length} ${results.length === 1 ? 'match' : 'matches'}` : 'Your saved pages';
  $('page-count').textContent = `${count} ${count === 1 ? 'page' : 'pages'}`;
  $('empty').hidden = Boolean(results.length);
  $('empty-title').textContent = count ? 'No strong match yet.' : 'Your next good find belongs here.';
  $('empty-copy').textContent = count ? 'Try a different detail or a word from the title. Only saved pages are searched.' : 'Click the extension’s toolbar icon on a page to save it. Come back with whatever you remember.';
  $('more').hidden = results.length <= visible;
  if (focusKey) [...document.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === focusKey)?.focus();
}

async function runSearch(useJev = true, expanded = false) {
  const current = ++generation;
  request('CANCEL_SEARCH', { clientId }).catch(() => {});
  activeQuery = $('query').value.trim();
  const query = activeQuery;
  await chrome.storage.session.set({ query });
  visible = 5; $('expand').hidden = true;
  notice(); $('mode').textContent = 'Local search';
  try {
    const local = await request('SEARCH_LOCAL', { query, clientId });
    if (current !== generation) return;
    results = local.results; count = local.count; render();
    if (!query || !useJev || !local.assisted || !count) return;
    $('mode').textContent = 'Checking matches…';
    const assisted = await request('SEARCH_JEV', { query, clientId, revision: local.revision, expanded });
    if (current !== generation) return;
    if (assisted.stale || assisted.disabled) { $('mode').textContent = 'Local search'; return; }
    if (assisted.fallback) {
      $('mode').textContent = 'Local search'; notice(assisted.message); return;
    }
    results = assisted.results; $('mode').textContent = 'Jev-assisted'; render();
    $('expand').hidden = !assisted.canExpand;
  } catch (error) {
    if (current !== generation) return;
    $('mode').textContent = 'Local search'; notice(error.message, true);
  }
}

async function showCaptureNotice() {
  const { lastCapture } = await chrome.storage.session.get('lastCapture');
  if (lastCapture && lastCapture.time > captureTime && Date.now() - lastCapture.time < 30_000) {
    captureTime = lastCapture.time; notice(lastCapture.message, lastCapture.kind === 'error');
  }
}

$('search-form').addEventListener('submit', event => { event.preventDefault(); void runSearch(); });
$('query').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('search-form').requestSubmit(); }
});
$('query').addEventListener('input', () => {
  generation++; request('CANCEL_SEARCH', { clientId }).catch(() => {});
  $('mode').textContent = 'Local search'; $('expand').hidden = true;
});
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('more').addEventListener('click', () => { visible += 5; render(); });
$('expand').addEventListener('click', () => void runSearch(true, true));
chrome.runtime.onMessage.addListener(message => {
  if (message.type !== 'EVENT') return;
  if (message.kind === 'cleared') $('query').value = '';
  void runSearch(false).then(showCaptureNotice);
});
window.addEventListener('pagehide', () => { request('CANCEL_SEARCH', { clientId }).catch(() => {}); });

try {
  const { query = '' } = await chrome.storage.session.get('query');
  $('query').value = query;
  await runSearch(false); await showCaptureNotice();
  $('query').focus();
} catch (error) { notice(error.message, true); }

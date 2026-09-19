import { capturePage } from './content/capture.js';
import { createRecord } from './lib/records.js';
import { snapshot, saveRecord, forgetRecord, clearRecords } from './lib/db.js';
import { searchLocal, toResult, rankEvaluated } from './lib/search.js';
import { evaluateCandidate } from './lib/typesafe.js';

const searches = new Map();
const settingsReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const trustedPaths = new Set(['sidepanel.html', 'options.html'].map(path => chrome.runtime.getURL(path)));

function publish(event) { chrome.runtime.sendMessage({ type: 'EVENT', ...event }).catch(() => {}); }

async function settings() {
  await settingsReady;
  const { apiKey = '', assisted = false } = await chrome.storage.local.get(['apiKey', 'assisted']);
  return { apiKey, assisted: Boolean(assisted && apiKey) };
}

function cancelAll() {
  for (const controller of searches.values()) controller.abort(new Error('The collection or settings changed.'));
  searches.clear();
}

async function saveTab(tab) {
  try {
    if (!tab?.id || !/^https?:\/\//.test(tab.url || '')) throw new Error('Open a web page, then click the toolbar icon to save it.');
    const before = await snapshot();
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: capturePage });
    if (!result?.text) throw new Error('No readable text was found on this page.');
    const record = await createRecord(result);
    await saveRecord(record, before.generation);
    cancelAll();
    await chrome.storage.session.set({ lastCapture: { message: `Saved “${record.title}”`, kind: 'success', time: Date.now() } });
    publish({ kind: 'saved' });
  } catch (error) {
    const message = /Cannot access|Missing host permission/i.test(error.message)
      ? 'This page cannot be read. Open an ordinary web page and click the toolbar icon again.' : error.message;
    await chrome.storage.session.set({ lastCapture: { message, kind: 'error', time: Date.now() } });
    publish({ kind: 'capture-error' });
  }
}

chrome.action.onClicked.addListener(tab => {
  // Open synchronously from the gesture, before awaiting capture or database work.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  void saveTab(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-search' && tab?.windowId) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

async function localSearch(query) {
  const state = await snapshot();
  const config = await settings();
  const candidates = searchLocal(state.pages, query, { limit: 100 });
  return { results: candidates.map(c => toResult(c)), count: state.pages.length, revision: state.revision,
    assisted: config.assisted, mode: 'local' };
}

async function assistedSearch(message) {
  const { query, clientId, revision } = message;
  const config = await settings();
  if (!config.assisted) return { disabled: true };
  searches.get(clientId)?.abort(new Error('Search superseded.'));
  const controller = new AbortController();
  searches.set(clientId, controller);
  const timer = setTimeout(() => controller.abort(new Error('Jev timed out. Showing local matches.')), 8000);
  try {
    const state = await snapshot();
    if (state.revision !== revision) return { stale: true };
    const candidates = searchLocal(state.pages, query, { limit: message.expanded ? 100 : 30, includeUnmatched: true });
    let next = 0;
    let failure = null;
    const evaluated = [];
    const workers = Array.from({ length: Math.min(3, candidates.length) }, async () => {
      while (next < candidates.length && !controller.signal.aborted) {
        const candidate = candidates[next++];
        try {
          const judgement = await evaluateCandidate(query, candidate, { apiKey: config.apiKey, signal: controller.signal });
          evaluated.push(toResult(candidate, judgement));
        } catch (error) {
          failure = error;
          controller.abort(error);
        }
      }
    });
    await Promise.all(workers);
    if ((await snapshot()).revision !== revision) return { stale: true };
    if (controller.signal.aborted || failure) {
      return { fallback: true, message: failure?.message || controller.signal.reason?.message || 'Showing local matches.' };
    }
    return { results: rankEvaluated(evaluated), mode: 'jev', examined: candidates.length,
      canExpand: !message.expanded && state.pages.length > 30 };
  } finally {
    clearTimeout(timer);
    if (searches.get(clientId) === controller) searches.delete(clientId);
  }
}

function validId(id) { return typeof id === 'string' && /^[a-f0-9]{64}$/.test(id); }
function validClient(id) { return typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id); }

async function handle(message) {
  switch (message.type) {
    case 'SNAPSHOT': return localSearch('');
    case 'SEARCH_LOCAL':
    case 'SEARCH_JEV': {
      if (typeof message.query !== 'string' || message.query.length > 600 || !validClient(message.clientId)) throw new Error('Enter a description up to 600 characters.');
      return message.type === 'SEARCH_LOCAL' ? localSearch(message.query.trim()) : assistedSearch({ ...message, query: message.query.trim() });
    }
    case 'CANCEL_SEARCH': {
      if (validClient(message.clientId)) searches.get(message.clientId)?.abort(new Error('Search canceled.'));
      return {};
    }
    case 'FORGET': {
      if (!validId(message.id)) throw new Error('Invalid saved page.');
      cancelAll(); await forgetRecord(message.id); publish({ kind: 'changed' }); return {};
    }
    case 'OPEN_PAGE': {
      if (!validId(message.id)) throw new Error('Invalid saved page.');
      const page = (await snapshot()).pages.find(p => p.id === message.id);
      if (!page) throw new Error('This page has been forgotten.');
      if (!/^https?:\/\//.test(page.originalUrl)) throw new Error('This address cannot be opened.');
      await chrome.tabs.create({ url: page.originalUrl }); return {};
    }
    case 'GET_SETTINGS': {
      const config = await settings(); const state = await snapshot();
      const bytes = new TextEncoder().encode(JSON.stringify(state.pages)).length;
      return { hasKey: Boolean(config.apiKey), assisted: config.assisted, count: state.pages.length, bytes };
    }
    case 'SAVE_SETTINGS': {
      if (typeof message.assisted !== 'boolean' || (message.apiKey !== undefined && (typeof message.apiKey !== 'string' || message.apiKey.length > 500))) throw new Error('Invalid settings.');
      await settingsReady;
      const previous = await settings();
      const apiKey = message.removeKey ? '' : (message.apiKey?.trim() || previous.apiKey);
      if (/[\r\n]/.test(apiKey)) throw new Error('Check the key for accidental line breaks.');
      if (message.assisted && !apiKey) throw new Error('Add a Jev key before enabling assisted search.');
      cancelAll();
      await chrome.storage.local.set({ apiKey, assisted: Boolean(apiKey && message.assisted) });
      publish({ kind: 'settings' }); return {};
    }
    case 'EXPORT': return { schemaVersion: 1, exportedAt: new Date().toISOString(), pages: (await snapshot()).pages };
    case 'CLEAR': {
      cancelAll(); await clearRecords();
      await chrome.storage.session.remove(['query', 'lastCapture']);
      publish({ kind: 'cleared' }); return {};
    }
    default: throw new Error('Unknown request.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'EVENT') return false;
  if (sender.id !== chrome.runtime.id || !trustedPaths.has(sender.url?.split('?')[0]?.split('#')[0])) return false;
  handle(message).then(data => respond({ ok: true, data })).catch(error => respond({ ok: false, error: error.message || 'Something went wrong. Please try again.' }));
  return true;
});

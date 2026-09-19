import { capturePage } from './content/capture.js';
import { createRecord } from './lib/records.js';
import {
  snapshot, readMeta, getPage, commitPage, deletePages, clearCollection, exportCollection, getUsage,
} from './lib/db.js';
import { runMaintenance } from './lib/maintenance.js';
import {
  startHistoryImport, getHistoryImport, cancelHistoryImport, processHistoryImport,
  ingestHistoryItem, removeHistoryItems, setHistoryEnabled,
} from './lib/history.js';
import { DAY_MS } from './lib/policy.js';
import { searchLocal, toResult, rankEvaluated } from './lib/search.js';
import { evaluateCandidate } from './lib/typesafe.js';

const searches = new Map();
const settingsReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const trustedPaths = new Set(['sidepanel.html', 'options.html'].map(path => chrome.runtime.getURL(path)));
const MAINTENANCE_ALARM = 'collection-maintenance';

async function ensureMaintenanceAlarm() {
  const existing = await chrome.alarms.get(MAINTENANCE_ALARM);
  if (!existing) await chrome.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 60 });
}

function maintain() {
  return runMaintenance({ now: Date.now() }).catch(() => {});
}

let historyListenersAttached = false;

async function hasHistoryPermission() {
  return chrome.permissions.contains({ permissions: ['history'] });
}

function attachHistoryListeners() {
  if (historyListenersAttached || !chrome.history) return;
  chrome.history.onVisited.addListener(item => {
    void hasHistoryPermission().then(granted => {
      if (granted) return ingestHistoryItem({ url: item.url, title: item.title, lastVisitTime: item.lastVisitTime });
    }).then(() => {
      publish({ kind: 'changed' });
    }).catch(() => {});
  });
  chrome.history.onVisitRemoved.addListener(removed => {
    // Removal applies to prior imports even when ongoing visit collection is off.
    void hasHistoryPermission().then(granted => {
      if (granted) return removeHistoryItems({ allHistory: Boolean(removed.allHistory), urls: removed.urls || [] });
    }).then(() => {
      publish({ kind: 'changed' });
    }).catch(() => {});
  });
  historyListenersAttached = true;
}

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
    const before = await readMeta();
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: capturePage });
    if (!result?.text) throw new Error('No readable text was found on this page.');
    const { page, chunks } = await createRecord(result);
    await commitPage({ page, chunks, historyAliases: [] }, {
      deletionGeneration: before.deletionGeneration,
      policyRevision: before.policyRevision,
    });
    cancelAll();
    await maintain();
    await chrome.storage.session.set({ lastCapture: { message: `Saved “${page.title}”`, kind: 'success', time: Date.now() } });
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
  await maintain();
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
    await maintain();
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
      cancelAll(); await deletePages([message.id], 'forget'); await maintain(); publish({ kind: 'changed' }); return {};
    }
    case 'OPEN_PAGE': {
      if (!validId(message.id)) throw new Error('Invalid saved page.');
      const page = await getPage(message.id);
      if (!page) throw new Error('This page has been forgotten.');
      if (!/^https?:\/\//.test(page.originalUrl)) throw new Error('This address cannot be opened.');
      await chrome.tabs.create({ url: page.originalUrl }); return {};
    }
    case 'GET_SETTINGS': {
      await maintain();
      const config = await settings();
      const meta = await readMeta();
      const usage = await getUsage();
      return {
        hasKey: Boolean(config.apiKey), assisted: config.assisted,
        count: meta.pageCount, bytes: usage.estimatedBytes, migrationStatus: meta.migrationStatus,
        usage, policy: meta.policy, historyPermission: await hasHistoryPermission(),
        lookbackFloor: Date.now() - Math.min(meta.policy.maxLookbackDays, meta.policy.retentionDays) * DAY_MS,
      };
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
    case 'CONNECT_HISTORY': {
      if (!await hasHistoryPermission()) throw new Error('History access was not granted.');
      await attachHistoryListeners();
      return { historyPermission: true };
    }
    case 'SET_HISTORY_ENABLED': {
      if (typeof message.enabled !== 'boolean') throw new Error('Invalid history setting.');
      if (message.enabled && !await hasHistoryPermission()) throw new Error('Connect history first.');
      await setHistoryEnabled(message.enabled);
      if (message.enabled) await attachHistoryListeners();
      cancelAll();
      publish({ kind: 'policy-changed' });
      return { policy: (await readMeta()).policy };
    }
    case 'START_HISTORY_IMPORT': {
      if (!await hasHistoryPermission()) throw new Error('Connect history first.');
      const hosts = value => String(value || '').split(/[\s,]+/).map(part => part.trim()).filter(Boolean);
      const { jobId } = await startHistoryImport({
        from: message.from, to: message.to, limit: message.limit, days: message.days,
        includeHosts: hosts(message.includeHosts), excludeHosts: hosts(message.excludeHosts),
      }, { historyApi: chrome.history, autoRun: false });
      publish({ kind: 'import-progress', jobId });
      void processHistoryImport(jobId, { historyApi: chrome.history, hasPermission: hasHistoryPermission }).then(async result => {
        await maintain();
        cancelAll();
        publish({ kind: 'import-progress', jobId, status: result.status });
        publish({ kind: 'changed' });
      }).catch(error => publish({ kind: 'import-progress', jobId, error: error.message }));
      return { jobId };
    }
    case 'GET_HISTORY_IMPORT': {
      if (typeof message.jobId !== 'string') throw new Error('Invalid import.');
      return getHistoryImport(message.jobId);
    }
    case 'CANCEL_HISTORY_IMPORT': {
      if (typeof message.jobId !== 'string') throw new Error('Invalid import.');
      return cancelHistoryImport(message.jobId);
    }
    case 'EXPORT': return exportCollection();
    case 'CLEAR': {
      cancelAll(); await clearCollection(); await maintain();
      await chrome.storage.session.remove(['query', 'lastCapture']);
      publish({ kind: 'cleared' }); return {};
    }
    default: throw new Error('Unknown request.');
  }
}

chrome.runtime.onInstalled.addListener(() => { void ensureMaintenanceAlarm(); void attachHistoryListeners(); void maintain(); });
chrome.runtime.onStartup.addListener(() => { void ensureMaintenanceAlarm(); void attachHistoryListeners(); void maintain(); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === MAINTENANCE_ALARM) void maintain(); });
chrome.permissions.onRemoved.addListener(removed => {
  if (!removed.permissions?.includes('history')) return;
  cancelAll();
  void setHistoryEnabled(false).then(() => publish({ kind: 'policy-changed' })).catch(() => {});
});
chrome.permissions.onAdded?.addListener(() => attachHistoryListeners());
void ensureMaintenanceAlarm();
void attachHistoryListeners();

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'EVENT') return false;
  if (sender.id !== chrome.runtime.id || !trustedPaths.has(sender.url?.split('?')[0]?.split('#')[0])) return false;
  handle(message).then(data => respond({ ok: true, data })).catch(error => respond({ ok: false, error: error.message || 'Something went wrong. Please try again.' }));
  return true;
});

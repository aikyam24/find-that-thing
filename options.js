import { request } from './lib/client.js';
const $ = id => document.getElementById(id);
let activeImportId = null;
let importTimer = null;

function notice(message, error = false) {
  $('notice').textContent = message; $('notice').hidden = false; $('notice').classList.toggle('error', error);
}

function dateValue(id) {
  const value = $(id).value;
  return value ? new Date(`${value}T00:00:00`).getTime() : undefined;
}

function refreshHistory(data) {
  const connected = Boolean(data.historyPermission);
  $('history-status').textContent = connected
    ? (data.policy?.historyEnabled ? 'History is connected. Future visits are remembered as titles and addresses.' : 'History is connected. Import when you want, or enable future visits.')
    : 'History is not connected.';
  $('connect-history').hidden = connected;
  $('history-enabled').disabled = !connected;
  if (document.activeElement !== $('history-enabled')) $('history-enabled').checked = Boolean(data.policy?.historyEnabled);
  $('start-import').disabled = !connected || Boolean(activeImportId);
  const floor = new Date(data.lookbackFloor || Date.now() - 90 * 86_400_000);
  $('import-disclosure').textContent = `Imports titles and addresses only. Automatic records expire after ${data.policy?.retentionDays ?? 90} days. The oldest allowed date is ${floor.toISOString().slice(0, 10)}.`;
}

async function load({ initializeForm = false } = {}) {
  const data = await request('GET_SETTINGS');
  $('key-status').textContent = data.hasKey ? 'A key is saved. Leave this field blank to keep it.' : 'No key saved.';
  $('api-key').placeholder = data.hasKey ? 'Replace saved key (optional)' : 'Paste your key';
  $('remove-key').hidden = !data.hasKey;
  if (initializeForm) $('assisted').checked = data.assisted;
  $('collection-size').textContent = `${data.count} saved ${data.count === 1 ? 'page' : 'pages'} · approximately ${data.bytes < 1024 * 1024 ? `${Math.ceil(data.bytes / 1024)} KB` : `${(data.bytes / 1024 / 1024).toFixed(1)} MB`}`;
  $('export').disabled = !data.count; $('clear').disabled = !data.count;
  refreshHistory(data);
}

$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  try {
    await request('SAVE_SETTINGS', { apiKey: $('api-key').value, assisted: $('assisted').checked });
    $('api-key').value = ''; await load({ initializeForm: true }); notice('Settings saved.');
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
});

$('remove-key').addEventListener('click', async () => {
  try { await request('SAVE_SETTINGS', { removeKey: true, assisted: false }); $('api-key').value = ''; await load({ initializeForm: true }); notice('Key removed. Local search is still available.'); }
  catch (error) { notice(error.message, true); }
});

$('export').addEventListener('click', async () => {
  try {
    const collection = await request('EXPORT');
    const url = URL.createObjectURL(new Blob([JSON.stringify(collection, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url;
    link.download = `find-that-thing-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    notice('Export created. It contains saved browsing content; keep it somewhere private.');
  } catch (error) { notice(error.message, true); }
});

$('clear').addEventListener('click', () => $('clear-dialog').showModal());
$('clear-dialog').addEventListener('close', async () => {
  if ($('clear-dialog').returnValue !== 'confirm') return;
  try { await request('CLEAR'); await load(); notice('All saved pages forgotten.'); }
  catch (error) { notice(error.message, true); }
});

$('import-days').addEventListener('change', () => {
  $('custom-dates').hidden = $('import-days').value !== 'custom';
});

$('connect-history').addEventListener('click', async () => {
  try {
    const granted = await chrome.permissions.request({ permissions: ['history'] });
    if (!granted) throw new Error('History access is optional. Local saved pages still work.');
    await request('CONNECT_HISTORY');
    await load();
    notice('History connected. Import is metadata-only.');
  } catch (error) { notice(error.message, true); }
});

$('history-enabled').addEventListener('change', async event => {
  try {
    await request('SET_HISTORY_ENABLED', { enabled: event.target.checked });
    await load();
  } catch (error) {
    event.target.checked = !event.target.checked;
    notice(error.message, true);
  }
});

async function pollImport() {
  if (!activeImportId) return;
  try {
    const status = await request('GET_HISTORY_IMPORT', { jobId: activeImportId }) || { status: 'cancelled' };
    $('import-progress').hidden = false;
    $('import-progress').textContent = status.status === 'running'
      ? `Importing… ${status.accepted || 0} pages`
      : status.status === 'partial'
        ? `Partial import: ${status.accepted} pages. ${status.error || 'Narrow dates or sites and import again.'}`
        : status.status === 'failed'
          ? `Import failed: ${status.error || 'Please try again.'}`
        : status.status === 'cancelled'
          ? 'Import cancelled.'
          : `Imported ${status.accepted} pages (${status.inserted} new).`;
    $('cancel-import').hidden = status.status !== 'running';
    if (status.status !== 'running') {
      activeImportId = null;
      clearInterval(importTimer);
      await load();
    }
  } catch (error) { notice(error.message, true); }
}

$('history-import-form').addEventListener('submit', async event => {
  event.preventDefault();
  const days = $('import-days').value;
  const range = days === 'custom'
    ? { from: dateValue('import-from'), to: dateValue('import-to') }
    : { days: Number(days) };
  try {
    const { jobId } = await request('START_HISTORY_IMPORT', {
      ...range, limit: Number($('import-limit').value),
      includeHosts: $('include-hosts').value, excludeHosts: $('exclude-hosts').value,
    });
    activeImportId = jobId;
    $('cancel-import').hidden = false;
    $('import-progress').hidden = false;
    $('import-progress').textContent = 'Importing…';
    importTimer = setInterval(pollImport, 400);
    await pollImport();
  } catch (error) { notice(error.message, true); }
});

$('cancel-import').addEventListener('click', async () => {
  if (!activeImportId) return;
  try {
    await request('CANCEL_HISTORY_IMPORT', { jobId: activeImportId });
    await pollImport();
  } catch (error) { notice(error.message, true); }
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'EVENT' && ['saved', 'cleared', 'changed', 'import-progress', 'policy-changed'].includes(message.kind)) {
    void load().catch(error => notice(error.message, true));
    if (activeImportId) void pollImport();
  }
});

try {
  await load({ initializeForm: true });
  const commands = await chrome.commands.getAll();
  $('save-shortcut').textContent = commands.find(c => c.name === '_execute_action')?.shortcut || 'Not assigned';
  $('search-shortcut').textContent = commands.find(c => c.name === 'open-search')?.shortcut || 'Not assigned';
} catch (error) { notice(error.message, true); }

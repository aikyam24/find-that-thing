import { request } from './lib/client.js';
const $ = id => document.getElementById(id);

function notice(message, error = false) {
  $('notice').textContent = message; $('notice').hidden = false; $('notice').classList.toggle('error', error);
}

async function load() {
  const data = await request('GET_SETTINGS');
  $('key-status').textContent = data.hasKey ? 'A key is saved. Leave this field blank to keep it.' : 'No key saved.';
  $('api-key').placeholder = data.hasKey ? 'Replace saved key (optional)' : 'Paste your key';
  $('remove-key').hidden = !data.hasKey;
  $('assisted').checked = data.assisted;
  $('collection-size').textContent = `${data.count} saved ${data.count === 1 ? 'page' : 'pages'} · approximately ${data.bytes < 1024 * 1024 ? `${Math.ceil(data.bytes / 1024)} KB` : `${(data.bytes / 1024 / 1024).toFixed(1)} MB`}`;
  $('export').disabled = !data.count; $('clear').disabled = !data.count;
}

$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  try {
    await request('SAVE_SETTINGS', { apiKey: $('api-key').value, assisted: $('assisted').checked });
    $('api-key').value = ''; await load(); notice('Settings saved.');
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
});

$('remove-key').addEventListener('click', async () => {
  try { await request('SAVE_SETTINGS', { removeKey: true, assisted: false }); $('api-key').value = ''; await load(); notice('Key removed. Local search is still available.'); }
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

try {
  await load();
  const commands = await chrome.commands.getAll();
  $('save-shortcut').textContent = commands.find(c => c.name === '_execute_action')?.shortcut || 'Not assigned';
  $('search-shortcut').textContent = commands.find(c => c.name === 'open-search')?.shortcut || 'Not assigned';
} catch (error) { notice(error.message, true); }

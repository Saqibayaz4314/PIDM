import { api } from './connection.js';
const key = new URLSearchParams(location.search).get('request');
const stored = await chrome.storage.session.get(key || '');
const request = stored[key];
const quality = document.querySelector('#quality');
const status = document.querySelector('#status');
const download = document.querySelector('#download');
const retry = document.querySelector('#retry');
let inspection;


async function inspect() {
  inspection?.abort();
  const current = new AbortController();
  inspection = current;
  retry.disabled = true;
  download.disabled = true;
  quality.disabled = true;
  status.textContent = 'Finding available qualities…';
  try {
    const result = await api('media/formats', request, current.signal);
    if (current.signal.aborted) return;
    document.querySelector('#title').textContent = result.title;
    quality.replaceChildren(...result.qualities.map(choice => {
      const option = document.createElement('option');
      option.value = choice.value;
      option.textContent = choice.label;
      option.disabled = choice.value !== 'best' && !result.mergingAvailable;
      return option;
    }));
    document.querySelector('#note').textContent = result.qualities.length > 1 ? 'Select a resolution. Audio is included when the source provides it.' : 'This source exposes one stream without a resolution list. Best available downloads that source.';
    status.textContent = result.mergingAvailable ? 'Ready to download.' : 'Only combined streams are available until video components are installed in the desktop app.';
  } catch (error) {
    if (current.signal.aborted) return;
    quality.replaceChildren(new Option('Best available', 'best'));
    status.textContent = `Could not read qualities: ${error.message}. You can retry or try Best available.`;
  } finally {
    if (inspection === current && !current.signal.aborted) {
      retry.disabled = false;
      download.disabled = false;
      quality.disabled = false;
    }
  }
}

document.querySelector('#download-form').addEventListener('submit', async event => {
  event.preventDefault();
  download.disabled = true;
  retry.disabled = true;
  const selected = quality.value === 'best' ? 'best' : Number(quality.value);
  try {
    await api('jobs', { ...request, quality: selected, segments: 4 });
    await chrome.storage.session.remove(key);
    status.textContent = 'Added to PIDM. Open the desktop app to see progress.';
    document.querySelector('#cancel').textContent = 'Close';
    quality.disabled = true;
  } catch (error) { status.textContent = error.message; download.disabled = false; retry.disabled = false; }
});
retry.addEventListener('click', () => { void inspect(); });
document.querySelector('#cancel').addEventListener('click', async () => {
  inspection?.abort();
  if (key) await chrome.storage.session.remove(key);
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
});
window.addEventListener('pagehide', () => inspection?.abort());
if (!request) {
  document.querySelector('#title').textContent = 'This selection is no longer available.';
  status.textContent = 'Return to the video and click the download button again.';
  retry.disabled = true;
} else {
  document.querySelector('#source').textContent = request.url;
  await inspect();
}

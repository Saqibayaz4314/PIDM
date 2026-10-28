const token = document.body.dataset.token;
const jobsElement = document.querySelector('#jobs');
const messageElement = document.querySelector('#message');
const qualityElement = document.querySelector('#quality');
const videoOptions = document.querySelector('#video-options');
const inspectButton = document.querySelector('#inspect-video');
const dialog = document.querySelector('#integration-dialog');
const views = new Map();
const pending = new Set();
let jobs = [];
let filter = 'all';
let inspectedUrl = null;
let inspection;
let refreshing = false;
const titles = { all: 'All downloads', active: 'In progress', completed: 'Completed', paused: 'Paused', failed: 'Failed' };
const statuses = { downloading: ['Downloading', 'download'], queued: ['Queued', 'clock'], completed: ['Completed', 'check'], paused: ['Paused', 'pause'], failed: ['Failed', 'alert'] };

function icon(name) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  element.setAttribute('class', 'icon');
  element.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '/icons.svg#' + name);
  element.append(use);
  return element;
}
function textElement(tag, className) {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}
function notify(message, tone = 'success') {
  messageElement.textContent = message;
  messageElement.dataset.tone = tone;
  messageElement.hidden = !message;
}
async function api(path, options = {}) {
  const response = await fetch('/api/' + path, { ...options, headers: { 'X-Download-Token': token, 'Content-Type': 'application/json' } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'HTTP ' + response.status);
  return result;
}
function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return 'Size unknown';
  if (value === 0) return '0 B';
  const unit = Math.min(4, Math.max(0, Math.floor(Math.log(value) / Math.log(1024))));
  return (value / Math.pow(1024, unit)).toFixed(unit ? 1 : 0) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][unit];
}
function matchesFilter(job, selected) {
  return selected === 'all' || (selected === 'active' ? ['downloading', 'queued'].includes(job.status) : job.status === selected);
}
function actionButton(action, label, symbol) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button' + (action === 'remove' ? ' danger' : '');
  button.dataset.action = action;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon(symbol));
  return button;
}
function createView(id) {
  const row = textElement('article', 'job');
  row.dataset.id = id;
  const file = textElement('div', 'file-cell');
  const fileIcon = textElement('div', 'file-icon');
  const info = textElement('div', 'file-info');
  const title = textElement('strong', 'file-title');
  const source = textElement('small', 'file-source');
  const progress = textElement('progress', 'job-progress');
  const error = textElement('p', 'job-error');
  info.append(title, source, progress, error);
  file.append(fileIcon, info);
  const metadata = textElement('div', 'status-cell');
  const badge = textElement('span', 'status-badge');
  const quality = textElement('span', 'job-quality');
  const size = textElement('span', 'job-size');
  metadata.append(badge, quality, size);
  const actions = textElement('div', 'job-actions');
  const toggle = actionButton('pause', 'Pause download', 'pause');
  const remove = actionButton('remove', 'Remove from list; completed file is kept', 'trash');
  actions.append(toggle, remove);
  row.append(file, metadata, actions);
  return { row, fileIcon, title, source, progress, error, badge, quality, size, toggle, remove };
}
function updateView(view, job) {
  const video = job.mode === 'video' || typeof job.quality === 'number' || /\.(mp4|mkv|webm|mov)$/i.test(job.name);
  view.row.dataset.status = job.status;
  view.title.textContent = job.name;
  view.title.title = job.name;
  view.fileIcon.classList.toggle('video', video);
  if (view.fileIcon.dataset.kind !== String(video)) {
    view.fileIcon.replaceChildren(icon(video ? 'film' : 'file'));
    view.fileIcon.dataset.kind = String(video);
  }
  try { view.source.textContent = new URL(job.url).hostname; } catch { view.source.textContent = 'Download'; }
  view.source.title = job.url;
  const status = statuses[job.status] || [job.status, 'clock'];
  if (view.badge.dataset.state !== job.status) {
    view.badge.replaceChildren(icon(status[1]), document.createTextNode(status[0]));
    view.badge.dataset.state = job.status;
  }
  view.quality.textContent = typeof job.quality === 'number' ? job.quality + 'p' : 'Video';
  view.quality.hidden = !video;
  let size = formatBytes(job.received);
  if (job.total && job.status !== 'completed') size += ' / ' + (video ? '≈ ' : '') + formatBytes(job.total);
  if (video && job.status === 'downloading') size = 'Current stream · ' + size;
  view.size.textContent = size;
  view.progress.max = job.total || 1;
  if (job.total) view.progress.value = Math.min(job.received || 0, job.total);
  else if (job.status === 'downloading') view.progress.removeAttribute('value');
  else view.progress.value = 0;
  view.progress.setAttribute('aria-label', status[0] + ': ' + size);
  view.progress.hidden = job.status === 'completed';
  view.error.textContent = job.error || job.detail || '';
  view.error.style.color = job.error ? '' : 'var(--muted)';
  view.error.hidden = !job.error && !job.detail;
  const active = ['downloading', 'queued'].includes(job.status);
  view.toggle.hidden = !['downloading', 'queued', 'paused', 'failed'].includes(job.status);
  const action = active ? 'pause' : 'resume';
  if (view.toggle.dataset.action !== action) {
    view.toggle.dataset.action = action;
    view.toggle.replaceChildren(icon(active ? 'pause' : 'play'));
  }
  view.toggle.title = active ? 'Pause download' : 'Resume download';
  view.toggle.setAttribute('aria-label', view.toggle.title);
  view.toggle.disabled = pending.has(job.id);
  view.remove.disabled = pending.has(job.id);
}
function render() {
  document.querySelectorAll('[data-count]').forEach(element => {
    element.textContent = jobs.filter(job => matchesFilter(job, element.dataset.count)).length;
  });
  const search = document.querySelector('#search').value.trim().toLowerCase();
  const visible = jobs.filter(job => matchesFilter(job, filter) && (job.name + ' ' + job.url).toLowerCase().includes(search)).reverse();
  const live = new Set(jobs.map(job => job.id));
  for (const [id, view] of views) if (!live.has(id)) { view.row.remove(); views.delete(id); }
  for (const view of views.values()) view.row.hidden = true;
  visible.forEach((job, index) => {
    let view = views.get(job.id);
    if (!view) { view = createView(job.id); views.set(job.id, view); }
    updateView(view, job);
    view.row.hidden = false;
    if (jobsElement.children[index] !== view.row) jobsElement.insertBefore(view.row, jobsElement.children[index] || null);
  });
  document.querySelector('#count').textContent = visible.length + (visible.length === 1 ? ' file' : ' files');
  const empty = document.querySelector('#empty-state');
  empty.hidden = visible.length > 0;
  document.querySelector('.list-heading').hidden = !visible.length;
  document.querySelector('#empty-title').textContent = search ? 'No matching downloads' : filter === 'all' ? 'Ready when you are' : 'No ' + titles[filter].toLowerCase() + ' downloads';
  document.querySelector('#empty-copy').textContent = search ? 'Try a different file name or website.' : filter === 'all' ? 'Paste a link above to start your first download.' : 'Downloads in this category will appear here.';
  const active = jobs.filter(job => matchesFilter(job, 'active')).length;
  document.querySelector('#library-summary').textContent = jobs.length + ' total · ' + active + ' in progress';
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    jobs = await api('jobs');
    render();
    document.querySelector('#connection').classList.remove('offline');
    document.querySelector('#connection').lastChild.textContent = 'Connected';
  } catch (error) {
    document.querySelector('#connection').classList.add('offline');
    document.querySelector('#connection').lastChild.textContent = 'Disconnected';
    notify(error.message, 'error');
  } finally { refreshing = false; }
}
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(item => {
    item.classList.toggle('selected', item === button);
    if (item === button) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  });
  document.querySelector('#page-title').textContent = titles[filter];
  render();
}));
document.querySelector('#search').addEventListener('input', render);
jobsElement.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.closest('[data-id]').dataset.id;
  if (pending.has(id)) return;
  pending.add(id);
  render();
  try {
    await api('jobs/' + id + '/' + button.dataset.action, { method: 'POST' });
    if (button.dataset.action === 'remove') notify('Removed from the list. Completed files are kept.');
    await refresh();
  } catch (error) { notify(error.message, 'error'); }
  finally { pending.delete(id); render(); }
});
function inspectState(busy) {
  inspectButton.disabled = busy;
  inspectButton.classList.toggle('busy', busy);
  inspectButton.querySelector('span').textContent = busy ? 'Finding qualities…' : 'Video qualities';
  inspectButton.querySelector('use').setAttribute('href', '/icons.svg#' + (busy ? 'refresh' : 'film'));
}
document.querySelector('#url').addEventListener('input', () => {
  inspection?.abort();
  inspectedUrl = null;
  videoOptions.hidden = true;
  inspectState(false);
});
inspectButton.addEventListener('click', async () => {
  const input = document.querySelector('#url');
  if (!input.reportValidity()) return;
  inspection?.abort();
  const current = new AbortController();
  inspection = current;
  const url = input.value;
  inspectState(true);
  notify('');
  try {
    const result = await api('media/formats', { method: 'POST', body: JSON.stringify({ url }), signal: current.signal });
    if (current.signal.aborted || input.value !== url) return;
    qualityElement.replaceChildren(...result.qualities.map(quality => {
      const option = new Option(quality.label, quality.value);
      option.disabled = quality.value !== 'best' && !result.mergingAvailable;
      return option;
    }));
    inspectedUrl = url;
    document.querySelector('#video-title').textContent = result.title;
    document.querySelector('#mode').value = 'video';
    document.querySelector('#quality-note').textContent = result.qualities.length > 1 ? 'Available source qualities. Audio is included when provided.' : 'One source stream is available; its resolution is not reported.';
    videoOptions.hidden = false;
  } catch (error) { if (!current.signal.aborted) notify(error.message, 'error'); }
  finally { if (inspection === current) inspectState(false); }
});
document.querySelector('#add-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.querySelector('#add-download');
  button.disabled = true;
  const url = document.querySelector('#url').value;
  const selected = inspectedUrl === url ? qualityElement.value : 'best';
  try {
    await api('jobs', { method: 'POST', body: JSON.stringify({ url, mode: document.querySelector('#mode').value, segments: Number(document.querySelector('#segments').value), quality: selected === 'best' ? 'best' : Number(selected) }) });
    document.querySelector('#url').value = '';
    inspectedUrl = null;
    videoOptions.hidden = true;
    notify('Download added to your library.');
    await refresh();
  } catch (error) { notify(error.message, 'error'); }
  finally { button.disabled = false; }
});
document.querySelectorAll('[data-open-integration]').forEach(button => button.addEventListener('click', () => dialog.showModal()));
document.querySelector('#close-integration').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } });
document.querySelector('#open-extension').addEventListener('click', async () => {
  try { await api('browser/extension', { method: 'POST' }); }
  catch (error) { document.querySelector('#integration-status').textContent = error.message; }
});
await refresh();
setInterval(refresh, 1000);

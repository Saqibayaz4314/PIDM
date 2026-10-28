import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { runtimeResources } from './resources.js';

const resources = runtimeResources();
const defaultCommand = resources.extractor;
const ffmpegDirectory = resources.ffmpeg;

function numberOrNull(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function mediaMode(url, requested = 'auto') {
  if (!['auto', 'direct', 'video'].includes(requested)) throw new Error('Mode must be auto, direct, or video');
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (host === 'youtu.be' || ((host === 'youtube.com' || host.endsWith('.youtube.com')) && /^\/(watch|shorts|live|embed)(\/|$)/.test(parsed.pathname))) return 'video';
  if ((host === 'noodlemagazine.com' || host.endsWith('.noodlemagazine.com')) && parsed.pathname.startsWith('/watch/')) return 'video';
  return requested === 'auto' ? 'direct' : requested;
}

export function mediaInput(url, { mediaUrl, userAgent } = {}) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported');
  let source;
  if (mediaUrl) {
    source = new URL(mediaUrl);
    if (!['http:', 'https:'].includes(source.protocol)) throw new Error('Media URL must use HTTP or HTTPS');
  }
  if (userAgent !== undefined && (typeof userAgent !== 'string' || /[\r\n]/.test(userAgent) || userAgent.length > 1024)) throw new Error('Invalid browser user agent');
  return { url: parsed.href, mediaUrl: source?.href, userAgent };
}

export function mediaSource(input) {
  const host = new URL(input.url).hostname.toLowerCase();
  const youtube = host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
  if (youtube) {
    const page = new URL(input.url);
    const video = host === 'youtu.be' ? page.pathname.length > 1 :
      (page.pathname === '/watch' && page.searchParams.get('v')) || /^\/(shorts|embed|live)\/[^/]+/.test(page.pathname);
    if (!video) throw new Error('Open a YouTube video first, then use PIDM on its watch page. The YouTube homepage and channel pages are not video links.');
  }
  const captured = !youtube && input.mediaUrl;
  return { target: captured || input.url, referer: captured ? input.url : undefined };
}

export function videoQuality(value = 'best') {
  if (value === 'best' || (Number.isSafeInteger(value) && value > 0)) return value;
  throw new Error('Video quality must be best or a positive resolution');
}

export function formatSelection(quality = 'best', merging = true) {
  videoQuality(quality);
  const filter = quality === 'best' ? '' : `[height=${quality}]`;
  return merging ? `bv*${filter}+ba/b${filter}/bv${filter}` : `b${filter}`;
}

export function qualityChoices(formats) {
  if (!Array.isArray(formats)) throw new Error('Video engine returned an invalid format list');
  const heights = new Set();
  for (const format of formats) {
    if (!format || typeof format !== 'object' || format.has_drm || format.vcodec === 'none') continue;
    if (Number.isSafeInteger(format.height) && format.height > 0) heights.add(format.height);
  }
  const names = new Map([[1440, '1440p (2K/QHD)'], [2160, '2160p (4K)'], [4320, '4320p (8K)']]);
  return [{ value: 'best', label: 'Best available' }, ...[...heights].sort((left, right) => right - left).map(height => ({ value: height, label: names.get(height) || `${height}p` }))];
}

async function runEngine(args, { signal, command = defaultCommand, commandPrefix = [], onLine }) {
  signal.throwIfAborted();
  if (!existsSync(command)) throw new Error('Video support is not installed. Run npm run setup:media');
  const environment = { ...process.env };
  if (process.versions.electron) environment.ELECTRON_RUN_AS_NODE = '1';
  const child = spawn(command, [...commandPrefix, '--ignore-config', '--no-playlist', '--encoding', 'utf-8', '--js-runtimes', `node:${process.execPath}`, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment });
  const buffers = new Map();
  let lastError = '';
  let protocolError;
  let stopping;
  const stop = () => {
    if (stopping || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== 'win32') { child.kill(); return; }
    stopping = new Promise(complete => {
      const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); complete(); });
      killer.once('close', () => complete());
    });
  };
  const readLine = line => {
    if (line.includes('ERROR:')) lastError = line.slice(line.indexOf('ERROR:')).slice(0, 600);
    onLine(line);
  };
  const readChunk = stream => chunk => {
    if (protocolError) return;
    try {
      const value = `${buffers.get(stream) || ''}${chunk}`;
      if (Buffer.byteLength(value) > 4 * 1024 * 1024) throw new Error('Video engine output exceeded 4 MiB per line');
      const lines = value.split(/\r?\n/);
      buffers.set(stream, lines.pop());
      for (const line of lines) readLine(line);
    } catch (error) { protocolError = error; stop(); }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', readChunk('stdout'));
  child.stderr.on('data', readChunk('stderr'));
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  try {
    const code = await new Promise((complete, fail) => {
      child.once('error', fail);
      child.once('close', complete);
    });
    if (signal.aborted) throw new Error('Video operation cancelled');
    if (protocolError) throw new Error(`Invalid video engine output: ${protocolError.message}`);
    for (const value of buffers.values()) if (value) readLine(value);
    if (code !== 0) throw new Error(lastError || `Video engine exited with code ${code}`);
  } finally {
    signal.removeEventListener('abort', stop);
    await stopping;
  }
}

function browserHeaders({ referer, userAgent }) {
  return [...(referer ? ['--referer', referer] : []), ...(userAgent ? ['--user-agent', userAgent] : [])];
}

export async function inspectMedia(url, { mediaUrl, userAgent, signal = AbortSignal.timeout(45000), command, commandPrefix } = {}) {
  const input = mediaInput(url, { mediaUrl, userAgent });
  const source = mediaSource(input);
  let info;
  let formats;
  await runEngine([
    '--skip-download', '--simulate', '--socket-timeout', '15', '--retries', '1', '--extractor-retries', '1',
    '--print', 'PD_INFO:%(.{id,title})j',
    '--print', 'PD_FORMATS:%(formats.:.{height,vcodec,acodec,has_drm})j',
    ...browserHeaders({ referer: source.referer, userAgent: input.userAgent }),
    source.target
  ], { signal, command, commandPrefix, onLine: line => {
    if (line.startsWith('PD_INFO:')) info = JSON.parse(line.slice('PD_INFO:'.length));
    if (line.startsWith('PD_FORMATS:')) formats = JSON.parse(line.slice('PD_FORMATS:'.length));
  } });
  if (!info || typeof info.title !== 'string') throw new Error('Video engine did not report video details');
  return { title: info.title, qualities: qualityChoices(formats), mergingAvailable: existsSync(join(ffmpegDirectory, 'ffmpeg.exe')) };
}

export async function downloadMedia(url, { root, signal, quality = 'best', fragments = 4, referer, userAgent, onProgress = () => {}, onTitle = () => {}, command, commandPrefix }) {
  if (!Number.isInteger(fragments) || fragments < 1 || fragments > 4) throw new Error('Video fragment connections must be 1-4');
  const merging = existsSync(join(ffmpegDirectory, 'ffmpeg.exe'));
  if (videoQuality(quality) !== 'best' && !merging) throw new Error('Quality selection needs FFmpeg. Run npm run setup:ffmpeg');
  let reportedPath;
  await runEngine([
    '--continue', '--no-overwrites', '--newline', '--no-simulate', '--progress', '--windows-filenames',
    '--concurrent-fragments', String(fragments), '--socket-timeout', '20',
    '--retries', '3', '--fragment-retries', '3', '--no-skip-unavailable-fragments',
    '--retry-sleep', 'http:exp=1:8', '--retry-sleep', 'fragment:exp=1:8',
    '--format', formatSelection(quality, merging),
    ...(merging ? ['--ffmpeg-location', ffmpegDirectory] : []),
    '--paths', root,
    '--output', '%(title).140B [%(id)s] [%(height,format_id|source)s].%(ext)s',
    '--progress-template', 'download:PD_PROGRESS:%(progress.downloaded_bytes)s:%(progress.total_bytes)s:%(progress.total_bytes_estimate)s',
    '--print', 'before_dl:PD_TITLE:%(title)j',
    '--print', 'after_move:PD_FILE:%(filepath)j',
    ...browserHeaders({ referer, userAgent }), url
  ], { signal, command, commandPrefix, onLine: line => {
    const progress = /^PD_PROGRESS:(\d+|NA):(\d+|NA):(\d+|NA)/.exec(line);
    if (progress) onProgress(numberOrNull(progress[1]), numberOrNull(progress[2]) ?? numberOrNull(progress[3]));
    if (line.startsWith('PD_TITLE:')) {
      const title = JSON.parse(line.slice('PD_TITLE:'.length));
      if (typeof title === 'string') onTitle(title);
    }
    if (line.startsWith('PD_FILE:')) {
      const file = JSON.parse(line.slice('PD_FILE:'.length));
      if (typeof file === 'string') reportedPath = file;
    }
  } });
  if (!reportedPath) throw new Error('Video engine did not report an output file');
  const output = resolve(root, reportedPath);
  const parent = `${resolve(root)}${sep}`;
  if (!output.toLowerCase().startsWith(parent.toLowerCase())) throw new Error('Video output escaped the download directory');
  const size = (await stat(output)).size;
  return { name: basename(output), size };
}

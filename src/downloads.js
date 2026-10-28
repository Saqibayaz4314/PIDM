import { link, mkdir, open, readFile, rm, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { downloadMedia, mediaMode, mediaInput, mediaSource, videoQuality } from './media.js';
import { TransferPool, TransferError } from './transfer.js';
import { writeHistory } from './history.js';

const MAX_SEGMENTS = 8;
const DEFAULT_SEGMENTS = 4;
const ALLOWED_STATES = new Set(['queued', 'downloading', 'paused', 'completed', 'failed']);
const STORAGE = 'positioned-v1';

function safeName(value) {
  return String(value || 'download').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 180) || 'download';
}
function nameFromUrl(url) {
  try { return safeName(decodeURIComponent(basename(new URL(url).pathname) || 'download')); }
  catch { return 'download'; }
}
function segmentPlan(total, count, minimum) {
  const size = Math.max(minimum, Math.ceil(total / (count === 1 ? 1 : count * 2)));
  const parts = [];
  for (let start = 0; start < total; start += size) parts.push({ start, end: Math.min(total - 1, start + size - 1), done: 0 });
  return parts;
}
async function writeAt(handle, chunk, position) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, position + offset);
    if (!bytesWritten) throw new Error('Disk write did not make progress');
    offset += bytesWritten;
  }
}

export class DownloadManager {
  constructor(root = join(homedir(), 'Downloads', 'Personal Downloader'), onChange, options = {}) {
    this.root = root;
    this.onChange = onChange;
    this.jobs = new Map();
    this.controllers = new Map();
    this.activeRuns = new Map();
    this.activeHosts = new Map();
    this.pendingSave = Promise.resolve();
    this.pool = new TransferPool(options.transfer);
    this.maxDownloads = options.maxDownloads ?? 3;
    this.maxPerHost = options.maxPerHost ?? 2;
    this.minimumChunk = options.minimumChunk ?? 256 * 1024;
    this.notifyInterval = options.notifyInterval ?? 250;
    this.lastNotify = 0;
    this.closing = false;
  }

  async init() {
    await mkdir(join(this.root, '.parts'), { recursive: true });
    for (const entry of JSON.parse(await readFile(join(this.root, 'downloads.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '[]';
      throw error;
    }))) {
      if (!entry?.id || !ALLOWED_STATES.has(entry.status)) continue;
      if (entry.status === 'downloading' || entry.status === 'queued') entry.status = 'paused';
      entry.detail = entry.cleanupPending ? 'Downloaded. Temporary data cleanup will be retried when removing this entry.' : null;
      this.jobs.set(entry.id, entry);
    }
    await this.persist();
  }

  list() {
    return [...this.jobs.values()].map(({ id, url, name, status, total, received, error, mode, quality, detail }) => ({ id, url, name, status, total, received, error, mode, quality, detail }));
  }

  notify(immediate = false) {
    if (typeof this.onChange !== 'function' || this.closing) return;
    if (immediate || Date.now() - this.lastNotify >= this.notifyInterval) {
      clearTimeout(this.notification);
      this.notification = undefined;
      this.lastNotify = Date.now();
      this.onChange(this.list());
    } else if (!this.notification) {
      this.notification = setTimeout(() => { this.notification = undefined; this.notify(true); }, this.notifyInterval - (Date.now() - this.lastNotify));
      this.notification.unref?.();
    }
  }

  async persist() {
    const snapshot = JSON.stringify([...this.jobs.values()], null, 2);
    const writing = this.pendingSave.catch(() => {}).then(async () => {
      await writeHistory(this.root, snapshot);
      this.notify();
    });
    this.pendingSave = writing;
    await writing;
  }

  async add(url, requestedName, segments = DEFAULT_SEGMENTS, requestedMode = 'auto', browserMedia = {}) {
    if (this.closing) throw new Error('PIDM is closing');
    const input = mediaInput(url, browserMedia);
    if (!Number.isInteger(segments) || segments < 1 || segments > MAX_SEGMENTS) throw new Error('Connections must be 1-8');
    mediaMode(input.url, requestedMode);
    const quality = videoQuality(browserMedia.quality);
    const job = { id: randomUUID(), ...input, name: safeName(requestedName || nameFromUrl(url)), mode: requestedMode, quality, segmentsRequested: segments, status: 'queued', total: null, received: 0, error: null, detail: null, parts: [] };
    this.jobs.set(job.id, job);
    await this.persist();
    this.start();
    return job.id;
  }

  start() {
    if (this.closing) return;
    for (const job of this.jobs.values()) {
      if (this.activeRuns.size >= this.maxDownloads) break;
      if (job.status !== 'queued' || this.activeRuns.has(job.id)) continue;
      const host = new URL(job.url).hostname;
      if ((this.activeHosts.get(host) || 0) >= this.maxPerHost) continue;
      const controller = new AbortController();
      this.controllers.set(job.id, controller);
      this.activeHosts.set(host, (this.activeHosts.get(host) || 0) + 1);
      job.status = 'downloading';
      const run = this.run(job, controller.signal).finally(() => {
        this.controllers.delete(job.id);
        this.activeRuns.delete(job.id);
        const remaining = this.activeHosts.get(host) - 1;
        if (remaining) this.activeHosts.set(host, remaining); else this.activeHosts.delete(host);
        this.start();
      });
      this.activeRuns.set(job.id, run);
      void run.catch(() => {});
    }
  }

  async pause(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Download not found');
    if (!['downloading', 'queued'].includes(job.status)) return;
    job.status = 'paused';
    job.detail = null;
    this.controllers.get(id)?.abort(new Error('Download paused'));
    await this.activeRuns.get(id);
    await this.persist();
    this.notify(true);
  }

  async resume(id) {
    if (this.closing) throw new Error('PIDM is closing');
    const job = this.jobs.get(id);
    if (!job) throw new Error('Download not found');
    if (!['paused', 'failed'].includes(job.status)) return;
    job.status = 'queued';
    job.error = null;
    job.detail = null;
    await this.persist();
    this.start();
  }

  async remove(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Download not found');
    await this.pause(id);
    await this.activeRuns.get(id);
    await this.clearParts(job, false);
    this.jobs.delete(id);
    await this.persist();
    this.notify(true);
  }

  async close() {
    this.closing = true;
    clearTimeout(this.notification);
    const paused = await Promise.allSettled([...this.jobs.values()].map(job => this.pause(job.id)));
    const settled = await Promise.allSettled([...this.activeRuns.values()]);
    await this.pendingSave;
    const failed = [...paused, ...settled].find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  retryNote(job) {
    return ({ attempt, delay }) => {
      job.detail = 'Retry ' + attempt + '/' + this.pool.retries + ' — waiting ' + Math.ceil(delay / 1000) + 's for the server';
      this.notify(true);
    };
  }

  async probe(job, signal) {
    return this.pool.retry(job.url, signal, () => this.pool.response(job.url, { signal, headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' } }, async response => {
      if (response.headers.get('content-type')?.toLowerCase().startsWith('text/html')) return { webpage: true };
      const range = response.status === 206 ? /^bytes 0-0\/(\d+)$/.exec(response.headers.get('content-range') || '') : null;
      if (response.status === 206 && !range) throw new Error('Invalid server probe range');
      const length = range ? Number(range[1]) : Number(response.headers.get('content-length'));
      return { total: Number.isSafeInteger(length) && length > 0 ? length : null, ranges: Boolean(range), etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'), finalUrl: response.url };
    }), this.retryNote(job));
  }

  async runMedia(job, signal) {
    const source = mediaSource(job);
    const directory = this.mediaPath(job);
    await mkdir(directory, { recursive: true });
    const output = await downloadMedia(source.target, {
      root: directory, signal, quality: job.quality, referer: source.referer, userAgent: job.userAgent,
      fragments: Math.min(4, job.segmentsRequested),
      onProgress: (received, total) => {
        if (received !== null) job.received = received;
        if (total !== null) job.total = total;
        this.notify();
      },
      onTitle: title => { job.name = safeName(title); this.notify(); }
    });
    job.name = output.name;
    job.received = output.size;
    job.total = output.size;
    await this.publish(job, join(directory, output.name), signal);
  }

  async run(job, signal) {
    try {
      await this.persist();
      signal.throwIfAborted();
      if (mediaMode(job.url, job.mode || 'auto') === 'video') await this.runMedia(job, signal);
      else {
        const info = await this.probe(job, signal);
        signal.throwIfAborted();
        job.detail = null;
        if (info.webpage) {
          job.mode = 'video';
          await this.persist();
          await this.runMedia(job, signal);
        } else await this.runFile(job, info, signal);
      }
    } catch (error) {
      if (job.status !== 'paused') { job.status = 'failed'; job.error = error.message; }
    } finally {
      job.detail = job.cleanupPending ? 'Downloaded. Temporary data cleanup will be retried when removing this entry.' : null;
      await this.persist();
      this.notify(true);
    }
  }

  partPath(job, index) { return join(this.root, '.parts', job.id + '.' + index); }
  dataPath(job) { return join(this.root, '.parts', job.id + '.data'); }
  mediaPath(job) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(job.id)) throw new Error('Invalid download identity');
    return join(this.root, '.parts', job.id + '.media');
  }

  async clearParts(job, resetProgress = true) {
    const legacyCount = job.storage === STORAGE ? job.legacyPartCount || 0 : job.parts.length;
    await Promise.all([rm(this.dataPath(job), { force: true }), rm(join(this.root, '.parts', job.id + '.assembling'), { force: true }), rm(this.mediaPath(job), { recursive: true, force: true }), ...Array.from({ length: legacyCount }, (_, index) => rm(this.partPath(job, index), { force: true }))]);
    job.parts = [];
    delete job.legacyPartCount;
    delete job.cleanupPending;
    delete job.storage;
    if (resetProgress) job.received = 0;
  }

  async prepareFile(job, fresh = false) {
    if (fresh) {
      const handle = await open(this.dataPath(job), 'w+');
      job.storage = STORAGE;
      job.received = 0;
      return handle;
    }
    const positioned = job.storage === STORAGE;
    const handle = await open(this.dataPath(job), positioned ? 'r+' : 'w+').catch(async error => {
      if (!positioned || error.code !== 'ENOENT') throw error;
      for (const part of job.parts) part.done = 0;
      return open(this.dataPath(job), 'w+');
    });
    try {
      if (!positioned) {
        // Migrate older per-part files once. Keep them until the new manifest is saved.
        for (const [index, part] of job.parts.entries()) {
          part.done = 0;
          const legacy = await open(this.partPath(job, index), 'r').catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (!legacy) continue;
          try {
            const size = (await legacy.stat()).size;
            if (part.end === null || size > part.end - part.start + 1) continue;
            for await (const chunk of legacy.createReadStream({ autoClose: false })) {
              await writeAt(handle, chunk, part.start + part.done);
              part.done += chunk.length;
            }
          } finally { await legacy.close(); }
        }
        await handle.sync();
        job.legacyPartCount = job.parts.length;
        job.storage = STORAGE;
        await this.persist();
        await Promise.all(job.parts.map((_, index) => rm(this.partPath(job, index), { force: true })));
        delete job.legacyPartCount;
      } else {
        const size = (await handle.stat()).size;
        for (const part of job.parts) {
          if (!Number.isSafeInteger(part.done) || part.done < 0 || part.start + part.done > size || (part.end !== null && part.done > part.end - part.start + 1)) part.done = 0;
        }
      }
      job.received = job.parts.reduce((sum, part) => sum + part.done, 0);
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }

  async runFile(job, info, signal) {
    if (job.parts.length && (job.total !== info.total || job.etag !== info.etag || job.lastModified !== info.lastModified || (!info.etag && !info.lastModified))) await this.clearParts(job);
    Object.assign(job, { total: info.total, etag: info.etag, lastModified: info.lastModified, finalUrl: info.finalUrl });
    const fresh = !job.parts.length;
    if (fresh) job.parts = info.ranges ? segmentPlan(info.total, job.segmentsRequested, this.minimumChunk) : [{ start: 0, end: null, done: 0 }];
    const handle = await this.prepareFile(job, fresh);
    const cursors = new Map(job.parts.map((part, index) => [index, part.done]));
    try {
      await this.persist();
      const pending = job.parts.map((part, index) => index).filter(index => job.parts[index].end === null || job.parts[index].done < job.parts[index].end - job.parts[index].start + 1);
      let next = 0;
      const local = new AbortController();
      const combined = AbortSignal.any([signal, local.signal]);
      let firstError;
      let saving;
      let lastCheckpoint = Date.now();
      const checkpoint = async (force = false) => {
        if (saving) { await saving; if (!force) return; }
        if (!force && Date.now() - lastCheckpoint < 1000) return;
        lastCheckpoint = Date.now();
        // Snapshot only writes already completed before fsync. Later writes are
        // not advertised as resumable until a later checkpoint or graceful pause.
        const completedWrites = [...cursors];
        saving = (async () => {
          await handle.sync();
          for (const [index, done] of completedWrites) job.parts[index].done = done;
          await this.persist();
        })();
        try { await saving; } finally { saving = undefined; }
      };
      const worker = async () => {
        while (next < pending.length && !combined.aborted) {
          const index = pending[next++];
          try { await this.downloadPart(job, job.parts[index], index, handle, cursors, combined, checkpoint); }
          catch (error) { if (!firstError) firstError = error; local.abort(error); }
        }
      };
      await Promise.allSettled(Array.from({ length: Math.min(job.segmentsRequested, pending.length) }, worker));
      // Commit partial prefixes only after all writers stop and the staging data is synced.
      await checkpoint(true);
      if (firstError) throw firstError;
      signal.throwIfAborted();
      const size = (await handle.stat()).size;
      if (job.total !== null && (size !== job.total || job.received !== job.total)) throw new Error('Downloaded file size does not match the source');
    } finally { await handle.close(); }
    signal.throwIfAborted();
    await this.publish(job, this.dataPath(job), signal);
  }

  async publish(job, source, signal) {
    signal.throwIfAborted();
    await link(source, join(this.root, job.name)).catch(async error => {
      if (error.code === 'EEXIST') throw new Error('File already exists: ' + job.name);
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) throw error;
      await copyFile(source, join(this.root, job.name), constants.COPYFILE_EXCL);
    });
    job.status = 'completed';
    job.total = job.received;
    try { await this.clearParts(job, false); }
    catch { job.cleanupPending = true; }
  }

  async downloadPart(job, part, index, handle, cursors, signal, checkpoint) {
    await this.pool.retry(job.finalUrl, signal, async () => {
      signal.throwIfAborted();
      let done = cursors.get(index);
      // Retrying an unvalidated stream must restart that segment, never append old bytes.
      if (part.end === null || (!job.etag && !job.lastModified)) {
        job.received -= done;
        done = 0;
        cursors.set(index, 0);
        if (part.end === null) await handle.truncate(0);
      }
      if (part.end !== null && done === part.end - part.start + 1) {
        return;
      }
      const start = part.start + done;
      const headers = { 'Accept-Encoding': 'identity' };
      if (part.end !== null) headers.Range = 'bytes=' + start + '-' + part.end;
      if (headers.Range && job.etag) headers['If-Range'] = job.etag;
      else if (headers.Range && job.lastModified) headers['If-Range'] = job.lastModified;
      await this.pool.response(job.finalUrl, { signal, headers }, async (response, pulse, requestSignal) => {
        if (part.end !== null && (response.status !== 206 || response.headers.get('content-range') !== 'bytes ' + start + '-' + part.end + '/' + job.total)) throw new Error('Server range response changed; cannot safely resume');
        job.detail = null;
        for await (const chunk of response.body) {
          requestSignal.throwIfAborted();
          if (part.end !== null && done + chunk.length > part.end - part.start + 1) throw new Error('Server sent bytes outside the requested range');
          await writeAt(handle, chunk, part.start + done);
          done += chunk.length;
          cursors.set(index, done);
          job.received += chunk.length;
          pulse();
          this.notify();
          await checkpoint();
        }
        if (part.end !== null && done !== part.end - part.start + 1) throw new TransferError('Incomplete range response', { retryable: true });
      });
    }, this.retryNote(job));
  }
}

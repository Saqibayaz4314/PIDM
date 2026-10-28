import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DownloadManager } from '../src/downloads.js';
import { retryAfter } from '../src/transfer.js';

const data = Buffer.alloc(2 * 1024 * 1024);
for (let index = 0; index < data.length; index++) data[index] = index % 251;

async function wait(condition, message = 'condition', timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function setup(t, handler, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pidm-transfer-'));
  const source = createServer(handler);
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  const manager = new DownloadManager(root, undefined, { minimumChunk: 64 * 1024, transfer: { backoffMs: 10 }, ...options });
  await manager.init();
  t.after(async () => {
    try { await manager.close(); }
    finally {
      source.closeAllConnections();
      await new Promise(resolve => source.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
  return { root, manager, url: 'http://127.0.0.1:' + source.address().port };
}

function range(request, response, bytes = data, { etag = '"fixture-v1"', delay = 0, cut = false } = {}) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
  const start = match ? Number(match[1]) : 0;
  const end = match ? Number(match[2]) : bytes.length - 1;
  const body = bytes.subarray(start, end + 1);
  response.writeHead(match ? 206 : 200, {
    'Content-Length': body.length, 'Content-Type': 'application/octet-stream',
    ...(etag ? { ETag: etag } : {}), ...(match ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + bytes.length } : {})
  });
  if (cut) { response.write(body.subarray(0, 8192)); setTimeout(() => response.destroy(), 30); return; }
  if (!delay) { response.end(body); return; }
  let offset = 0;
  const timer = setInterval(() => {
    if (offset >= body.length) { clearInterval(timer); response.end(); return; }
    const chunk = body.subarray(offset, offset + 8192); offset += chunk.length;
    if (offset >= body.length) { clearInterval(timer); response.end(chunk); }
    else response.write(chunk);
  }, delay);
  response.on('close', () => clearInterval(timer));
}

async function finished(manager, id) {
  await wait(() => ['completed', 'failed'].includes(manager.jobs.get(id).status), 'download completion');
  assert.equal(manager.jobs.get(id).status, 'completed', manager.jobs.get(id).error);
  await manager.activeRuns.get(id);
}

test('chunk workers reconstruct exact bytes and publish the staging inode without a merge copy', async t => {
  let requests = 0;
  const { root, manager, url } = await setup(t, (request, response) => { requests++; range(request, response, data, { delay: 2 }); });
  const id = await manager.add(url + '/file.bin', 'exact.bin', 4);
  await wait(() => manager.jobs.get(id).received > 0);
  const staging = await stat(manager.dataPath(manager.jobs.get(id)));
  await finished(manager, id);
  assert.ok(requests > 5, 'Workers should take multiple chunks, not one fixed part each');
  assert.deepEqual(await readFile(join(root, 'exact.bin')), data);
  assert.equal((await stat(join(root, 'exact.bin'))).ino, staging.ino);
  assert.deepEqual(await readdir(join(root, '.parts')), []);
});

for (const validated of [true, false]) test('interrupted response retries ' + (validated ? 'from a validated offset' : 'from the segment start without a validator'), async t => {
  let broken = false;
  const starts = [];
  const { root, manager, url } = await setup(t, (request, response) => {
    if (request.headers.range !== 'bytes=0-0') {
      starts.push(Number(/^bytes=(\d+)/.exec(request.headers.range)[1]));
      if (!broken) { broken = true; range(request, response, data, { cut: true, etag: validated ? '"fixture-v1"' : null }); return; }
    }
    range(request, response, data, { etag: validated ? '"fixture-v1"' : null });
  });
  const id = await manager.add(url + '/retry.bin', 'retry.bin', 1);
  await finished(manager, id);
  assert.equal(starts[0], 0);
  assert.equal(validated ? starts[1] > 0 : starts[1] === 0, true);
  assert.deepEqual(await readFile(join(root, 'retry.bin')), data);
});

test('429 Retry-After delays sibling requests and then recovers automatically', async t => {
  let first = true;
  let limitedAt;
  const transfers = [];
  const { manager, url } = await setup(t, (request, response) => {
    if (first) { first = false; limitedAt = Date.now(); response.writeHead(429, { 'Retry-After': '1' }); response.end(); return; }
    if (request.headers.range !== 'bytes=0-0') transfers.push(Date.now());
    range(request, response);
  });
  const ids = await Promise.all([manager.add(url + '/a', 'a.bin'), manager.add(url + '/b', 'b.bin')]);
  await Promise.all(ids.map(id => finished(manager, id)));
  assert.ok(transfers.length);
  assert.ok(transfers.every(time => time - limitedAt >= 950), 'Server cooldown must cover sibling transfers');
  assert.equal(manager.pool.active, 0);
  assert.equal(manager.pool.waiting.length, 0);
});

test('pause cancels Retry-After sleep promptly and queued removal never sends a request', async t => {
  let requests = 0;
  const { manager, url } = await setup(t, (request, response) => { requests++; response.writeHead(429, { 'Retry-After': '20' }); response.end(); }, { maxDownloads: 1 });
  const id = await manager.add(url + '/wait', 'wait.bin');
  const queued = await manager.add(url + '/queued', 'queued.bin');
  assert.equal(manager.jobs.get(queued).status, 'queued');
  await manager.remove(queued);
  await wait(() => Boolean(manager.jobs.get(id).detail));
  const started = Date.now();
  await manager.pause(id);
  assert.ok(Date.now() - started < 1000);
  assert.equal(requests, 1);
  assert.equal(manager.activeRuns.size, 0);
  assert.equal(manager.pool.active, 0);
  assert.equal(manager.pool.waiting.length, 0);
});

test('per-host job and connection limits hold while another host can use a queue slot', async t => {
  let active = 0;
  let peak = 0;
  const hosts = new Map();
  let hostPeak = 0;
  const { manager, url } = await setup(t, (request, response) => {
    if (request.headers.range === 'bytes=0-0') { range(request, response); return; }
    const host = request.headers.host;
    active++; peak = Math.max(peak, active);
    hosts.set(host, (hosts.get(host) || 0) + 1); hostPeak = Math.max(hostPeak, hosts.get(host));
    let released = false;
    const release = () => { if (released) return; released = true; active--; hosts.set(host, hosts.get(host) - 1); };
    response.once('finish', release); response.once('close', release);
    range(request, response, data, { delay: 3 });
  }, { maxDownloads: 3, maxPerHost: 1, transfer: { connections: 3, perHost: 2, backoffMs: 10 } });
  const one = await manager.add(url + '/one', 'one.bin', 8);
  const queued = await manager.add(url + '/two', 'two.bin', 8);
  const other = await manager.add(url.replace('127.0.0.1', 'localhost') + '/three', 'three.bin', 8);
  await wait(() => manager.activeRuns.size === 2);
  assert.equal(manager.jobs.get(queued).status, 'queued');
  await Promise.all([one, queued, other].map(id => finished(manager, id)));
  assert.ok(peak <= 3, 'Global response-body leases are bounded');
  assert.ok(hostPeak <= 2, 'Per-host transfer leases are bounded');
});

test('non-retryable errors fail immediately; temporary errors stop after the retry budget', async t => {
  const calls = new Map();
  const { manager, url } = await setup(t, (request, response) => {
    calls.set(request.url, (calls.get(request.url) || 0) + 1);
    response.writeHead(request.url === '/forbidden' ? 403 : 503); response.end();
  });
  const ids = await Promise.all([manager.add(url + '/forbidden'), manager.add(url + '/temporary')]);
  await wait(() => ids.every(id => manager.jobs.get(id).status === 'failed'));
  assert.equal(calls.get('/forbidden'), 1);
  assert.equal(calls.get('/temporary'), 4);
  await wait(() => manager.activeRuns.size === 0);
  assert.equal(manager.pool.active, 0);
});

test('stalled body retries are bounded and the next queued job still completes', async t => {
  const { manager, url } = await setup(t, (request, response) => {
    if (request.url === '/stalled' && request.headers.range !== 'bytes=0-0') {
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range);
      const start = Number(match[1]), end = Number(match[2]);
      response.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': 'bytes ' + start + '-' + end + '/' + data.length }); response.flushHeaders();
    } else range(request, response);
  }, { maxDownloads: 1, transfer: { retries: 1, backoffMs: 5, stallMs: 250 } });
  const bad = await manager.add(url + '/stalled');
  const good = await manager.add(url + '/good', 'good.bin');
  await finished(manager, good);
  assert.equal(manager.jobs.get(bad).status, 'failed');
  assert.match(manager.jobs.get(bad).error, /stalled/);
  assert.equal(manager.pool.active, 0);
});

test('legacy range parts migrate and resume without discarding their verified prefix', async t => {
  const starts = [];
  const { root, manager, url } = await setup(t, (request, response) => { starts.push(request.headers.range); range(request, response); });
  const id = randomUUID();
  const job = { id, url: url + '/legacy', name: 'legacy.bin', status: 'paused', mode: 'direct', quality: 'best', total: data.length, received: 8192, etag: '"fixture-v1"', lastModified: null, segmentsRequested: 1, parts: [{ start: 0, end: data.length - 1, done: 8192 }] };
  await writeFile(join(root, '.parts', id + '.0'), data.subarray(0, 8192));
  await writeFile(join(root, 'downloads.json'), JSON.stringify([job]));
  await manager.init();
  await manager.resume(id);
  await finished(manager, id);
  assert.ok(starts.includes('bytes=8192-' + (data.length - 1)));
  assert.deepEqual(await readFile(join(root, 'legacy.bin')), data);
  assert.deepEqual(await readdir(join(root, '.parts')), []);
});

test('positioned partials resume across restart and restart cleanly after a validator change', async t => {
  let bytes = data;
  let etag = '"fixture-v1"';
  const { root, manager, url } = await setup(t, (request, response) => range(request, response, bytes, { etag, delay: 3 }));
  const id = await manager.add(url + '/restart', 'restart.bin', 2);
  await wait(() => manager.jobs.get(id).received > 0);
  await manager.pause(id);
  const restarted = new DownloadManager(root);
  t.after(() => restarted.close());
  await restarted.init();
  await restarted.resume(id);
  await wait(() => restarted.jobs.get(id).received > 65536);
  await restarted.pause(id);
  bytes = Buffer.alloc(data.length, 99); etag = '"fixture-v2"';
  await restarted.resume(id);
  await finished(restarted, id);
  assert.deepEqual(await readFile(join(root, 'restart.bin')), bytes);
});

test('an existing final file is never overwritten and removing the failed job preserves it', async t => {
  const { root, manager, url } = await setup(t, (request, response) => range(request, response));
  await writeFile(join(root, 'keep.bin'), 'keep me');
  const id = await manager.add(url + '/collision', 'keep.bin');
  await wait(() => manager.jobs.get(id).status === 'failed');
  assert.match(manager.jobs.get(id).error, /already exists/);
  await manager.remove(id);
  assert.equal(await readFile(join(root, 'keep.bin'), 'utf8'), 'keep me');
  assert.deepEqual(await readdir(join(root, '.parts')), []);
});

test('without a progress subscriber no full-library projection is made during transfer', async t => {
  const { root, manager, url } = await setup(t, (request, response) => range(request, response));
  manager.list = () => { throw new Error('Unused progress projection'); };
  const id = await manager.add(url + '/no-listener', 'no-listener.bin');
  await finished(manager, id);
  assert.deepEqual(await readFile(join(root, 'no-listener.bin')), data);
});

test('Retry-After handles seconds and dates without shortening server waits', () => {
  assert.equal(retryAfter('12'), 12000);
  assert.equal(retryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 1000), 9000);
  assert.equal(retryAfter('nonsense'), 0);
  assert.equal(retryAfter('Thu, 01 Jan 1970 00:00:00 GMT', 1000), 0);
});

test('shutdown cancels active and queued work and waits for every writer', async t => {
  const { manager, url, root } = await setup(t, (request, response) => range(request, response, data, { delay: 10 }), { maxDownloads: 1 });
  const active = await manager.add(url + '/active', 'active.bin', 8);
  const queued = await manager.add(url + '/queued', 'queued.bin', 8);
  await wait(() => manager.jobs.get(active).received > 0);
  await manager.close();
  assert.equal(manager.jobs.get(active).status, 'paused');
  assert.equal(manager.jobs.get(queued).status, 'paused');
  assert.equal(manager.activeRuns.size, 0);
  assert.equal(manager.pool.active, 0);
  assert.equal(manager.pool.waiting.length, 0);
  const before = await stat(manager.dataPath(manager.jobs.get(active)));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await stat(manager.dataPath(manager.jobs.get(active)))).size, before.size);
  const records = JSON.parse(await readFile(join(root, 'downloads.json'), 'utf8'));
  assert.ok(records.every(job => job.status === 'paused'));
});

test('temporary cleanup failure keeps the completed file and retains ownership for retry', async t => {
  const { manager, url, root } = await setup(t, (request, response) => range(request, response));
  const clear = manager.clearParts.bind(manager);
  let fail = true;
  manager.clearParts = async (...args) => {
    if (args[0].status === 'completed' && fail) { fail = false; throw new Error('Temporary file locked'); }
    return clear(...args);
  };
  const id = await manager.add(url + '/locked', 'locked.bin');
  await finished(manager, id);
  assert.equal(manager.jobs.get(id).cleanupPending, true);
  assert.ok((await readdir(join(root, '.parts'))).length);
  await manager.remove(id);
  assert.deepEqual(await readFile(join(root, 'locked.bin')), data);
  assert.deepEqual(await readdir(join(root, '.parts')), []);
});

test('shutdown waits for final cleanup even after the final file has been published', async t => {
  const { manager, url, root } = await setup(t, (request, response) => range(request, response));
  const clear = manager.clearParts.bind(manager);
  let unblock;
  const barrier = new Promise(resolve => { unblock = resolve; });
  manager.clearParts = async (...args) => { if (args[0].status === 'completed') await barrier; return clear(...args); };
  const id = await manager.add(url + '/cleanup', 'cleanup.bin');
  await wait(() => manager.jobs.get(id).status === 'completed');
  let closed = false;
  const closing = manager.close().then(() => { closed = true; });
  try { await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(closed, false); }
  finally { unblock(); }
  await closing;
  assert.deepEqual(await readFile(join(root, 'cleanup.bin')), data);
  assert.equal(manager.activeRuns.size, 0);
  assert.deepEqual(await readdir(join(root, '.parts')), []);
});

test('a long single-connection transfer checkpoints synced prefixes before completion', async t => {
  const { root, manager, url } = await setup(t, (request, response) => range(request, response, data, { delay: 8 }));
  const id = await manager.add(url + '/checkpoint', 'checkpoint.bin', 1);
  let saved;
  const deadline = Date.now() + 8000;
  do {
    saved = JSON.parse(await readFile(join(root, 'downloads.json'), 'utf8')).find(job => job.id === id);
    if (saved?.status === 'failed') break;
    if (saved?.parts.some(part => part.done > 0)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(saved.status, 'downloading', saved.error);
  assert.ok(saved.parts[0].done > 0 && saved.parts[0].done < data.length);
  const staged = await readFile(manager.dataPath(saved));
  assert.deepEqual(staged.subarray(0, saved.parts[0].done), data.subarray(0, saved.parts[0].done));
  await assert.rejects(stat(join(root, 'checkpoint.bin')), { code: 'ENOENT' });
  await manager.pause(id);
});

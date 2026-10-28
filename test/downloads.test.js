import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadManager } from '../src/downloads.js';
import { startServer } from '../src/server.js';

const data = Buffer.from(Array.from({ length: 1024 * 1024 }, (_, index) => index % 251));

async function fixture({ ranges = true, slow = false } = {}) {
  const server = createServer((request, response) => {
    const range = ranges ? /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '') : null;
    const start = range ? Number(range[1]) : 0;
    const end = range ? Math.min(data.length - 1, range[2] ? Number(range[2]) : data.length - 1) : data.length - 1;
    const content = data.subarray(start, end + 1);
    response.writeHead(range ? 206 : 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': content.length,
      ETag: '"fixture-1"',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${data.length}` } : {})
    });
    if (!slow) return response.end(content);
    let offset = 0;
    const timer = setInterval(() => {
      if (response.destroyed) return clearInterval(timer);
      if (offset >= content.length) return clearInterval(timer), response.end();
      response.write(content.subarray(offset, offset + 2048));
      offset += 2048;
    }, 5);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/file.bin` };
}

async function waitFor(manager, id, expected) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = manager.jobs.get(id);
    if (job.status === expected) return job;
    if (job.status === 'failed' && expected !== 'failed') throw new Error(job.error);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

test('segmented download reconstructs exact bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-downloader-'));
  const { server, url } = await fixture();
  try {
    const manager = new DownloadManager(root);
    await manager.init();
    const id = await manager.add(url, 'sample.bin', 4);
    await waitFor(manager, id, 'completed');
    assert.deepEqual(await readFile(join(root, 'sample.bin')), data);
    assert.equal(manager.jobs.get(id).received, data.length);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('pause and resume preserves verified range parts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-downloader-'));
  const { server, url } = await fixture({ slow: true });
  try {
    const manager = new DownloadManager(root);
    await manager.init();
    const id = await manager.add(url, 'resumed.bin', 4);
    await waitFor(manager, id, 'downloading');
    await new Promise(resolve => setTimeout(resolve, 60));
    await manager.pause(id);
    assert.equal(manager.jobs.get(id).status, 'paused');
    await manager.resume(id);
    await waitFor(manager, id, 'completed');
    assert.deepEqual(await readFile(join(root, 'resumed.bin')), data);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('server without ranges downloads as a single stream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-downloader-'));
  const { server, url } = await fixture({ ranges: false });
  try {
    const manager = new DownloadManager(root);
    await manager.init();
    const id = await manager.add(url, 'single.bin', 4);
    await waitFor(manager, id, 'completed');
    assert.deepEqual(await readFile(join(root, 'single.bin')), data);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('paused download resumes after manager restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-downloader-'));
  const { server, url } = await fixture({ slow: true });
  try {
    const first = new DownloadManager(root);
    await first.init();
    const id = await first.add(url, 'restarted.bin', 4);
    await waitFor(first, id, 'downloading');
    await new Promise(resolve => setTimeout(resolve, 60));
    await first.pause(id);
    const second = new DownloadManager(root);
    await second.init();
    assert.equal(second.jobs.get(id).status, 'paused');
    await second.resume(id);
    await waitFor(second, id, 'completed');
    assert.deepEqual(await readFile(join(root, 'restarted.bin')), data);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('local API requires token and accepts a paired link', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-downloader-'));
  const source = await fixture();
  let extensionOpens = 0;
  const app = await startServer({ root, listenPort: 0, onOpenExtension: async () => { extensionOpens++; } });
  try {
    const unauthorized = await fetch(`${app.url}api/jobs`);
    assert.equal(unauthorized.status, 401);
    const blockedExtension = await fetch(`${app.url}api/browser/extension`, { method: 'POST' });
    assert.equal(blockedExtension.status, 401);
    assert.equal(extensionOpens, 0);
    const openExtension = await fetch(`${app.url}api/browser/extension`, { method: 'POST', headers: { 'X-Download-Token': app.token } });
    assert.equal(openExtension.status, 200);
    assert.equal(extensionOpens, 1);
    const response = await fetch(`${app.url}api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Download-Token': app.token },
      body: JSON.stringify({ url: source.url, name: 'paired.bin', segments: 2 })
    });
    assert.equal(response.status, 201);
    await waitFor(app.manager, (await response.json()).id, 'completed');
    assert.deepEqual(await readFile(join(root, 'paired.bin')), data);
    const id = app.manager.list()[0].id;
    const denied = await fetch(`${app.url}api/jobs/${id}/remove`, { method: 'POST' });
    assert.equal(denied.status, 401);
    const removed = await fetch(`${app.url}api/jobs/${id}/remove`, { method: 'POST', headers: { 'X-Download-Token': app.token } });
    assert.equal(removed.status, 200);
    assert.deepEqual(app.manager.list(), []);
    assert.deepEqual(await readFile(join(root, 'paired.bin')), data);
    const restarted = new DownloadManager(root);
    await restarted.init();
    assert.deepEqual(restarted.list(), []);
  } finally {
    app.server.closeAllConnections();
    source.server.closeAllConnections();
    await Promise.all([new Promise(resolve => app.server.close(resolve)), new Promise(resolve => source.server.close(resolve))]);
    await rm(root, { recursive: true, force: true });
  }
});

test('removing an active download stops its writer and clears only its partial files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-remove-'));
  const { server, url } = await fixture({ slow: true });
  const manager = new DownloadManager(root);
  try {
    await manager.init();
    const id = await manager.add(url, 'cancelled.bin', 2);
    await waitFor(manager, id, 'downloading');
    await new Promise(resolve => setTimeout(resolve, 60));
    await manager.remove(id);
    assert.deepEqual(manager.list(), []);
    assert.equal(manager.controllers.has(id), false);
    assert.deepEqual(await readdir(join(root, '.parts')), []);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'downloads.json'), 'utf8')), []);
  } finally {
    for (const job of manager.list()) await manager.pause(job.id);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

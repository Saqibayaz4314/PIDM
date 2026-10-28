import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadMedia } from '../src/media.js';
import { DownloadManager } from '../src/downloads.js';
import { startServer } from '../src/server.js';

test('concurrent identical video jobs keep temporary files isolated and never overwrite the winner', { skip: !process.env.TEST_REAL_MEDIA, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pidm-video-isolation-'));
  const source = await fixtureForIsolation();
  const manager = new DownloadManager(root);
  try {
    await manager.init();
    const ids = await Promise.all([manager.add(source.url, undefined, 4, 'video'), manager.add(source.url, undefined, 4, 'video')]);
    const deadline = Date.now() + 20000;
    while (ids.some(id => ['queued', 'downloading'].includes(manager.jobs.get(id).status)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
    await Promise.allSettled([...manager.activeRuns.values()]);
    assert.deepEqual(ids.map(id => manager.jobs.get(id).status).sort(), ['completed', 'failed']);
    const winner = ids.map(id => manager.jobs.get(id)).find(job => job.status === 'completed');
    const failed = ids.map(id => manager.jobs.get(id)).find(job => job.status === 'failed');
    assert.match(failed.error, /already exists/);
    await manager.remove(failed.id);
    assert.deepEqual(await readFile(join(root, winner.name)), source.bytes);
  } finally {
    await manager.close(); source.server.closeAllConnections();
    await new Promise(resolve => source.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

async function fixtureForIsolation() {
  const bytes = Buffer.alloc(16 * 1024, 7);
  const server = createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length }); response.end(bytes); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { bytes, server, url: 'http://127.0.0.1:' + server.address().port + '/same.mp4' };
}

test('installed yt-dlp downloads a local direct media fixture', { skip: !process.env.TEST_REAL_MEDIA }, async () => {
  const data = Buffer.alloc(16 * 1024, 7);
  const server = createServer((request, response) => {
    if (request.url === '/blocked') {
      response.writeHead(403);
      response.end();
      return;
    }
    if (request.url === '/protected.mp4' && (request.headers.referer !== `http://127.0.0.1:${server.address().port}/blocked` || request.headers['user-agent'] !== 'Fixture browser')) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (request.url === '/watch') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<html><head><title>Video ｜ اردو</title></head><body><video src="/sample.mp4"></video></body></html>');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': data.length });
    response.end(data);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'personal-real-اردو-｜-'));
  const manager = new DownloadManager(root);
  try {
    const output = await downloadMedia(`http://127.0.0.1:${server.address().port}/sample.mp4`, {
      root,
      signal: new AbortController().signal
    });
    assert.deepEqual(await readFile(join(root, output.name)), data);
    await manager.init();
    const id = await manager.add(`http://127.0.0.1:${server.address().port}/watch`, undefined, 1, 'direct');
    const deadline = Date.now() + 30000;
    while (['queued', 'downloading'].includes(manager.jobs.get(id).status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const job = manager.jobs.get(id);
    assert.equal(job.status, 'completed', job.error);
    assert.equal(job.mode, 'video');
    assert.match(job.name, /｜/);
    assert.match(job.name, /اردو/);
    assert.deepEqual(await readFile(join(root, job.name)), data);
    const captured = await manager.add(`http://127.0.0.1:${server.address().port}/blocked`, undefined, 1, 'video', {
      mediaUrl: `http://127.0.0.1:${server.address().port}/protected.mp4`,
      userAgent: 'Fixture browser'
    });
    const captureDeadline = Date.now() + 30000;
    while (['queued', 'downloading'].includes(manager.jobs.get(captured).status) && Date.now() < captureDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const capturedJob = manager.jobs.get(captured);
    assert.equal(capturedJob.status, 'completed', capturedJob.error);
    assert.deepEqual(await readFile(join(root, capturedJob.name)), data);
  } finally {
    for (const job of manager.list()) await manager.pause(job.id);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

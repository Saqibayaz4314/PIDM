import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';

const execute = promisify(execFile);
const binary = fileURLToPath(new URL('../bin/ffmpeg-9.0.2-essentials_build/bin/', import.meta.url));

test('real quality API downloads exact DASH resolutions and merges audible audio without collisions', { skip: !process.env.TEST_REAL_MEDIA, timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-quality-'));
  const heights = [480, 720, 1080, 1440, 2160];
  const widths = [854, 1280, 1920, 2560, 3840];
  let app;
  const source = createServer(async (request, response) => {
    if (request.url === '/clip.mpd') {
      response.writeHead(200, { 'Content-Type': 'application/dash+xml' });
      response.end(`<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT0.5S" minBufferTime="PT0.1S"><Period><AdaptationSet mimeType="video/mp4" contentType="video">${heights.map((height, index) => `<Representation id="v${height}" height="${height}" width="${widths[index]}" bandwidth="${height * 1000}" codecs="avc1.640028"><BaseURL>${height}.mp4</BaseURL></Representation>`).join('')}</AdaptationSet><AdaptationSet mimeType="audio/mp4" contentType="audio"><Representation id="audio" bandwidth="64000" codecs="mp4a.40.2" audioSamplingRate="44100"><BaseURL>audio.m4a</BaseURL></Representation></AdaptationSet></Period></MPD>`);
      return;
    }
    const filename = /^\/(480|720|1080|1440|2160)\.mp4$/.test(request.url) ? request.url.slice(1) : request.url === '/audio.m4a' ? 'audio.m4a' : null;
    if (!filename) { response.writeHead(404); response.end(); return; }
    const bytes = await readFile(join(root, filename));
    response.writeHead(200, { 'Content-Type': filename.endsWith('.m4a') ? 'audio/mp4' : 'video/mp4', 'Content-Length': bytes.length });
    response.end(bytes);
  });
  try {
    for (let index = 0; index < heights.length; index++) {
      await execute(join(binary, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=${widths[index]}x${heights[index]}:r=4`, '-t', '0.5', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', join(root, `${heights[index]}.mp4`)], { windowsHide: true });
    }
    await execute(join(binary, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '0.5', '-c:a', 'aac', '-b:a', '64k', join(root, 'audio.m4a')], { windowsHide: true });
    await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
    app = await startServer({ root: join(root, 'downloads'), listenPort: 0 });
    const headers = { 'Content-Type': 'application/json', 'X-Download-Token': app.token };
    const url = `http://127.0.0.1:${source.address().port}/clip.mpd`;
    const denied = await fetch(`${app.url}api/media/formats`, { method: 'POST', body: JSON.stringify({ url }) });
    assert.equal(denied.status, 401);
    const details = await fetch(`${app.url}api/media/formats`, { method: 'POST', headers, body: JSON.stringify({ url }) });
    assert.equal(details.status, 200);
    const available = await details.json();
    assert.deepEqual(available.qualities.map(choice => choice.value), ['best', 2160, 1440, 1080, 720, 480]);
    assert.equal(available.mergingAvailable, true);
    const names = new Set();
    for (const height of heights) {
      const added = await fetch(`${app.url}api/jobs`, { method: 'POST', headers, body: JSON.stringify({ url, mode: 'video', quality: height }) });
      assert.equal(added.status, 201);
      const { id } = await added.json();
      const deadline = Date.now() + 20000;
      while (['queued', 'downloading'].includes(app.manager.jobs.get(id).status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      const job = app.manager.jobs.get(id);
      assert.equal(job.status, 'completed', job.error);
      const result = await execute(join(binary, 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_type,height', '-of', 'json', join(app.manager.root, job.name)], { windowsHide: true });
      const streams = JSON.parse(result.stdout).streams;
      assert.equal(streams.find(stream => stream.codec_type === 'video').height, height);
      assert.ok(streams.some(stream => stream.codec_type === 'audio'));
      assert.equal(names.has(job.name), false);
      names.add(job.name);
    }
    const invalid = await fetch(`${app.url}api/jobs`, { method: 'POST', headers, body: JSON.stringify({ url, quality: '1080]+ba' }) });
    assert.equal(invalid.status, 400);
  } finally {
    if (app) {
      for (const job of app.manager.list()) await app.manager.pause(job.id);
      app.server.closeAllConnections();
      await new Promise(resolve => app.server.close(resolve));
    }
    source.closeAllConnections();
    if (source.listening) await new Promise(resolve => source.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

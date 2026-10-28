import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { downloadMedia } from '../src/media.js';

const execute = promisify(execFile);
const binary = fileURLToPath(new URL('../bin/ffmpeg-9.0.2-essentials_build/bin/', import.meta.url));

test('real HLS fragments run concurrently, retain audio and fail rather than skip missing fragments', { skip: !process.env.TEST_REAL_MEDIA, timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pidm-hls-'));
  let active = 0, peak = 0, missing = false;
  const payloads = new Map();
  const timers = new Set();
  const source = createServer((request, response) => {
    const name = request.url.slice(1);
    if (!/^clip\.m3u8$|^piece\d+\.ts$/.test(name)) { response.writeHead(404); response.end(); return; }
    if (name === 'clip.m3u8') { response.end(payloads.get(name)); return; }
    if (missing && name === 'piece001.ts') { response.writeHead(404); response.end(); return; }
    active++; peak = Math.max(peak, active);
    const timer = setTimeout(() => { timers.delete(timer); active--; response.end(payloads.get(name)); }, 150);
    timers.add(timer);
  });
  try {
    await execute(join(binary, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=128x72:r=8', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-g', '2', '-sc_threshold', '0', '-c:a', 'aac', '-hls_time', '0.25', '-hls_list_size', '0', '-hls_segment_filename', join(root, 'piece%03d.ts'), join(root, 'clip.m3u8')], { windowsHide: true });
    for (const name of await readdir(root)) payloads.set(name, await readFile(join(root, name)));
    await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + source.address().port + '/clip.m3u8';
    const output = await downloadMedia(url, { root: join(root, 'out'), signal: AbortSignal.timeout(20000), fragments: 3 });
    assert.ok(peak >= 2 && peak <= 3, 'Expected 2-3 simultaneous segment responses, observed ' + peak);
    const result = await execute(join(binary, 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', join(root, 'out', output.name)], { windowsHide: true });
    const streams = JSON.parse(result.stdout).streams;
    assert.ok(streams.some(stream => stream.codec_type === 'video'));
    assert.ok(streams.some(stream => stream.codec_type === 'audio'));
    missing = true;
    await assert.rejects(downloadMedia(url, { root: join(root, 'broken'), signal: AbortSignal.timeout(20000), fragments: 3 }), /fragment|404|unable/i);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    source.closeAllConnections();
    if (source.listening) await new Promise(resolve => source.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

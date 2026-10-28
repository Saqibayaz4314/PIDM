const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createServer } = require('node:http');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { join, dirname, resolve } = require('node:path');
const { tmpdir, homedir } = require('node:os');
const { randomUUID } = require('node:crypto');
const execute = promisify(execFile);

async function main() {
  const executable = resolve(process.argv[2] || 'release/win-unpacked/PIDM.exe');
  const resources = join(dirname(executable), 'resources');
  const tools = join(resources, 'bin', 'ffmpeg-9.0.2-essentials_build', 'bin');
  const root = await mkdtemp(join(tmpdir(), 'personal-packaged-smoke-'));
  const marker = `personal-smoke-${randomUUID()}`;
  const downloadRoot = join(homedir(), 'Downloads', 'Personal Downloader');
  const environment = { ...process.env, PATH: join(process.env.SystemRoot || 'C:\\Windows', 'System32') };
  delete environment.NODE_OPTIONS;
  delete environment.ELECTRON_RUN_AS_NODE;
  const url = 'http://127.0.0.1:17341/';
  const occupied = await fetch(url, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
  assert.equal(occupied, false, 'Close the running downloader before the packaged smoke test');
  const runtime = await execute(executable, ['--version'], { windowsHide: true, env: { ...environment, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10000 });
  assert.match(runtime.stdout.trim(), /^v\d+\./);
  let application;
  let jobId;
  let finalPath;
  let token;
  const source = createServer(async (request, response) => {
    if (request.url === `/${marker}.mpd`) {
      response.writeHead(200, { 'Content-Type': 'application/dash+xml' });
      response.end('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT0.5S" minBufferTime="PT0.1S"><Period><AdaptationSet mimeType="video/mp4" contentType="video"><Representation id="v720" height="720" width="1280" bandwidth="500000" codecs="avc1.640028"><BaseURL>video.mp4</BaseURL></Representation></AdaptationSet><AdaptationSet mimeType="audio/mp4" contentType="audio"><Representation id="audio" bandwidth="64000" codecs="mp4a.40.2" audioSamplingRate="44100"><BaseURL>audio.m4a</BaseURL></Representation></AdaptationSet></Period></MPD>');
      return;
    }
    const filename = request.url === '/video.mp4' ? 'video.mp4' : request.url === '/audio.m4a' ? 'audio.m4a' : null;
    if (!filename) { response.writeHead(404); response.end(); return; }
    const bytes = await readFile(join(root, filename));
    response.writeHead(200, { 'Content-Type': filename.endsWith('.m4a') ? 'audio/mp4' : 'video/mp4', 'Content-Length': bytes.length });
    response.end(bytes);
  });
  const api = async (path, body) => {
    const response = await fetch(`${url}api/${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Download-Token': token }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json();
    assert.ok(response.ok, value.error);
    return value;
  };
  try {
    await execute(join(tools, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=4', '-t', '0.5', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', join(root, 'video.mp4')], { windowsHide: true });
    await execute(join(tools, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '0.5', '-c:a', 'aac', join(root, 'audio.m4a')], { windowsHide: true });
    await new Promise(complete => source.listen(0, '127.0.0.1', complete));
    application = spawn(executable, [], { env: environment, stdio: 'ignore' });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (application.exitCode !== null) throw new Error(`Packaged application exited: ${application.exitCode}`);
      ready = await fetch(url).then(response => response.ok, () => false);
      if (ready) break;
      await new Promise(complete => setTimeout(complete, 100));
    }
    assert.ok(ready, 'Packaged app did not start its local server');
    token = await readFile(join(downloadRoot, '.api-token'), 'utf8');
    const sourceUrl = `http://127.0.0.1:${source.address().port}/${marker}.mpd`;
    const formats = await api('media/formats', { url: sourceUrl });
    assert.ok(formats.qualities.some(quality => quality.value === 720));
    assert.equal(formats.mergingAvailable, true);
    const job = await api('jobs', { url: sourceUrl, mode: 'video', quality: 720 });
    jobId = job.id;
    let current;
    for (let attempt = 0; attempt < 300; attempt++) {
      current = (await api('jobs')).find(entry => entry.id === jobId);
      if (current.status === 'failed') throw new Error(current.error);
      if (current.status === 'completed') break;
      await new Promise(complete => setTimeout(complete, 100));
    }
    assert.equal(current.status, 'completed');
    assert.ok(current.name.includes(marker));
    finalPath = join(downloadRoot, current.name);
    const probe = await execute(join(tools, 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_type,height', '-of', 'json', finalPath], { windowsHide: true });
    const streams = JSON.parse(probe.stdout).streams;
    assert.equal(streams.find(stream => stream.codec_type === 'video').height, 720);
    assert.ok(streams.some(stream => stream.codec_type === 'audio'));
    const extension = JSON.parse(await readFile(join(resources, 'browser-extension', 'manifest.json'), 'utf8'));
    assert.equal(extension.manifest_version, 3);
    await api(`jobs/${jobId}/remove`, {});
    jobId = null;
    await rm(finalPath);
    finalPath = null;
    process.stdout.write(JSON.stringify({ executable, externalNodeOnPath: false, appStarted: true, videoQualities: true, resolution: 720, audioMerged: true, extensionBundled: true }) + '\n');
  } finally {
    if (jobId && token) await api(`jobs/${jobId}/remove`, {}).catch(() => {});
    if (application && application.exitCode === null) await execute(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(application.pid), '/t', '/f'], { windowsHide: true }).catch(() => application.kill());
    source.closeAllConnections();
    if (source.listening) await new Promise(complete => source.close(complete));
    if (finalPath?.includes(marker)) await rm(finalPath, { force: true });
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const engine = resolve(option('--engine', 'src/downloads.js'));
const scenario = option('--scenario', 'throughput');

if (!args.includes('--worker')) {
  const samples = [];
  for (let repetition = 0; repetition < 3; repetition++) {
    const { stdout } = await execute(process.execPath, [process.argv[1], '--worker', '--engine', engine, '--scenario', scenario], { timeout: 60000, windowsHide: true });
    samples.push({ run: repetition + 1, ...JSON.parse(stdout) });
  }
  console.log(JSON.stringify({ scenario, engine, environment: 'Fresh Node process per run; localhost fixture and downloader share one process; OS disk cache uncontrolled', samples }, null, 2));
} else {
  const { DownloadManager } = await import(pathToFileURL(engine));
  const root = await mkdtemp(join(tmpdir(), 'pidm-bench-'));
  const data = Buffer.alloc(32 * 1024 * 1024, 17);
  let requests = 0, transfers = 0;
  const source = createServer((request, response) => {
    requests++;
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
    const start = match ? Number(match[1]) : 0;
    const end = match ? Number(match[2]) : data.length - 1;
    const bytes = data.subarray(start, end + 1);
    response.writeHead(match ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, ETag: '"benchmark-v1"', ...(match ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + data.length } : {}) });
    if (bytes.length === 1) { response.end(bytes); return; }
    transfers++;
    const slow = scenario === 'straggler' && transfers === 1;
    let offset = 0, timer;
    const write = () => {
      if (response.destroyed) return;
      const chunk = bytes.subarray(offset, offset + 65536);
      offset += chunk.length;
      if (offset >= bytes.length) { response.end(chunk); return; }
      if (response.write(chunk)) schedule(); else response.once('drain', schedule);
    };
    const schedule = () => { timer = slow ? setTimeout(write, 8) : setImmediate(write); };
    response.on('close', () => { if (slow) clearTimeout(timer); else clearImmediate(timer); });
    schedule();
  });
  let manager;
  try {
    await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
    manager = new DownloadManager(root);
    await manager.init();
    for (let index = 0; index < 1000; index++) {
      const id = randomUUID();
      manager.jobs.set(id, { id, url: 'https://example.test/archive/' + index, name: 'archive-' + index + '.bin', status: 'completed', total: 1024, received: 1024, parts: [] });
    }
    await manager.persist();
    const cpu = process.cpuUsage();
    const started = performance.now();
    const id = await manager.add('http://127.0.0.1:' + source.address().port + '/sample.bin', 'sample.bin', 4);
    const deadline = Date.now() + 45000;
    while (!['completed', 'failed'].includes(manager.jobs.get(id).status)) {
      if (Date.now() > deadline) throw new Error('Benchmark timed out');
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    await manager.activeRuns.get(id);
    const elapsedMs = performance.now() - started;
    const usage = process.cpuUsage(cpu);
    const peakRssMiB = process.resourceUsage().maxRSS / 1024;
    assert.equal(manager.jobs.get(id).status, 'completed', manager.jobs.get(id).error);
    const output = await readFile(join(root, 'sample.bin'));
    assert.equal(createHash('sha256').update(output).digest('hex'), createHash('sha256').update(data).digest('hex'));
    console.log(JSON.stringify({ bytes: data.length, historyEntries: 1000, connections: 4, elapsedMs: +elapsedMs.toFixed(1), cpuMs: +((usage.user + usage.system) / 1000).toFixed(1), peakRssMiB: +peakRssMiB.toFixed(1), requests, sha256Verified: true }));
  } finally {
    if (manager?.close) await manager.close();
    else if (manager) { for (const job of manager.jobs.values()) await manager.pause(job.id); await Promise.allSettled([...manager.activeRuns.values()]); }
    source.closeAllConnections();
    if (source.listening) await new Promise(resolve => source.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

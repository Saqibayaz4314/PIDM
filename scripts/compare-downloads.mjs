import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const baseline = process.argv[2];
if (!baseline) throw new Error('Usage: node scripts/compare-downloads.mjs path/to/baseline/src/downloads.js');
const candidate = resolve('src/downloads.js');
const report = { fixture: '32 MiB localhost transfer, 1000 completed history entries, 4 connections', runtime: { node: process.version, platform: process.platform, arch: process.arch }, methodology: 'Three fresh processes per engine/scenario; order alternates baseline/candidate. Server and downloader share a process. OS cache is uncontrolled; first and repeat runs are separate, not proven cold/warm disk runs. CPU and memory cover that single process. Internet performance, agent token costs and antivirus activity are not measured.', sourceDigests: {}, scenarios: {} };
for (const [label, engine] of [['baseline', baseline], ['candidate', candidate]]) {
  report.sourceDigests[label] = {};
  for (const file of ['downloads.js', 'transfer.js', 'history.js', 'media.js', 'resources.js']) {
    const bytes = await readFile(join(dirname(engine), file)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    report.sourceDigests[label][file] = bytes ? createHash('sha256').update(bytes).digest('hex') : null;
  }
}
const script = join(dirname(fileURLToPath(import.meta.url)), 'benchmark-downloads.mjs');
for (const scenario of ['throughput', 'straggler']) {
  const runs = { baseline: [], candidate: [] };
  for (let repetition = 0; repetition < 3; repetition++) {
    const order = repetition % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    for (const label of order) {
      const { stdout } = await execute(process.execPath, [script, '--worker', '--engine', label === 'baseline' ? baseline : candidate, '--scenario', scenario], { timeout: 60000, windowsHide: true });
      runs[label].push({ run: repetition + 1, ...JSON.parse(stdout) });
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[1];
  const summary = Object.fromEntries(Object.entries(runs).map(([label, values]) => [label, Object.fromEntries(['elapsedMs', 'cpuMs', 'peakRssMiB'].map(key => [key, median(values.map(value => value[key]))]))]));
  report.scenarios[scenario] = { runs, medians: summary };
}
await mkdir('.cache', { recursive: true });
await writeFile('.cache/engine-performance.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

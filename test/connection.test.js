import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startServer, browserOrigin } from '../src/server.js';
import { createConnection } from '../extension/connection.js';

test('automatic connection is pinned to PIDM and rejects websites, other extensions and missing origin', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url)));
  const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].flatMap(b => [b >> 4, b & 15]).map(n => String.fromCharCode(97 + n)).join('');
  assert.equal(browserOrigin, `chrome-extension://${id}`);
  const root = await mkdtemp(join(tmpdir(), 'pidm-connect-'));
  const app = await startServer({ root, listenPort: 0 });
  try {
    for (const origin of [undefined, 'null', 'https://example.com', 'chrome-extension://' + 'a'.repeat(32), browserOrigin + '.evil.test']) {
      for (const method of ['POST', 'OPTIONS']) {
        const response = await fetch(`${app.url}api/browser/connect`, { method, headers: origin ? { Origin: origin } : {} });
        assert.equal(response.status, 403);
        assert.equal(response.headers.get('access-control-allow-origin'), null);
        assert.equal(await response.text(), '');
      }
    }
    const stored = {};
    let connections = 0;
    const connection = createConnection({
      storage: { async get() { return { ...stored }; }, async set(value) { Object.assign(stored, value); } },
      request(url, options) {
        if (url.endsWith('/browser/connect')) connections++;
        return fetch(url.replace('http://127.0.0.1:17341/', app.url), { ...options, headers: { ...options.headers, Origin: browserOrigin } });
      }
    });
    await Promise.all([connection.connect(), connection.connect()]);
    assert.equal(connections, 1);
    assert.equal(stored.token, app.token);
    stored.token = 'stale';
    // Auth failure reconnects automatically; the operation itself still returns its real failure.
    await assert.rejects(connection.api('jobs/not-a-job/remove', {}), /Not found/);
    assert.equal(stored.token, app.token);
    assert.equal(connections, 2);
    const denied = await fetch(`${app.url}api/jobs`);
    assert.equal(denied.status, 401);
  } finally {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('closed desktop app gives an actionable message without asking for a token', async () => {
  const connection = createConnection({ request: async () => { throw new TypeError('fetch failed'); }, storage: {} });
  await assert.rejects(connection.connect(), /Open PIDM/);
  await assert.rejects(connection.connect(), /Open PIDM/);
});

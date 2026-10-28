import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server.js';

test('service shutdown cancels and awaits an in-flight real metadata extraction', { skip: !process.env.TEST_REAL_MEDIA, timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pidm-inspection-close-'));
  let reached;
  const requested = new Promise(resolve => { reached = resolve; });
  const source = createServer(() => reached());
  let app;
  try {
    await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
    app = await startServer({ root, listenPort: 0 });
    const pending = fetch(app.url + 'api/media/formats', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Download-Token': app.token }, body: JSON.stringify({ url: 'http://127.0.0.1:' + source.address().port + '/held.mp4' }), signal: AbortSignal.timeout(15000) }).then(response => response.text(), () => null);
    await requested;
    const started = Date.now();
    await app.close();
    assert.ok(Date.now() - started < 5000, 'Closing must cancel extraction instead of waiting for its network timeout');
    await pending;
    assert.equal(app.server.listening, false);
    assert.equal(app.manager.activeRuns.size, 0);
  } finally {
    if (app?.server.listening) await app.close();
    source.closeAllConnections();
    if (source.listening) await new Promise(resolve => source.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

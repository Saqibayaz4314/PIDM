const { app, BrowserWindow } = require('electron');
const { mkdirSync } = require('node:fs');
const { mkdtemp, writeFile, mkdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const project = join(__dirname, '..');
const profile = join(project, '.cache', 'ui-preview-profile');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
let server;
let root;
let window;
app.whenReady().then(async () => {
  root = await mkdtemp(join(tmpdir(), 'pidm-ui-'));
  const { startServer } = await import('../src/server.js');
  const running = await startServer({ root, listenPort: 0 });
  server = running.server;
  const samples = [
    { id: '00000000-0000-0000-0000-000000000001', name: 'Design systems — session 04.mp4', url: 'https://video.example.com/watch/session04', mode: 'video', quality: 1080, status: 'downloading', received: 27472691, total: 98985574, parts: [] },
    { id: '00000000-0000-0000-0000-000000000002', name: 'Brand assets.zip', url: 'https://files.example.com/brand-assets.zip', mode: 'direct', status: 'completed', received: 15518924, total: 15518924, parts: [] },
    { id: '00000000-0000-0000-0000-000000000003', name: 'Workshop recording.mp4', url: 'https://video.example.com/workshop', mode: 'video', quality: 720, status: 'paused', received: 11534336, total: 90177536, parts: [] },
    { id: '00000000-0000-0000-0000-000000000004', name: 'Product reference.pdf', url: 'https://files.example.com/reference.pdf', mode: 'direct', status: 'failed', received: 0, total: null, error: 'The server declined the request (HTTP 403). Check the source link and retry.', parts: [] }
  ];
  for (const sample of samples) running.manager.jobs.set(sample.id, sample);
  window = new BrowserWindow({ show: false, width: 1280, height: 880, backgroundColor: '#f5f6f9', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await window.loadURL(running.url);
  const evaluate = code => window.webContents.executeJavaScript(code);
  const wait = async expression => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(complete => setTimeout(complete, 50));
    }
    throw new Error('UI condition timed out: ' + expression);
  };
  await wait('document.querySelectorAll(".job:not([hidden])").length === 4');
  const output = join(project, 'ui-preview');
  await mkdir(output, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await evaluate('document.querySelector("[data-theme-choice=' + theme + ']").click()');
    assert.equal(await evaluate('document.documentElement.dataset.theme'), theme);
    assert.equal(await evaluate('localStorage.getItem("pidm-theme")'), theme);
    assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), theme === 'light' ? 'rgb(245, 246, 249)' : 'rgb(16, 19, 26)');
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
    await new Promise(complete => setTimeout(complete, 120));
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await writeFile(join(output, 'pidm-' + theme + '.png'), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  }
  await window.reload();
  await wait('document.querySelectorAll(".job:not([hidden])").length === 4');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
  await evaluate('document.querySelector("[data-filter=paused]").click()');
  assert.equal(await evaluate('document.querySelectorAll(".job:not([hidden])").length'), 1);
  await evaluate('document.querySelector("[data-filter=all]").click(); const search = document.querySelector("#search"); search.value="no-such-file"; search.dispatchEvent(new Event("input"))');
  assert.equal(await evaluate('document.querySelectorAll(".job:not([hidden])").length'), 0);
  assert.equal(await evaluate('document.querySelector("#empty-state").hidden'), false);
  await evaluate('document.querySelector("#search").value=""; document.querySelector("#search").dispatchEvent(new Event("input")); document.querySelector("[data-open-integration]").click()');
  assert.equal(await evaluate('document.querySelector("#integration-dialog").open'), true);
  await evaluate('document.querySelector("#close-integration").click()');
  await evaluate('window.previewRow = document.querySelector("[data-id=\\"00000000-0000-0000-0000-000000000001\\"]"); previewRow.querySelector("[data-action=pause]").click()');
  await wait('document.querySelector("[data-id=\\"00000000-0000-0000-0000-000000000001\\"]").dataset.status === "paused"');
  assert.ok(await evaluate('previewRow === document.querySelector("[data-id=\\"00000000-0000-0000-0000-000000000001\\"]")'));
  await window.setSize(860, 820);
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
  await writeFile(join(output, 'pidm-compact.png'), (await window.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ themes: ['light', 'dark'], themePersists: true, filters: true, search: true, integrationDialog: true, pauseAction: true, stableRows: true, compactLayout: true, screenshots: output }));
  window.destroy();
  await new Promise(complete => server.close(complete));
  await rm(root, { recursive: true, force: true });
  app.quit();
}).catch(async error => {
  console.error(error);
  window?.destroy();
  server?.close();
  app.exit(1);
});

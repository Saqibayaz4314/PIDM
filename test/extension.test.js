import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('pairing script loads as a module for top-level await', async () => {
  const html = await readFile(new URL('../extension/options.html', import.meta.url), 'utf8');
  assert.match(html, /<script type="module" src="options\.js"><\/script>/);
});

test('video button opens a quality picker before creating a download', async () => {
  const script = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  let listener;
  let stored;
  let opened;
  const context = {
    crypto: { randomUUID: () => 'fixture' },
    chrome: {
      runtime: { onInstalled: { addListener() {} }, onMessage: { addListener(callback) { listener = callback; } }, getURL: path => `chrome-extension://fixture/${path}` },
      storage: { local: { async get() { return { token: 'paired' }; } }, session: { async set(value) { stored = value; } } },
      tabs: { async create(value) { opened = value; } },
      contextMenus: { onClicked: { addListener() {} } },
      action: { onClicked: { addListener() {} } }
    },
    fetch() { throw new Error('Video downloads must wait for quality selection'); }
  };
  runInNewContext(script.replace("import { api } from './connection.js';", ''), { ...context, api() { throw new Error('Wait for quality selection'); } });
  const reply = await new Promise(resolve => listener({ type: 'download-url', url: 'https://example.test/watch', mode: 'video' }, {}, resolve));
  assert.equal(reply.selecting, true);
  assert.equal(stored['video-fixture'].url, 'https://example.test/watch');
  assert.equal(opened.url, 'chrome-extension://fixture/choose.html?request=video-fixture');
});

test('manifest injects the hover button into web pages', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.content_scripts[0].js[0], 'content.js');
  assert.deepEqual(manifest.content_scripts[0].matches, ['http://*/*', 'https://*/*']);
  assert.equal(manifest.content_scripts[0].all_frames, true);
});

test('hovering a direct link offers a button that sends its URL', async () => {
  const script = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const button = {
    style: {},
    textContent: '',
    offsetWidth: 150,
    offsetHeight: 35,
    setAttribute() {},
    contains() { return false; },
    addEventListener(name, callback) { listeners.set(`button:${name}`, callback); }
  };
  class Element { closest() { return null; } }
  class HTMLAnchorElement extends Element {
    constructor(href) { super(); this.href = href; this.isConnected = true; }
    closest(selector) { return selector.includes('a[') ? this : null; }
    getBoundingClientRect() { return { top: 40, bottom: 60, left: 20, right: 240 }; }
  }
  class HTMLMediaElement extends Element {
    constructor() { super(); this.isConnected = true; this.currentSrc = 'https://cdn.example.test/video.mp4'; }
    querySelector() { return null; }
    closest(selector) { return selector === 'video,audio' ? this : null; }
    getBoundingClientRect() { return { top: 100, bottom: 300, left: 20, right: 400, width: 380, height: 200 }; }
  }
  let sentMessage;
  const context = {
    document: { baseURI: 'https://example.test/', location: { href: 'https://example.test/watch' }, createElement: () => button, querySelectorAll: () => [], documentElement: { append() {} }, addEventListener: (name, callback) => listeners.set(`document:${name}`, callback) },
    window: { addEventListener() {} },
    chrome: { runtime: { async sendMessage(message) { sentMessage = message; return { ok: true }; } } },
    navigator: { userAgent: 'Fixture browser' },
    Element, HTMLAnchorElement, HTMLMediaElement, URL,
    innerWidth: 800, innerHeight: 600,
    setTimeout: () => 1, clearTimeout() {}
  };
  runInNewContext(script, context);
  const link = new HTMLAnchorElement('https://example.test/file.zip');
  listeners.get('document:pointerover')({ target: link });
  assert.equal(button.style.display, 'block');
  assert.match(button.textContent, /Download this link/);
  await listeners.get('button:click')({ preventDefault() {}, stopPropagation() {} });
  assert.equal(sentMessage.url, link.href);
  assert.equal(sentMessage.mode, 'auto');
  assert.match(button.textContent, /Added to downloader/);

  listeners.get('document:pointerover')({ target: new HTMLMediaElement() });
  assert.match(button.textContent, /Download this video/);
  const youtube = new HTMLMediaElement();
  context.document.location.href = 'https://www.youtube.com/';
  context.document.querySelectorAll = () => [];
  listeners.get('document:pointerover')({ target: youtube });
  assert.equal(button.textContent, 'Open this video first');
  const before = sentMessage;
  await listeners.get('button:click')({ preventDefault() {}, stopPropagation() {} });
  assert.equal(sentMessage, before, 'A homepage preview must not request homepage qualities');
  context.document.location.href = 'https://www.youtube.com/watch?v=firstvideo1';
  listeners.get('document:pointerover')({ target: youtube });
  context.document.location.href = 'https://www.youtube.com/watch?v=eaHfex71yO0';
  await listeners.get('button:click')({ preventDefault() {}, stopPropagation() {} });
  assert.equal(sentMessage.url, context.document.location.href, 'Click uses the current video after in-page navigation');
  context.document.location.href = 'https://www.youtube.com/';
  youtube.closest = selector => selector === 'video,audio' ? youtube : selector === 'a[href]' ? { href: 'https://www.youtube.com/watch?v=eaHfex71yO0' } : null;
  listeners.get('document:pointerover')({ target: youtube });
  await listeners.get('button:click')({ preventDefault() {}, stopPropagation() {} });
  assert.equal(sentMessage.url, 'https://www.youtube.com/watch?v=eaHfex71yO0', 'Preview resolves its own video link');
  context.document.location.href = 'https://example.test/watch';
  listeners.get('document:pointerover')({ target: new HTMLMediaElement() });
  await listeners.get('button:click')({ preventDefault() {}, stopPropagation() {} });
  assert.equal(sentMessage.url, 'https://example.test/watch');
  assert.equal(sentMessage.mode, 'video');
  assert.equal(sentMessage.mediaUrl, 'https://cdn.example.test/video.mp4');
  assert.equal(sentMessage.userAgent, 'Fixture browser');

  const stream = new HTMLMediaElement();
  stream.currentSrc = 'blob:https://example.test/fixture';
  listeners.get('document:pointerover')({ target: stream });
  await listeners.get('button:click')({ preventDefault() {}, stopPropagation() {} });
  assert.equal(sentMessage.url, 'https://example.test/watch');
  assert.equal(sentMessage.mediaUrl, null);
  context.document.querySelectorAll = () => [new HTMLMediaElement()];
  listeners.get('document:pointerover')({ target: new Element(), clientX: 120, clientY: 200 });
  assert.match(button.textContent, /Download this video/);
});

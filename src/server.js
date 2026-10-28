import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DownloadManager } from './downloads.js';
import { inspectMedia } from './media.js';

const directory = fileURLToPath(new URL('../web/', import.meta.url));
const port = 17341;
// Pinned to the public key shipped in PIDM's extension manifest.
export const browserOrigin = 'chrome-extension://gdidlebocdbpeoecpociegenlcalfgif';

function sameToken(expected, provided) {
  if (typeof provided !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 8192) throw new Error('Request too large');
  }
  return JSON.parse(body);
}

function send(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  response.end(JSON.stringify(value));
}

export async function startServer({ root, host = '127.0.0.1', listenPort = port, onChange, onOpenExtension } = {}) {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const manager = new DownloadManager(root, onChange);
  const inspections = new Map();
  await manager.init();
  const tokenPath = join(manager.root, '.api-token');
  let token = await readFile(tokenPath, 'utf8').catch(() => null);
  if (!token) {
    token = randomBytes(32).toString('hex');
    await writeFile(tokenPath, token, { flag: 'wx', mode: 0o600 }).catch(async error => {
      if (error.code !== 'EEXIST') throw error;
      token = await readFile(tokenPath, 'utf8');
    });
  }
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, `http://${host}`).pathname;
      if (pathname === '/api/browser/connect') {
        if (request.headers.origin !== browserOrigin || request.headers.host !== `${host}:${server.address().port}`) {
          response.writeHead(403, { 'Cache-Control': 'no-store' }); response.end(); return;
        }
        const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': browserOrigin, 'Vary': 'Origin' };
        if (request.method === 'OPTIONS') {
          response.writeHead(204, { ...headers, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST' }); response.end(); return;
        }
        if (request.method !== 'POST') { response.writeHead(405, headers); response.end(); return; }
        response.writeHead(200, headers); response.end(JSON.stringify({ token })); return;
      }
      if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
        response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Download-Token', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
        response.end();
        return;
      }
      if (pathname.startsWith('/api/')) {
        if (!sameToken(token, request.headers['x-download-token'])) return send(response, 401, { error: 'Pairing token required' });
        if (request.method === 'POST' && pathname === '/api/browser/extension') {
          if (!onOpenExtension) throw new Error('Open the extension folder from the desktop app.');
          await onOpenExtension();
          return send(response, 200, { ok: true });
        }
        if (request.method === 'POST' && pathname === '/api/media/formats') {
          const { url, mediaUrl, userAgent } = await readBody(request);
          const controller = new AbortController();
          const cancel = () => controller.abort();
          const timeout = setTimeout(cancel, 45000);
          response.once('close', cancel);
          const inspecting = inspectMedia(url, { mediaUrl, userAgent, signal: controller.signal });
          inspections.set(controller, inspecting);
          try {
            const formats = await inspecting;
            return send(response, 200, formats);
          } finally {
            clearTimeout(timeout);
            inspections.delete(controller);
            response.removeListener('close', cancel);
          }
        }
        if (request.method === 'GET' && pathname === '/api/jobs') return send(response, 200, manager.list());
        if (request.method === 'POST' && pathname === '/api/jobs') {
          const { url, name, segments, mode, mediaUrl, userAgent, quality } = await readBody(request);
          const id = await manager.add(url, name, segments, mode, { mediaUrl, userAgent, quality });
          return send(response, 201, { id });
        }
        const match = /^\/api\/jobs\/([a-f0-9-]+)\/(pause|resume|remove)$/.exec(pathname);
        if (request.method === 'POST' && match) {
          await manager[match[2]](match[1]);
          return send(response, 200, { ok: true });
        }
        return send(response, 404, { error: 'Not found' });
      }
      if (request.method !== 'GET') return send(response, 405, { error: 'Method not allowed' });
      if (pathname === '/') {
        const html = (await readFile(join(directory, 'index.html'), 'utf8')).replace('__TOKEN__', token).replace('__VERSION__', version);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'" });
        response.end(html);
        return;
      }
      const assets = new Map([
        ['/app.js', ['app.js', 'text/javascript']], ['/theme.js', ['theme.js', 'text/javascript']],
        ['/style.css', ['style.css', 'text/css']], ['/icons.svg', ['icons.svg', 'image/svg+xml']],
        ['/logo.svg', ['../assets/pidm.svg', 'image/svg+xml']]
      ]);
      if (assets.has(pathname)) {
        const [file, type] = assets.get(pathname);
        response.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(await readFile(join(directory, file)));
        return;
      }
      send(response, 404, { error: 'Not found' });
    } catch (error) {
      send(response, 400, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(listenPort, host, resolve));
  const close = async () => {
    const stopping = manager.close();
    for (const controller of inspections.keys()) controller.abort(new Error('PIDM is closing'));
    server.closeAllConnections();
    const [stopped] = await Promise.allSettled([stopping, ...inspections.values()]);
    if (stopped.status === 'rejected') throw stopped.reason;
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  return { server, manager, token, close, url: `http://${host}:${server.address().port}/` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { url } = await startServer();
  process.stdout.write(`Personal Downloader: ${url}\n`);
}

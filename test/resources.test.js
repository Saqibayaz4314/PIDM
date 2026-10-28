import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { runtimeResources } from '../src/resources.js';

test('packaged tools and extension resolve outside app.asar', () => {
  const root = join(process.cwd(), 'Installed App', 'resources');
  const paths = runtimeResources({ resourcesPath: root, defaultApp: false });
  assert.equal(paths.extractor, join(root, 'bin', 'yt-dlp.exe'));
  assert.equal(paths.ffmpeg, join(root, 'bin', 'ffmpeg-9.0.2-essentials_build', 'bin'));
  assert.equal(paths.extension, join(root, 'browser-extension'));
  assert.equal(paths.extractor.includes('app.asar'), false);
});

test('development Electron uses project resources rather than Electron installation resources', () => {
  const paths = runtimeResources({ resourcesPath: 'unused-electron-resources', defaultApp: true });
  assert.equal(paths.extension, join(process.cwd(), 'extension'));
});

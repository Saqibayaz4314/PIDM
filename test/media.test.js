import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadMedia, mediaMode, inspectMedia, qualityChoices, formatSelection, videoQuality, mediaInput, mediaSource } from '../src/media.js';

test('website video mode selects extractor without changing direct links', () => {
  assert.equal(mediaMode('https://www.youtube.com/watch?v=example'), 'video');
  assert.equal(mediaMode('https://www.youtube.com/watch?v=example', 'direct'), 'video');
  assert.equal(mediaMode('https://noodlemagazine.com/watch/-123_456'), 'video');
  assert.equal(mediaMode('https://example.test/file.zip'), 'direct');
  assert.equal(mediaMode('https://example.test/watch/123', 'video'), 'video');
  assert.throws(() => mediaMode('https://example.test/file', 'unknown'));
});

test('quality list contains only observed non-DRM video resolutions', () => {
  const choices = qualityChoices([
    { height: 27, vcodec: 'none', acodec: 'none' },
    { height: 480, vcodec: 'h264' },
    { height: 1080, vcodec: 'h264' },
    { height: 1080, vcodec: 'vp9' },
    { height: 1440, vcodec: 'vp9' },
    { height: 2160, vcodec: 'av1' },
    { height: 4320, vcodec: 'av1', has_drm: true },
    { height: null, vcodec: 'h264' }, null
  ]);
  assert.deepEqual(choices.map(choice => choice.value), ['best', 2160, 1440, 1080, 480]);
  assert.equal(choices[1].label, '2160p (4K)');
  assert.deepEqual(qualityChoices([{ vcodec: 'h264' }]), [{ value: 'best', label: 'Best available' }]);
  assert.throws(() => qualityChoices(null));
});

test('selected resolution cannot silently fall back to a lower quality', () => {
  assert.equal(formatSelection(1080), 'bv*[height=1080]+ba/b[height=1080]/bv[height=1080]');
  assert.equal(formatSelection('best'), 'bv*+ba/b/bv');
  assert.equal(formatSelection(720, false), 'b[height=720]');
  for (const invalid of [0, -1, 1080.5, '1080', '1080]+ba', null]) assert.throws(() => videoQuality(invalid));
});

test('YouTube quality detection uses the full page while other players retain captured source and referrer', () => {
  const youtube = mediaInput('https://www.youtube.com/watch?v=fixture', { mediaUrl: 'https://cdn.test/current360.mp4' });
  assert.equal(mediaSource(youtube).target, youtube.url);
  assert.throws(() => mediaSource(mediaInput('https://www.youtube.com/')), /Open a YouTube video first/);
  assert.throws(() => mediaSource(mediaInput('https://www.youtube.com/@channel')), /Open a YouTube video first/);
  const player = mediaInput('https://example.test/watch', { mediaUrl: 'https://cdn.test/master.m3u8', userAgent: 'Fixture' });
  assert.deepEqual(mediaSource(player), { target: player.mediaUrl, referer: player.url });
});

test('inspection projects engine metadata to selectable qualities', async () => {
  const script = fileURLToPath(new URL('../fixtures/fake-media.cjs', import.meta.url));
  const result = await inspectMedia('https://example.test/watch', { command: process.execPath, commandPrefix: [script] });
  assert.equal(result.title, 'Sample ｜ اردو');
  assert.deepEqual(result.qualities.map(choice => choice.value), ['best', 2160, 1080, 480]);
  assert.equal(Object.hasOwn(result, 'formats'), false);
});

test('media process reports title, bytes, and finished file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-media-'));
  const script = fileURLToPath(new URL('../fixtures/fake-media.cjs', import.meta.url));
  const progress = [];
  const titles = [];
  try {
    const output = await downloadMedia('https://example.test/watch/123', {
      root,
      signal: new AbortController().signal,
      command: process.execPath,
      commandPrefix: [script],
      onProgress: (received, total) => progress.push([received, total]),
      onTitle: title => titles.push(title)
    });
    assert.equal(output.name, 'sample ｜ اردو [fixture].mp4');
    assert.equal(output.size, 128);
    assert.deepEqual(progress, [[128, 128]]);
    assert.deepEqual(titles, ['Sample ｜ اردو\nFixture']);
    assert.equal((await readFile(join(root, output.name))).length, 128);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

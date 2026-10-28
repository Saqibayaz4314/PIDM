import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function runtimeResources({ resourcesPath = process.resourcesPath, defaultApp = process.defaultApp } = {}) {
  const packaged = Boolean(resourcesPath && !defaultApp);
  const root = packaged ? resourcesPath : fileURLToPath(new URL('../', import.meta.url));
  return {
    extractor: join(root, 'bin', 'yt-dlp.exe'),
    ffmpeg: join(root, 'bin', 'ffmpeg-9.0.2-essentials_build', 'bin'),
    extension: join(root, packaged ? 'browser-extension' : 'extension')
  };
}

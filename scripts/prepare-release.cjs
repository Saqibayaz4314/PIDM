const { accessSync, constants, copyFileSync } = require('node:fs');
const { join } = require('node:path');
const project = join(__dirname, '..');
copyFileSync(join(project, 'LICENSE'), join(project, 'distribution', 'PIDM-LICENSE.txt'));
const required = [
  'node_modules/electron/dist/electron.exe',
  'bin/yt-dlp.exe',
  'bin/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe',
  'bin/ffmpeg-9.0.2-essentials_build/bin/ffprobe.exe',
  'bin/ffmpeg-9.0.2-essentials_build/LICENSE',
  'extension/choose.html',
  'assets/pidm.ico',
  'assets/pidm-256.png',
  'distribution/START-HERE.txt',
  'distribution/THIRD-PARTY-NOTICES.txt'
];
for (const file of required) accessSync(join(project, file), constants.R_OK);
process.stdout.write('Installer resources verified.\n');

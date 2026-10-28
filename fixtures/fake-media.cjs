const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const args = process.argv.slice(2);
if (args.includes('--simulate')) {
  process.stdout.write(`PD_INFO:${JSON.stringify({ title: 'Sample ｜ اردو' })}\n`);
  process.stdout.write(`PD_FORMATS:${JSON.stringify([{ height: 480, vcodec: 'h264' }, { height: 1080, vcodec: 'h264' }, { height: 2160, vcodec: 'vp9' }, { height: 180, vcodec: 'none' }])}\n`);
  process.exit(0);
}
const root = args[args.indexOf('--paths') + 1];
const output = join(root, 'sample ｜ اردو [fixture].mp4');
writeFileSync(output, Buffer.alloc(128, 7));
process.stdout.write(`PD_TITLE:${JSON.stringify('Sample ｜ اردو\nFixture')}\n`);
process.stdout.write('PD_PROGRESS:128:128:NA\n');
const report = Buffer.from(`PD_FILE:${JSON.stringify(output)}\n`);
const split = report.indexOf(Buffer.from('｜')) + 1;
process.stdout.write(report.subarray(0, split));
setTimeout(() => process.stdout.write(report.subarray(split)), 20);

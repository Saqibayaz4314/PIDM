const { app, BrowserWindow } = require('electron');
const { readFile, writeFile, mkdir, copyFile } = require('node:fs/promises');
const { join } = require('node:path');
const project = join(__dirname, '..');
app.whenReady().then(async () => {
  const svg = await readFile(join(project, 'assets', 'pidm.svg'), 'utf8');
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await window.loadURL('data:text/html,<html><body></body></html>');
  const images = await window.webContents.executeJavaScript('(async () => { const image = new Image(); image.src = ' + JSON.stringify('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')) + '; await image.decode(); const output = {}; for (const size of [16,24,32,48,64,128,256,512]) { const canvas = document.createElement("canvas"); canvas.width = size; canvas.height = size; canvas.getContext("2d").drawImage(image,0,0,size,size); output[size] = canvas.toDataURL("image/png").split(",")[1]; } return output; })()');
  const icons = join(project, 'extension', 'icons');
  await mkdir(icons, { recursive: true });
  for (const [size, data] of Object.entries(images)) {
    await writeFile(join(project, 'assets', 'pidm-' + size + '.png'), Buffer.from(data, 'base64'));
    if ([16,32,48,128].includes(Number(size))) await writeFile(join(icons, 'pidm-' + size + '.png'), Buffer.from(data, 'base64'));
  }
  const sizes = [16,24,32,48,64,128,256];
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  const entries = [];
  sizes.forEach((size, index) => {
    const data = Buffer.from(images[size], 'base64');
    const position = 6 + index * 16;
    header[position] = size === 256 ? 0 : size;
    header[position + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, position + 4);
    header.writeUInt16LE(32, position + 6);
    header.writeUInt32LE(data.length, position + 8);
    header.writeUInt32LE(offset, position + 12);
    offset += data.length;
    entries.push(data);
  });
  await writeFile(join(project, 'assets', 'pidm.ico'), Buffer.concat([header, ...entries]));
  await copyFile(join(project, 'web', 'theme.js'), join(project, 'extension', 'theme.js'));
  await copyFile(join(project, 'web', 'icons.svg'), join(project, 'extension', 'icons.svg'));
  await copyFile(join(project, 'web', 'style.css'), join(project, 'extension', 'shared.css'));
  window.destroy();
  console.log('PIDM SVG, multi-size Windows ICO and browser icons generated.');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });

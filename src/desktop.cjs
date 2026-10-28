const { app, BrowserWindow, dialog, shell } = require('electron');
const { join } = require('node:path');

app.setPath('userData', join(app.getPath('appData'), 'personal-downloader'));
app.setName('PIDM');

let closeService;
let quitting = false;
let mainWindow;
app.setAppUserModelId('com.personaldownloader.desktop');
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
});

if (primary) app.whenReady().then(async () => {
  const { startServer } = await import('./server.js');
  const { runtimeResources } = await import('./resources.js');
  const running = await startServer({ onOpenExtension: async () => {
    const error = await shell.openPath(runtimeResources().extension);
    if (error) throw new Error(error);
  } });
  closeService = running.close;
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 820,
    minHeight: 620,
    title: 'PIDM',
    icon: join(__dirname, '../assets/pidm-256.png'),
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await window.loadURL(running.url);
}).catch(error => {
  console.error(error);
  dialog.showErrorBox('PIDM', error.code === 'EADDRINUSE' ? 'Another downloader is using the local connection. Close the other copy and open PIDM again.' : error.message);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (!closeService || quitting) return;
  event.preventDefault();
  quitting = true;
  void closeService().then(() => app.quit()).catch(error => {
    quitting = false;
    dialog.showErrorBox('PIDM', 'Could not save downloads before closing: ' + error.message);
  });
});

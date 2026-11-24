// Desktop shell scaffold (unbuilt, untested). Opens the hosted Scrxaper app in a window.
const { app, BrowserWindow, shell } = require('electron');
const URL_ = process.env.SCRXAPER_URL || 'https://your-scrxaper.example.com/app';
function create() {
  const win = new BrowserWindow({ width: 1280, height: 820, backgroundColor: '#0b0d10', webPreferences: { contextIsolation: true, sandbox: true } });
  win.loadURL(URL_);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}
app.whenReady().then(create);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

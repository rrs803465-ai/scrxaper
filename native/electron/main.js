// Scrxaper desktop (Windows, macOS, Linux). A native window around your hosted Scrxaper site, with a tray icon so calls
// and messages keep arriving when the window is closed, microphone/camera/screen-share permissions, and start-at-login.
const { app, BrowserWindow, Menu, Tray, shell, session, ipcMain, desktopCapturer, nativeImage, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const userFile = () => path.join(app.getPath('userData'), 'settings.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const bundled = readJson(path.join(__dirname, 'config.json')); // written at build time by the workflow: { "url": "https://your-site/app" }
const settings = () => ({ ...readJson(userFile()) });
const save = (patch) => { fs.mkdirSync(path.dirname(userFile()), { recursive: true }); fs.writeFileSync(userFile(), JSON.stringify({ ...settings(), ...patch })); };
const normalize = (u) => { try { const x = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`); x.pathname = '/app'; x.search = ''; x.hash = ''; return x.toString(); } catch { return null; } };
const targetUrl = () => normalize(process.env.SCRXAPER_URL || settings().url || bundled.url || '');

let win = null; let tray = null; let quitting = false;

if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  app.on('second-instance', () => show());
}

function show() { if (!win) return create(); if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function create() {
  const bounds = settings().bounds ?? { width: 1280, height: 820 };
  win = new BrowserWindow({ ...bounds, minWidth: 380, minHeight: 560, backgroundColor: '#0b0d10', autoHideMenuBar: true, title: 'Scrxaper', icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false } });
  const url = targetUrl();
  if (url) win.loadURL(url); else win.loadFile(path.join(__dirname, 'connect.html'));
  const origin = url ? new URL(url).origin : null;
  win.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/i.test(u)) shell.openExternal(u); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, u) => { // stay on your site (and Supabase for Google sign-in); everything else opens in the browser
    const ok = u.startsWith('file:') || (origin && u.startsWith(origin)) || /\/auth\/v1\/authorize/.test(u) || /accounts\.google\.com/.test(u) || /\.supabase\.co\//.test(u);
    if (!ok) { e.preventDefault(); if (/^https?:/i.test(u)) shell.openExternal(u); }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, failed, isMain) => { if (isMain && code !== -3) win.loadFile(path.join(__dirname, 'connect.html'), { query: { error: `${desc} (${failed})` } }); });
  const keep = () => { if (!win.isMaximized() && !win.isMinimized()) save({ bounds: win.getBounds() }); };
  win.on('resize', keep); win.on('move', keep);
  win.on('close', (e) => { if (!quitting && settings().closeToTray !== false) { e.preventDefault(); win.hide(); } }); // keep running for calls
  win.on('closed', () => { win = null; });
}

function buildTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 18, height: 18 });
  tray = new Tray(img); tray.setToolTip('Scrxaper');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Open Scrxaper', click: show },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--hidden'] }) },
    { label: 'Keep running when the window is closed', type: 'checkbox', checked: settings().closeToTray !== false, click: (i) => save({ closeToTray: i.checked }) },
    { label: 'Change server address', click: () => { save({ url: '' }); fs.rmSync(userFile(), { force: true }); if (win) win.loadFile(path.join(__dirname, 'connect.html')); else create(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu()); tray.on('click', show); tray.on('right-click', () => tray.setContextMenu(menu()));
}

app.whenReady().then(() => {
  // Calls need the microphone and camera; notifications for messages. Only your own site gets them.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'display-capture'].includes(permission)));
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => { // screen share: share the primary screen
    try { const sources = await desktopCapturer.getSources({ types: ['screen'] }); cb(sources[0] ? { video: sources[0] } : {}); } catch { cb({}); }
  });
  ipcMain.handle('scrx:set-url', (_e, raw) => { const u = normalize(String(raw ?? '')); if (!u) return { ok: false }; save({ url: u }); if (win) win.loadURL(u); return { ok: true, url: u }; });
  ipcMain.handle('scrx:info', () => ({ url: targetUrl(), platform: process.platform, version: app.getVersion() }));
  buildTray();
  if (!process.argv.includes('--hidden')) create();
  app.on('activate', () => show());
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* stay in the tray */ });

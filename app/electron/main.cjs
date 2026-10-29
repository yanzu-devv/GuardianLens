const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, session, powerMonitor, systemPreferences, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { WebSocket } = require('ws');

const origin = process.env.GUARDIAN_ORIGIN;
const token = process.env.GUARDIAN_OWNER_TOKEN;
if (!origin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || !/^[\w-]{43}$/.test(token || '')) throw new Error('Launch using npm run desktop.');
if (!app.requestSingleInstanceLock()) app.quit();
app.setName('GuardianLens');
const desktopData = path.resolve('data/desktop');
fs.mkdirSync(desktopData, { recursive: true, mode: 0o700 });
app.setPath('userData', desktopData);
app.setPath('sessionData', desktopData);
app.setPath('crashDumps', path.join(desktopData, 'crashes'));
let mainWindow, quickWindow, incidentWindow, tray, socket, retryTimer;
let quitting = false;
let lastIncidentId = null;
const preload = path.join(__dirname, 'preload.cjs');

function url(view) { return `${origin}/${view ? `?view=${view}` : ''}#token=${token}`; }
function protect(window) {
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    // Only the fixed first-aid source can leave the app; private links stay private.
    const source = new URL(target);
    if (['https://www.redcross.org', 'https://www.nice.org.uk', 'https://www.nhs.uk'].includes(source.origin)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== origin) event.preventDefault(); });
  window.webContents.on('render-process-gone', () => { void command({ type: 'interrupt', reason: 'Camera renderer stopped. Monitoring is interrupted; reopen the dashboard.' }); });
}
function windowOptions(width, height) {
  return { width, height, backgroundColor: '#080B09', show: false, title: 'GuardianLens',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, spellcheck: false } };
}
async function command(value) {
  try {
    const response = await fetch(`${origin}/api/command`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(2000) });
    if (!response.ok) console.error('Desktop state update was not accepted.');
  } catch { tray?.setToolTip('GuardianLens — connection interrupted. Monitoring unavailable.'); }
}
function showDashboard() { mainWindow?.show(); mainWindow?.focus(); }
function showQuick() {
  if (quickWindow.isVisible()) return quickWindow.hide();
  const bounds = tray.getBounds(), area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea;
  const x = Math.max(area.x + 8, Math.min(bounds.x + bounds.width / 2 - 190, area.x + area.width - 388));
  quickWindow.setPosition(Math.round(x), Math.round(Math.max(bounds.y + bounds.height + 5, area.y + 5)));
  quickWindow.show(); quickWindow.focus();
}
function watchState() {
  socket = new WebSocket(`${origin.replace('http:', 'ws:')}/ws`, ['guardianlens', `auth.${token}`], { origin });
  socket.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'snapshot') return;
      const state = message.snapshot;
      const healthy = state.monitoring.enabled && state.monitoring.camera === 'connected' && state.monitoring.poseReady && !state.monitoring.interruption;
      tray.setToolTip(`GuardianLens — ${healthy ? 'monitoring active' : state.monitoring.interruption || 'monitoring off'}`);
      if (state.incident?.status === 'check_in' && lastIncidentId !== state.incident.id) {
        lastIncidentId = state.incident.id;
        incidentWindow.show(); incidentWindow.focus();
      }
      if (!state.incident || ['cancelled', 'resolved'].includes(state.incident.status)) {
        incidentWindow.hide();
        lastIncidentId = null;
      }
    } catch { console.error('Unable to read desktop monitoring state.'); }
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    tray?.setToolTip('GuardianLens — connection interrupted. Monitoring unavailable.');
    if (!quitting) retryTimer = setTimeout(watchState, 2000);
  });
}

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({ ...windowOptions(1440, 960), minWidth: 1000, minHeight: 700 });
  quickWindow = new BrowserWindow({ ...windowOptions(380, 600), frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true });
  incidentWindow = new BrowserWindow({ ...windowOptions(760, 820), minWidth: 560, alwaysOnTop: true });
  for (const window of [mainWindow, quickWindow, incidentWindow]) {
    protect(window);
    window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  }
  quickWindow.on('blur', () => quickWindow.hide());
  mainWindow.once('ready-to-show', () => mainWindow.show());
  void mainWindow.loadURL(url());
  void quickWindow.loadURL(url('quick'));
  void incidentWindow.loadURL(url('checkin'));
  // A template icon is generated locally from one flat protective-lens symbol.
  const icon = nativeImage.createFromPath(path.join(__dirname, 'iconTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('GuardianLens — monitoring off');
  tray.on('click', showQuick);
  tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate([
    { label: 'Open GuardianLens', click: showDashboard },
    { label: 'Pause monitoring', click: () => void command({ type: 'monitoring', enabled: false }) },
    { type: 'separator' },
    { label: 'Quit GuardianLens — stops monitoring', click: () => app.quit() },
  ])));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'GuardianLens', submenu: [{ label: 'Open dashboard', click: showDashboard }, { type: 'separator' }, { role: 'quit', label: 'Quit GuardianLens — stops monitoring' }] },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
  const trusted = sender => [mainWindow, quickWindow, incidentWindow].some(w => w && !w.isDestroyed() && w.webContents === sender);
  ipcMain.on('guardian:dashboard', event => { if (trusted(event.sender)) { quickWindow.hide(); showDashboard(); } });
  ipcMain.on('guardian:quick', event => { if (trusted(event.sender)) showQuick(); });
  ipcMain.on('guardian:camera', (event, enabled) => { if (trusted(event.sender) && typeof enabled === 'boolean') mainWindow.webContents.send('guardian:camera-control', enabled); });
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    contents === mainWindow.webContents && requestingOrigin === origin && (permission === 'geolocation' || (permission === 'media' && details.mediaType === 'video')));
  session.defaultSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (contents === mainWindow.webContents && permission === 'geolocation' && details.requestingUrl?.startsWith(`${origin}/`)) return callback(true);
    if (contents !== mainWindow.webContents || permission !== 'media' || !details.requestingUrl?.startsWith(`${origin}/`) || !details.mediaTypes?.length || details.mediaTypes.some(type => type !== 'video')) return callback(false);
    if (process.platform === 'darwin') {
      try { return callback(await systemPreferences.askForMediaAccess('camera')); } catch { return callback(false); }
    }
    callback(true);
  });
  for (const event of ['suspend', 'lock-screen']) powerMonitor.on(event, () => {
    const reason = event === 'suspend' ? 'Mac entered sleep. Monitoring is interrupted.' : 'Mac screen locked. Monitoring paused; check the camera before resuming.';
    void command({ type: 'interrupt', reason });
    mainWindow.webContents.send('guardian:interruption', reason);
  });
  powerMonitor.on('resume', () => { void command({ type: 'interrupt', reason: 'Mac resumed from sleep. Check the camera and enable monitoring again.' }); });
  watchState();
});
app.on('second-instance', showDashboard);
app.on('activate', showDashboard);
app.on('window-all-closed', () => { /* Tray app remains alive until explicitly quit. */ });
app.on('before-quit', () => { quitting = true; clearTimeout(retryTimer); socket?.close(); void command({ type: 'interrupt', reason: 'GuardianLens quit. Monitoring stopped.' }); });

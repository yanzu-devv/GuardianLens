const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('guardianDesktop', {
  openDashboard: () => ipcRenderer.send('guardian:dashboard'),
  openQuickAccess: () => ipcRenderer.send('guardian:quick'),
  setCameraEnabled: enabled => ipcRenderer.send('guardian:camera', Boolean(enabled)),
  onCameraControl: handler => {
    const listener = (_event, enabled) => handler(Boolean(enabled));
    ipcRenderer.on('guardian:camera-control', listener);
    return () => ipcRenderer.removeListener('guardian:camera-control', listener);
  },
  onInterruption: handler => {
    const listener = (_event, reason) => handler(String(reason));
    ipcRenderer.on('guardian:interruption', listener);
    return () => ipcRenderer.removeListener('guardian:interruption', listener);
  },
});

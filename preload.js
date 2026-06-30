const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  log: (level, ...args) => ipcRenderer.send('log', level, ...args),
  getProxyPort: () => ipcRenderer.invoke('get-proxy-port'),
  checkFfmpeg: () => ipcRenderer.invoke('check-ffmpeg'),
  getStreamInfo: (url) => ipcRenderer.invoke('get-stream-info', url),
  openDevTools: () => ipcRenderer.send('open-devtools'),
  closeDevTools: () => ipcRenderer.send('close-devtools'),
  startFfmpegDownload: () => ipcRenderer.send('start-ffmpeg-download'),
  onFfmpegProgress: (callback) => ipcRenderer.on('ffmpeg-progress', (event, data) => callback(data)),
  onFfmpegError: (callback) => ipcRenderer.on('ffmpeg-error', (event, error) => callback(error)),
  onFfmpegReady: (callback) => ipcRenderer.on('ffmpeg-ready', () => callback()),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  
  // Downloads API
  startDownload: (args) => ipcRenderer.invoke('start-download', args),
  cancelDownload: (streamId) => ipcRenderer.invoke('cancel-download', streamId),
  checkDownloadExists: (streamId, title, customDir) => ipcRenderer.invoke('check-download-exists', streamId, title, customDir),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, data) => callback(data)),
  onDownloadComplete: (callback) => ipcRenderer.on('download-complete', (event, data) => callback(data)),
  
  // Auto-Updater API
  getVersion: () => ipcRenderer.invoke('get-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdaterEvent: (callback) => ipcRenderer.on('updater-event', (event, data) => callback(data)),

  removeDownloadListeners: () => {
    ipcRenderer.removeAllListeners('download-progress');
    ipcRenderer.removeAllListeners('download-complete');
  },
  
  // Discord API
  setDiscordActivity: (data) => ipcRenderer.send('set-discord-activity', data)
});

window.addEventListener('DOMContentLoaded', () => {
  console.log('Antigravity IPTV Electron Client Initialized');
});

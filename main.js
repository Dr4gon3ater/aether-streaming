const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

protocol.registerSchemesAsPrivileged([
  { scheme: 'aether-img', privileges: { bypassCSP: true, supportFetchAPI: true, corsEnabled: false, standard: true, secure: true } }
]);
const https = require('https');
const { spawn, exec, execFile } = require('child_process');
const http = require('http');

let proxyPort = 0;
let mainLogPath = '';

// Setup logger when app is ready
app.on('ready', () => {
  mainLogPath = path.join(app.getPath('userData'), 'aether.log');
  fs.writeFileSync(mainLogPath, `--- AETHER STREAMING LOG gestartet am ${new Date().toISOString()} ---\n`);
});

function writeLog(level, ...args) {
  if (!mainLogPath) return;
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}\n`;
  try {
    fs.appendFileSync(mainLogPath, line);
    console.log(line.trim()); // Also log to terminal
  } catch (e) {}
}

// 1. Start Local FFmpeg Transcoding Proxy Server
const proxyServer = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  
  if (reqUrl.pathname === '/subtitle') {
    const streamUrl = reqUrl.searchParams.get('url');
    const index = reqUrl.searchParams.get('index');
    if (!streamUrl || !index) return res.end('Missing params');

    let ffmpegPath = path.join(__dirname, 'bin', 'ffmpeg.exe');
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'text/vtt');

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '-i', streamUrl,
      '-map', `0:${index}`,
      '-f', 'webvtt',
      'pipe:1'
    ];

    const ffmpegProcess = spawn(ffmpegPath, args);
    ffmpegProcess.stdout.pipe(res);
    
    req.on('close', () => {
      ffmpegProcess.kill('SIGKILL');
    });
    return;
  }

  // YouTube embed proxy - serves a minimal HTML page with YouTube player
  // This gives the embed a proper http:// origin instead of file://
  if (reqUrl.pathname === '/youtube') {
    const videoId = reqUrl.searchParams.get('v');
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      res.statusCode = 400;
      return res.end('Invalid video ID');
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>*{margin:0;padding:0;overflow:hidden}body{background:#000}#player{width:100vw;height:100vh}</style>
</head><body>
<div id="player"></div>
<script src="https://www.youtube.com/iframe_api"></script>
<script>
var player;
function onYouTubeIframeAPIReady(){
  player=new YT.Player('player',{
    videoId:'${videoId}',
    playerVars:{
      autoplay:1, mute:1, controls:0, modestbranding:1, rel:0, showinfo:0, loop:1, playlist:'${videoId}',
      origin: window.location.origin
    },
    events:{
      onReady:function(e){e.target.playVideo();},
      onStateChange:function(e){if(e.data===1)window.parent.postMessage(JSON.stringify({aetherTrailerPlaying:true}),'*');},
      onError:function(e){window.parent.postMessage(JSON.stringify({aetherTrailerError:true,code:e.data}),'*');}
    }
  });
}
window.addEventListener('message',function(e){
  try{
    var d=JSON.parse(e.data);
    if(d.aetherMute===true&&player){player.mute();}
    if(d.aetherMute===false&&player){player.unMute();player.setVolume(50);}
    if(d.aetherDestroy===true&&player){player.destroy();}
  }catch(ex){}
});
</script>
</body></html>`);
    return;
  }

  if (reqUrl.pathname === '/proxy') {
    const streamUrl = reqUrl.searchParams.get('url');
    const startOffset = reqUrl.searchParams.get('start') || '0';
    const audioIndex = reqUrl.searchParams.get('audio');

    if (!streamUrl) {
      res.statusCode = 400;
      return res.end('Missing url');
    }

    let ffmpegPath = path.join(__dirname, 'bin', 'ffmpeg.exe');
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
    if (!fs.existsSync(ffmpegPath)) {
      res.statusCode = 500;
      return res.end('FFmpeg not found at ' + ffmpegPath);
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'video/mp4'); // Outputting Fragmented MP4

    // Transcode Audio to AAC, Copy Video
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-user_agent', 'VLC/3.0.0 LibVLC/3.0.0',
      '-analyzeduration', '1000000',  // Probe max 1 second
      '-probesize', '1000000',        // Probe max 1 MB
      '-fflags', '+nobuffer+flush_packets', // Do not buffer, flush instantly
      '-noaccurate_seek',
      '-ss', startOffset,
      '-i', streamUrl
    ];

    if (audioIndex) {
      args.push('-map', '0:v:0', '-map', `0:${audioIndex}`);
    } else {
      // Default: copy first video and first audio
      args.push('-map', '0:v:0', '-map', '0:a:0');
    }

    args.push(
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-af', 'aresample=async=1',
      '-copyts',
      '-start_at_zero',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1'
    );

    const ffmpegProcess = spawn(ffmpegPath, args);

    ffmpegProcess.stdout.pipe(res);

    writeLog('info', `--- NEW FFMPEG PROXY STREAM STARTED --- Url: ${streamUrl}`);

    ffmpegProcess.stderr.on('data', (data) => {
      writeLog('ffmpeg', data.toString());
    });

    res.on('close', () => {
      try {
        ffmpegProcess.kill('SIGKILL');
      } catch (e) {}
    });
  } else {
    res.statusCode = 404;
    res.end();
  }
});

proxyServer.listen(0, '127.0.0.1', () => {
  proxyPort = proxyServer.address().port;
  console.log('[FFmpeg Proxy] Listening on port', proxyPort);
});

// IPC Handler: Provide Proxy Port to Frontend
ipcMain.handle('get-proxy-port', () => proxyPort);

// IPC Handler: Check if FFmpeg exists
ipcMain.handle('check-ffmpeg', () => {
  let ffmpegPath = path.join(__dirname, 'bin', 'ffmpeg.exe');
  ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  return fs.existsSync(ffmpegPath);
});

// IPC Logger
ipcMain.on('log', (event, level, ...args) => {
  writeLog(level, ...args);
});

// IPC Handlers for DevTools
ipcMain.on('open-devtools', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.webContents.openDevTools();
    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
      const levels = ['DEBUG', 'INFO', 'WARNING', 'ERROR'];
      console.log(`[Renderer ${levels[level] || 'LOG'}] ${message} (${sourceId}:${line})`);
    });
  }
});

ipcMain.on('close-devtools', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.webContents.closeDevTools();
});

ipcMain.on('open-external', (event, url) => {
  require('electron').shell.openExternal(url);
});

// IPC Handler: Get stream info via ffprobe
ipcMain.handle('get-stream-info', (event, streamUrl) => {
  return new Promise((resolve, reject) => {
    const ffprobePath = path.join(__dirname, 'bin', 'ffprobe.exe');
    if (!fs.existsSync(ffprobePath)) return resolve({ streams: [] });

    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      streamUrl
    ];

    execFile(ffprobePath, args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
      if (error) {
        console.error('[ffprobe] error:', error);
        return resolve({ streams: [] });
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        resolve({ streams: [] });
      }
    });
  });
});

// --- Download Manager ---
const activeDownloads = {}; // streamId -> { process, filePath }

function parseFfmpegTime(timeStr) {
  const parts = timeStr.split(':');
  if (parts.length === 3) {
    return (parseFloat(parts[0]) * 3600) + (parseFloat(parts[1]) * 60) + parseFloat(parts[2]);
  }
  return 0;
}

ipcMain.handle('start-download', async (event, args) => {
  const { streamId, streamUrl, title, totalDurationSecs, customDir } = args;
  
  let ffmpegPath = path.join(__dirname, 'bin', 'ffmpeg.exe');
  ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  if (!fs.existsSync(ffmpegPath)) return { success: false, error: 'FFmpeg not found' };

  let downloadsDir = customDir;
  if (!downloadsDir) {
    downloadsDir = path.join(app.getPath('downloads'), 'AetherDownloads');
  }
  
  if (!fs.existsSync(downloadsDir)) {
    try {
      fs.mkdirSync(downloadsDir, { recursive: true });
    } catch(e) {
      return { success: false, error: 'Konnte Download-Verzeichnis nicht erstellen.' };
    }
  }

  const safeTitle = title.replace(/[^a-z0-9A-ZäöüÄÖÜß ]/g, '').trim();
  const filePath = path.join(downloadsDir, `${safeTitle}_${streamId}.mp4`);

  if (fs.existsSync(filePath)) {
    // Already downloaded or partially downloaded
    return { success: false, error: 'File already exists', filePath };
  }

  const ffmpegArgs = [
    '-y',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    '-i', streamUrl,
    '-c', 'copy',
    filePath
  ];

  const child = require('child_process').spawn(ffmpegPath, ffmpegArgs);
  activeDownloads[streamId] = { process: child, filePath };

  child.stderr.on('data', (data) => {
    const output = data.toString();
    const timeMatch = output.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
    if (timeMatch && totalDurationSecs > 0) {
       const currentTime = parseFfmpegTime(timeMatch[1]);
       const percent = Math.min(100, Math.max(0, (currentTime / totalDurationSecs) * 100));
       event.sender.send('download-progress', { streamId, percent, currentTime, totalDurationSecs });
    }
  });

  child.on('close', (code) => {
    delete activeDownloads[streamId];
    event.sender.send('download-complete', { streamId, filePath, success: code === 0 });
  });

  return { success: true, filePath };
});

ipcMain.handle('cancel-download', (event, streamId) => {
  const dl = activeDownloads[streamId];
  if (dl && dl.process) {
    dl.process.kill('SIGKILL');
    if (fs.existsSync(dl.filePath)) {
       try { fs.unlinkSync(dl.filePath); } catch(e) {}
    }
    delete activeDownloads[streamId];
    return true;
  }
  return false;
});

ipcMain.handle('check-download-exists', (event, streamId, title, customDir) => {
  let downloadsDir = customDir;
  if (!downloadsDir) {
    downloadsDir = path.join(app.getPath('downloads'), 'AetherDownloads');
  }
  const safeTitle = title.replace(/[^a-z0-9A-ZäöüÄÖÜß ]/g, '').trim();
  const filePath = path.join(downloadsDir, `${safeTitle}_${streamId}.mp4`);
  return fs.existsSync(filePath) ? filePath : null;
});

ipcMain.handle('select-directory', async (event) => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  if (result.canceled) {
    return null;
  } else {
    return result.filePaths[0];
  }
});

const SimpleDiscordRPC = require('./discord-rpc.js');
let discordRPC = null;

ipcMain.on('set-discord-activity', (event, { clientId, details, state, endTimestamp }) => {
  if (!discordRPC && clientId) {
    discordRPC = new SimpleDiscordRPC(clientId);
    discordRPC.connect().catch(e => console.error("Discord RPC Connect Error:", e));
  }
  if (discordRPC) {
    if (details) {
      discordRPC.setActivity(details, state, endTimestamp);
    } else {
      discordRPC.clearActivity();
    }
  }
});

// Window state persistence
const windowStatePath = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    if (fs.existsSync(windowStatePath)) {
      return JSON.parse(fs.readFileSync(windowStatePath, 'utf8'));
    }
  } catch (e) {}
  return null;
}

function saveWindowState(win) {
  try {
    const isMaximized = win.isMaximized();
    // Save the "normal" bounds (not maximized bounds) so we can restore properly
    const bounds = isMaximized ? (win._lastNormalBounds || win.getBounds()) : win.getBounds();
    const state = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: isMaximized
    };
    fs.writeFileSync(windowStatePath, JSON.stringify(state));
  } catch (e) {}
}

function createWindow() {
  const savedState = loadWindowState();
  
  const windowOptions = {
    width: (savedState && savedState.width) || 1280,
    height: (savedState && savedState.height) || 720,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js')
    },
    backgroundColor: '#141414',
    title: 'Aether Streaming',
    icon: path.join(__dirname, 'assets', 'logo.ico')
  };

  // Restore position if we have saved state
  if (savedState && savedState.x !== undefined && savedState.y !== undefined) {
    // Verify the saved position is still on a valid screen
    const { screen } = require('electron');
    const displays = screen.getAllDisplays();
    const onScreen = displays.some(d => {
      const b = d.bounds;
      return savedState.x >= b.x - 50 && savedState.x < b.x + b.width + 50 &&
             savedState.y >= b.y - 50 && savedState.y < b.y + b.height + 50;
    });
    if (onScreen) {
      windowOptions.x = savedState.x;
      windowOptions.y = savedState.y;
    }
  }

  const mainWindow = new BrowserWindow(windowOptions);

  // Track normal (non-maximized) bounds
  mainWindow._lastNormalBounds = mainWindow.getBounds();
  mainWindow.on('resize', () => {
    if (!mainWindow.isMaximized()) {
      mainWindow._lastNormalBounds = mainWindow.getBounds();
    }
  });
  mainWindow.on('move', () => {
    if (!mainWindow.isMaximized()) {
      mainWindow._lastNormalBounds = mainWindow.getBounds();
    }
  });

  // Restore maximized state
  if (savedState && savedState.isMaximized) {
    mainWindow.maximize();
  }

  // Save state on close
  mainWindow.on('close', () => {
    saveWindowState(mainWindow);
  });

  // Remove the menu bar (hides File, Edit, View etc. for standalone app look)
  mainWindow.removeMenu();

  // Clear any accidentially registered Service Workers that block file:// protocol
  const { session } = require('electron');
  session.defaultSession.clearStorageData({ storages: ['serviceworkers'] }).then(() => {
    // Load the local index.html file
    mainWindow.loadFile('index.html');
  });
}

// SPOOF USER AGENT GLOBALLY TO PREVENT IPTV PROVIDER BLOCKS (Removes "Electron" string)
app.userAgentFallback = 'VLC/3.0.0 LibVLC/3.0.0';

// This method will be called when Electron has finished initialization
app.whenReady().then(() => {
  const imageCacheDir = path.join(app.getPath('userData'), 'image-cache');
  if (!fs.existsSync(imageCacheDir)) fs.mkdirSync(imageCacheDir, { recursive: true });

  protocol.handle('aether-img', async (request) => {
    try {
      const urlObj = new URL(request.url);
      const targetUrl = urlObj.searchParams.get('url');
      if (!targetUrl) return new Response('Missing URL', { status: 400 });

      const hash = crypto.createHash('md5').update(targetUrl).digest('hex');
      let ext = '.jpg';
      try { ext = path.extname(new URL(targetUrl).pathname) || '.jpg'; } catch(e) {}
      const cachedPath = path.join(imageCacheDir, hash + ext);

      if (fs.existsSync(cachedPath)) {
        return net.fetch('file:///' + cachedPath.replace(/\\/g, '/'));
      } else {
        const response = await net.fetch(targetUrl);
        if (!response.ok) return response;
        const buffer = await response.arrayBuffer();
        fs.writeFile(cachedPath, Buffer.from(buffer), (err) => {
          if (err) console.error("Cache write error:", err);
        });
        return new Response(buffer, {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText
        });
      }
    } catch(e) {
      console.error("Image cache fetch error:", e);
      return new Response('Error', { status: 500 });
    }
  });

  createWindow();

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// ==========================================
// Auto-Updater Config
// ==========================================
const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload = false; // Wir wollen den User erst fragen / UI anzeigen
autoUpdater.autoInstallOnAppQuit = true;

// Events an das Frontend schicken
function sendStatusToWindow(event, data) {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    win.webContents.send('updater-event', { event, data });
  }
}

autoUpdater.on('checking-for-update', () => sendStatusToWindow('checking'));
autoUpdater.on('update-available', (info) => sendStatusToWindow('available', info));
autoUpdater.on('update-not-available', (info) => sendStatusToWindow('not-available', info));
autoUpdater.on('error', (err) => sendStatusToWindow('error', err.toString()));
autoUpdater.on('download-progress', (progressObj) => sendStatusToWindow('progress', progressObj));
autoUpdater.on('update-downloaded', (info) => sendStatusToWindow('downloaded', info));

// Vom Frontend ausgelöst
ipcMain.handle('get-version', () => app.getVersion());

ipcMain.handle('check-for-updates', () => {
  return autoUpdater.checkForUpdates();
});

ipcMain.handle('download-update', () => {
  return autoUpdater.downloadUpdate();
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

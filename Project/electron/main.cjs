const { app, BrowserWindow, dialog, session } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.vrm': 'application/octet-stream',
  '.binarypb': 'application/octet-stream',
};

let mainWindow = null;
let localServer = null;
let appOrigin = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(startDesktopApp).catch((error) => {
    dialog.showErrorBox('VTuber Studio Pro', `Не удалось запустить приложение.\n\n${error.message}`);
    app.quit();
  });
}

function isInsideDist(filePath) {
  const relative = path.relative(DIST_DIR, filePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveRequestPath(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, appOrigin).pathname);
  } catch {
    return null;
  }

  const candidate = path.resolve(DIST_DIR, `.${pathname}`);
  if (!isInsideDist(candidate)) return null;
  return candidate;
}

function createStaticServer() {
  return http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    let filePath = resolveRequestPath(request.url || '/');
    if (!filePath) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    try {
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(DIST_DIR, 'index.html');
      }

      const stat = fs.statSync(filePath);
      const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      const headers = {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Accept-Ranges': 'bytes',
      };

      const rangeHeader = request.headers.range;
      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        if (!match) {
          response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
          return;
        }
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        if (start > end || start >= stat.size) {
          response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
          return;
        }
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
        headers['Content-Length'] = end - start + 1;
        response.writeHead(206, headers);
        if (request.method === 'HEAD') response.end();
        else fs.createReadStream(filePath, { start, end }).pipe(response);
        return;
      }

      headers['Content-Length'] = stat.size;
      response.writeHead(200, headers);
      if (request.method === 'HEAD') response.end();
      else fs.createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(500).end('Internal Server Error');
    }
  });
}

function listenOnLoopback(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

async function startDesktopApp() {
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    throw new Error('Не найдена встроенная веб-сборка приложения.');
  }

  app.setAppUserModelId('com.vtuberstudio.pro');
  localServer = createStaticServer();
  const port = await listenOnLoopback(localServer);
  appOrigin = `http://127.0.0.1:${port}`;

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    let requestOrigin = '';
    try {
      requestOrigin = new URL(webContents.getURL()).origin;
    } catch {}

    const isOurWindow = mainWindow && webContents === mainWindow.webContents;
    if (!isOurWindow || requestOrigin !== appOrigin || permission !== 'media') {
      callback(false);
      return;
    }

    const mediaTypes = details.mediaTypes || [];
    callback(mediaTypes.length > 0 && mediaTypes.every((type) => type === 'audio' || type === 'video'));
  });

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0e1017',
    autoHideMenuBar: true,
    title: 'VTuber Studio Pro',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    let targetOrigin = '';
    try {
      targetOrigin = new URL(targetUrl).origin;
    } catch {}
    if (targetOrigin !== appOrigin) event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(`${appOrigin}/`);
}

app.on('before-quit', () => {
  if (localServer) localServer.close();
});

app.on('window-all-closed', () => app.quit());

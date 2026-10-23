'use strict';
const {app, BrowserWindow, ipcMain} = require('electron');
const {build} = require('esbuild');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const {execFile} = require('node:child_process'), {promisify} = require('node:util');
const run = promisify(execFile), base = path.resolve(__dirname, '..');
app.on('window-all-closed', () => {});
(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'reva-preview-invalidation-'));
  let window, server;
  try {
    app.setPath('userData', path.join(temporary, 'profile'));
    const source = path.join(temporary, 'source.mp4');
    const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(require('node:fs').existsSync);
    if (!ffmpeg) throw new Error('FFmpeg is required for the actual preview regression');
    await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', source]);
    const bundle = await build({entryPoints: [path.join(__dirname, 'preview-invalidation.browser-entry.js')], bundle: true, platform: 'browser', format: 'iife', globalName: 'PreviewQA', write: false, loader: {'.css': 'empty'}, define: {'import.meta.env.BASE_URL': '"/"'}});
    const preload = path.join(temporary, 'preload.cjs');
    await fs.writeFile(preload, "const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('previewHost',{resize:(w,h)=>ipcRenderer.invoke('preview-test:resize',w,h),cursorRequested:()=>ipcRenderer.sendSync('preview-test:cursor')});");
    await app.whenReady();
    let cursorRequested = false;
    ipcMain.handle('preview-test:resize', (event, width, height) => {
      if (event.sender !== window.webContents) throw new Error('Foreign preview test sender');
      window.setContentSize(width, height);
    });
    ipcMain.on('preview-test:cursor', event => { event.returnValue = event.sender === window.webContents && cursorRequested; });
    window = new BrowserWindow({show: false, width: 1100, height: 850, webPreferences: {preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false}});
    server = http.createServer(async (request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Owned preview regression</title><div id="root"></div>'); return; }
        const file = pathname === '/source.mp4' ? source : path.join(base, 'public', pathname);
        if (file !== source && !file.startsWith(path.join(base, 'public') + '/')) { response.writeHead(403); response.end(); return; }
        const bytes = await fs.readFile(file);
        response.setHeader('Content-Type', file.endsWith('.mp4') ? 'video/mp4' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream');
        if (/^\/(?:reference-)?cursors\//.test(pathname)) { cursorRequested = true; await new Promise(resolve => setTimeout(resolve, 700)); }
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
        if (range) { const start = +range[1], end = range[2] ? Math.min(+range[2], bytes.length - 1) : bytes.length - 1; response.writeHead(206, {'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes'}); response.end(bytes.subarray(start, end + 1)); }
        else response.end(bytes);
      } catch { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await window.loadURL('http://127.0.0.1:' + server.address().port + '/');
    const css = (await fs.readdir(path.join(base, 'src'))).filter(file => file.endsWith('.css'));
    await window.webContents.insertCSS((await Promise.all(css.map(file => fs.readFile(path.join(base, 'src', file), 'utf8')))).join('\n'));
    const result = await window.webContents.executeJavaScript(bundle.outputFiles[0].text + '\nPreviewQA.verifyPreviewInvalidation()');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    ipcMain.removeHandler('preview-test:resize'); ipcMain.removeAllListeners('preview-test:cursor');
    window?.destroy(); if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, {recursive: true, force: true}); app.quit();
  }
})().catch(error => { console.error(error); app.exit(1); });

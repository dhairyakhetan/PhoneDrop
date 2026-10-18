#!/usr/bin/env node
/*
  PhoneDrop - send photos, videos & files from your computer to your phone over Wi-Fi.

  node server.js           open http://localhost:3000 (phone link is printed below)
  node server.js --app     same, in its own window; quits when the window is closed
  node --watch server.js   restarts on edits (the page in public/ reloads on refresh, no restart needed)
  KEEP=1                   keep shared files between restarts (Windows: set KEEP=1 && node server.js)
  PORT=4000                use another port (HTTPS uses PORT + 443)

  No npm install needed to run. See CLAUDE.md for how everything fits together.
*/

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Running as PhoneDrop.exe (Node bundled in)? Then always act like an app and keep data in the user's folder.
let IS_EXE = false;
try { IS_EXE = require('node:sea').isSea(); } catch (e) {}
const APP = IS_EXE || process.argv.includes('--app');
const BASE = IS_EXE ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'PhoneDrop') : __dirname;
if (IS_EXE) {
  fs.mkdirSync(BASE, { recursive: true });
  process.on('uncaughtException', (e) => {
    try { fs.appendFileSync(path.join(BASE, 'error-log.txt'), new Date().toISOString() + '  ' + (e && e.stack || e) + '\n'); } catch (x) {}
    process.exit(1);
  });
}

// ---------- bundled files ----------
// Read from the repo folder, or from inside PhoneDrop.exe (scripts/build.mjs embeds them as SEA assets
// under these same relative paths). In dev the page is re-read on every request, so edits show on refresh.
function asset(rel, encoding) {
  if (IS_EXE) {
    const buf = Buffer.from(require('node:sea').getAsset(rel));
    return encoding ? buf.toString(encoding) : buf;
  }
  return fs.readFileSync(path.join(__dirname, rel), encoding);
}
const VERSION = JSON.parse(asset('package.json', 'utf8')).version;
let pageCache = null;
function page() { return IS_EXE ? (pageCache = pageCache || asset('public/index.html', 'utf8')) : asset('public/index.html', 'utf8'); }
const ICON_FILES = {
  '/icon.png': asset('public/icon.png'),
  '/favicon.png': asset('public/favicon.png'),
  '/apple-touch-icon.png': asset('public/apple-touch-icon.png'),
};

const HTTP_PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = HTTP_PORT + 443; // 3443 by default
const DIR = path.join(BASE, 'shared');
const THUMBS = path.join(DIR, '.thumbs');
const CERT_DIR = path.join(BASE, '.certs');
const HOST = os.hostname();

// ---------- start fresh (unless KEEP=1) — runs only once we know we're the only copy running ----------
fs.mkdirSync(THUMBS, { recursive: true });
function clearOld() {
  if (process.env.KEEP) return;
  let n = 0;
  for (const name of fs.readdirSync(DIR)) {
    try { fs.rmSync(path.join(DIR, name), { recursive: true, force: true }); if (name[0] !== '.') n++; } catch (e) {}
  }
  fs.mkdirSync(THUMBS, { recursive: true });
  if (n) console.log('  Cleared ' + n + ' old file' + (n === 1 ? '' : 's') + ' (start with KEEP=1 to keep them)\n');
}

// ---------- helpers ----------
function lanIP() {
  const c = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) c.push(i.address);
  return c.find((a) => a.startsWith('192.168.')) || c.find((a) => a.startsWith('10.')) ||
    c.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a)) || c[0] || 'localhost';
}
const IP = lanIP();
const HTTP_URL = 'http://' + IP + ':' + HTTP_PORT;
const HTTPS_URL = 'https://' + IP + ':' + HTTPS_PORT;
let httpsUp = false;

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  tif: 'image/tiff', tiff: 'image/tiff', dng: 'image/x-adobe-dng',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac',
  pdf: 'application/pdf', txt: 'text/plain', zip: 'application/zip', json: 'application/json',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const mimeOf = (n) => MIME[path.extname(n).slice(1).toLowerCase()] || 'application/octet-stream';

function safeName(n) {
  n = path.basename(String(n || 'file')).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/^\.+/, '').trim();
  return n.slice(0, 200) || 'file';
}
function uniqueName(n) {
  const ext = path.extname(n), base = path.basename(n, ext);
  let out = n, i = 1;
  while (fs.existsSync(path.join(DIR, out))) out = base + ' (' + i++ + ')' + ext;
  return out;
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const pendingThumb = new Set();
function listFiles() {
  const out = [];
  for (const name of fs.readdirSync(DIR)) {
    if (name[0] === '.' || pendingThumb.has(name)) continue;
    let s;
    try { s = fs.statSync(path.join(DIR, name)); } catch (e) { continue; }
    if (!s.isFile()) continue;
    out.push({
      name, size: s.size, type: mimeOf(name), mtime: Math.round(s.mtimeMs),
      thumb: fs.existsSync(path.join(THUMBS, name + '.jpg')),
      saved: savedBy.has(name) ? savedBy.get(name).size : 0,
      dur: metaOf(name).dur || 0,
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
}
const metaCache = new Map();
function metaOf(name) {
  if (metaCache.has(name)) return metaCache.get(name);
  let m = {};
  try { m = JSON.parse(fs.readFileSync(path.join(THUMBS, name + '.json'), 'utf8')) || {}; } catch (e) {}
  metaCache.set(name, m);
  return m;
}
function forget(name) {
  savedBy.delete(name); metaCache.delete(name);
  for (const ext of ['.jpg', '.json']) { try { fs.unlinkSync(path.join(THUMBS, name + ext)); } catch (e) {} }
}
const BIG_BUF = { highWaterMark: 1 << 20 }; // 1 MB chunks: much faster for big videos
function sendFile(req, res, file, type, extra) {
  let size;
  try { size = fs.statSync(file).size; } catch (e) { return json(res, 404, { error: 'not found' }); }
  const headers = Object.assign({ 'Content-Type': type, 'Accept-Ranges': 'bytes' }, extra);
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? parseInt(m[1], 10) : Math.max(0, size - parseInt(m[2], 10));
    const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
    if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
    res.writeHead(206, Object.assign(headers, { 'Content-Range': 'bytes ' + start + '-' + end + '/' + size, 'Content-Length': end - start + 1 }));
    return fs.createReadStream(file, { start, end, highWaterMark: 1 << 20 }).pipe(res);
  }
  res.writeHead(200, Object.assign(headers, { 'Content-Length': size }));
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, BIG_BUF).pipe(res);
}

// ---------- live updates (Server-Sent Events) ----------
const clients = new Set();
const savedBy = new Map(); // file name -> Set of phone ids that saved it
const devices = new Map(); // phone id -> { id, name, conns, gone }
function sendAll(ev, data) { const m = 'event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n'; for (const c of clients) c.write(m); }
function devList() { return [...devices.values()].filter((d) => d.conns > 0 || d.lingering).map((d) => ({ id: d.id, name: d.name })); }
function readJSON(req, cb) { let b = ''; req.on('data', (c) => { if (b.length < 1e6) b += c; }); req.on('end', () => { try { cb(JSON.parse(b)); } catch (e) { cb(null); } }); }
let bumpTimer = null;
function bump() {
  clearTimeout(bumpTimer);
  bumpTimer = setTimeout(() => { for (const c of clients) c.write('data: change\n\n'); }, 60);
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);
try { fs.watch(DIR, (ev, fn) => { if (!fn || String(fn)[0] !== '.') bump(); }); } catch (e) {}

// ---------- QR code (rendered here so it works without internet) ----------
// vendor/qrcode.js is qrcode-generator 1.4.4 (MIT, Kazuhiko Arase), loaded without require() so it also works in the exe
function loadQR() {
  const module = { exports: {} };
  new Function('module', 'exports', 'define', asset('vendor/qrcode.js', 'utf8'))(module, module.exports, undefined);
  return module.exports;
}
const qrcode = loadQR();
function qrSVG(text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), pad = 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + (c + pad) + ' ' + (r + pad) + 'h1v1h-1z';
  const s = n + pad * 2;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + s + ' ' + s + '" shape-rendering="crispEdges">' +
    '<rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="' + d + '"/></svg>';
}

// ---------- request handler ----------
function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const q = (k) => url.searchParams.get(k);

  if (req.method === 'GET' && p === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(page());
  }
  if (req.method === 'GET' && ICON_FILES[p]) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return res.end(ICON_FILES[p]);
  }
  if (req.method === 'GET' && p === '/api/info') {
    return json(res, 200, { host: HOST, ip: IP, http: HTTP_URL, https: httpsUp ? HTTPS_URL : null, app: APP, version: VERSION });
  }
  if (req.method === 'GET' && p === '/api/files') return json(res, 200, listFiles());
  if (req.method === 'POST' && p === '/api/saved') {
    return readJSON(req, (b) => {
      if (!b || !Array.isArray(b.files)) return json(res, 400, { error: 'bad request' });
      const id = String(b.id || 'phone').slice(0, 40);
      let n = 0;
      for (const f of b.files) {
        const name = safeName(f);
        if (!fs.existsSync(path.join(DIR, name))) continue;
        if (!savedBy.has(name)) savedBy.set(name, new Set());
        savedBy.get(name).add(id); n++;
      }
      json(res, 200, { ok: true });
      if (n) { sendAll('saved', { name: String(b.name || 'Phone').slice(0, 40), count: n, media: !!b.media }); bump(); }
    });
  }

  if (req.method === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    const local = isLocal(req);
    const id = String(q('id') || '').slice(0, 40), dname = String(q('name') || 'Phone').slice(0, 40);
    if (!local && id) {
      let d = devices.get(id);
      if (!d) { d = { id, name: dname, conns: 0, gone: null }; devices.set(id, d); }
      clearTimeout(d.gone);
      const fresh = d.conns <= 0 && !d.lingering;
      d.conns++; d.lingering = false;
      if (fresh) sendAll('devices', devList());
      req.on('close', () => {
        d.conns--;
        if (d.conns <= 0) {
          // phones drop the connection briefly when the screen locks or the page reloads: wait before saying they left
          d.lingering = true; d.conns = 0;
          d.gone = setTimeout(() => { d.lingering = false; sendAll('devices', devList()); }, 8000);
        }
      });
    }
    res.write('event: devices\ndata: ' + JSON.stringify(devList()) + '\n\n');
    if (local) { localClients++; sawLocal = true; }
    req.on('close', () => { clients.delete(res); if (local) { localClients--; maybeQuit(); } });
    return;
  }
  if (req.method === 'GET' && p === '/qr.svg') {
    try {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      return res.end(qrSVG(q('u') || HTTP_URL));
    } catch (e) { return json(res, 500, { error: 'qr failed' }); }
  }

  // upload: streamed to a hidden temp file, renamed when complete (no half-files ever show up)
  if (req.method === 'POST' && p === '/upload') {
    const name = safeName(q('name'));
    const tmp = path.join(DIR, '.up-' + crypto.randomBytes(6).toString('hex'));
    const out = fs.createWriteStream(tmp, BIG_BUF);
    let failed = false;
    const fail = () => { if (failed) return; failed = true; out.destroy(); fs.rm(tmp, { force: true }, () => {}); };
    req.on('close', () => { if (!req.complete) fail(); });
    out.on('error', (e) => {
      const full = e && e.code === 'ENOSPC';
      fail();
      if (!res.headersSent) json(res, full ? 507 : 500, { error: full ? 'disk full' : 'write failed' });
      req.unpipe(out); req.resume();
    });
    out.on('finish', () => {
      if (failed) return;
      const final = uniqueName(name);
      try { fs.renameSync(tmp, path.join(DIR, final)); } catch (e) { fail(); return json(res, 500, { error: 'save failed' }); }
      // when a thumbnail is on its way, hide the file until it arrives so the tile appears once, fully drawn
      if (q('thumb')) { pendingThumb.add(final); setTimeout(() => { pendingThumb.delete(final); bump(); }, 5000); }
      json(res, 200, { name: final });
      bump();
    });
    req.pipe(out);
    return;
  }
  if (req.method === 'POST' && p === '/thumb') {
    const name = safeName(q('name'));
    if (!fs.existsSync(path.join(DIR, name))) { req.resume(); return json(res, 404, { error: 'no such file' }); }
    const chunks = []; let len = 0;
    req.on('data', (c) => { len += c.length; if (len <= 3 * 1048576) chunks.push(c); });
    req.on('end', () => {
      if (len > 3 * 1048576) return json(res, 413, { error: 'too big' });
      const dur = parseFloat(q('dur'));
      if (dur > 0) { const m = { dur }; metaCache.set(name, m); try { fs.writeFileSync(path.join(THUMBS, name + '.json'), JSON.stringify(m)); } catch (e) {} }
      const done = () => { pendingThumb.delete(name); json(res, 200, { ok: true }); bump(); };
      if (len) fs.writeFile(path.join(THUMBS, name + '.jpg'), Buffer.concat(chunks), done); else done();
    });
    return;
  }
  if (req.method === 'DELETE' && p === '/api/files') {
    for (const f of listFiles()) {
      try { fs.unlinkSync(path.join(DIR, f.name)); } catch (e) {}
      forget(f.name);
    }
    savedBy.clear();
    bump();
    return json(res, 200, { ok: true });
  }
  if (p.startsWith('/thumbs/')) {
    const name = safeName(decodeURIComponent(p.slice(8)));
    return sendFile(req, res, path.join(THUMBS, name + '.jpg'), 'image/jpeg', { 'Cache-Control': 'public, max-age=31536000, immutable' });
  }
  if (p.startsWith('/files/')) {
    const name = safeName(decodeURIComponent(p.slice(7)));
    const file = path.join(DIR, name);
    if (req.method === 'DELETE') {
      try { fs.unlinkSync(file); } catch (e) {}
      forget(name);
      bump();
      return json(res, 200, { ok: true });
    }
    return sendFile(req, res, file, mimeOf(name), {
      'Cache-Control': q('v') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Content-Disposition': (q('dl') ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(name),
    });
  }
  json(res, 404, { error: 'not found' });
}

// ---------- self-signed HTTPS certificate (pure Node — no openssl needed) ----------
// iPhones only allow "Save to Photos" from a secure (https) page.
function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  let len;
  if (body.length < 128) len = Buffer.from([body.length]);
  else { const b = []; let n = body.length; while (n > 0) { b.unshift(n & 255); n >>= 8; } len = Buffer.from([0x80 | b.length, ...b]); }
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
function oid(str) {
  const p = str.split('.').map(Number), out = [p[0] * 40 + p[1]];
  for (const v of p.slice(2)) { const t = [v & 127]; let x = v >> 7; while (x > 0) { t.unshift((x & 127) | 128); x >>= 7; } out.push(...t); }
  return der(0x06, Buffer.from(out));
}
function utc(d) {
  const i = d.toISOString();
  return i.slice(2, 4) + i.slice(5, 7) + i.slice(8, 10) + i.slice(11, 13) + i.slice(14, 16) + i.slice(17, 19) + 'Z';
}
function pem(label, buf) {
  return '-----BEGIN ' + label + '-----\n' + buf.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END ' + label + '-----\n';
}
function makeSelfSigned(ip) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sigAlg = der(0x30, oid('1.2.840.113549.1.1.11'), der(0x05));
  const name = der(0x30, der(0x31, der(0x30, oid('2.5.4.3'), der(0x0c, Buffer.from('PhoneDrop')))));
  const now = Date.now();
  const ipb = (x) => Buffer.from(x.split('.').map(Number));
  const names = [der(0x82, Buffer.from('localhost')), der(0x87, ipb('127.0.0.1'))];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '127.0.0.1') names.push(der(0x87, ipb(ip)));
  const ext = (o, v, crit) => der(0x30, oid(o), ...(crit ? [der(0x01, Buffer.from([255]))] : []), der(0x04, v));
  const exts = der(0xa3, der(0x30,
    ext('2.5.29.19', der(0x30), true),
    ext('2.5.29.37', der(0x30, oid('1.3.6.1.5.5.7.3.1'))),
    ext('2.5.29.17', der(0x30, ...names))));
  const serial = crypto.randomBytes(16); serial[0] = (serial[0] & 0x3f) | 0x01;
  const tbs = der(0x30,
    der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), sigAlg, name,
    der(0x30, der(0x17, Buffer.from(utc(new Date(now - 86400000)))), der(0x17, Buffer.from(utc(new Date(now + 365 * 86400000))))),
    name, publicKey.export({ type: 'spki', format: 'der' }), exts);
  const sig = crypto.sign('sha256', tbs, privateKey);
  const certDer = der(0x30, tbs, sigAlg, der(0x03, Buffer.concat([Buffer.from([0]), sig])));
  return { cert: pem('CERTIFICATE', certDer), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

// ---------- app mode: own window, quit when it's closed ----------
let localClients = 0, sawLocal = false, quitTimer = null;
function isLocal(req) { const a = req.socket.remoteAddress || ''; return a === '::1' || a === '127.0.0.1' || a === '::ffff:127.0.0.1'; }
function maybeQuit() {
  if (!APP || !sawLocal) return;
  clearTimeout(quitTimer);
  quitTimer = setTimeout(() => { if (localClients <= 0) { console.log('  Window closed. Bye!'); process.exit(0); } }, 6000);
}
function openWindow() {
  const url = 'http://localhost:' + HTTP_PORT;
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const browsers = process.platform === 'win32' ? [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  const exe = browsers.find((b) => { try { return fs.existsSync(b); } catch (e) { return false; } });
  const run = (cmd, args, extra) => {
    try {
      const c = spawn(cmd, args, Object.assign({ detached: true, stdio: 'ignore', windowsHide: true }, extra));
      c.on('error', () => console.log('  Open ' + url + ' in your browser.'));
      c.unref();
    } catch (e) { console.log('  Open ' + url + ' in your browser.'); }
  };
  if (exe) run(exe, ['--app=' + url, '--window-size=1220,880'], { windowsHide: false });
  else if (process.platform === 'win32') run('cmd', ['/c', 'start', '', url]);
  else run(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

// ---------- start ----------
function portBusy(port) {
  if (APP) { openWindow(); setTimeout(() => process.exit(0), 300); return; } // already running: just show it
  console.log('\n  PhoneDrop is already running (port ' + port + ' is in use).');
  console.log('  Close the other PhoneDrop window, or press Ctrl+C in it, then run this again.');
  console.log('  Still stuck? Run:  taskkill /F /IM node.exe   (Windows)\n');
  process.exit(1);
}
// no time limit on big uploads (Node's default cuts requests off after 5 minutes)
function noLimits(srv) { srv.requestTimeout = 0; srv.headersTimeout = 60000; srv.keepAliveTimeout = 10000; return srv; }
const httpServer = noLimits(http.createServer(handler));
httpServer.on('error', (e) => { if (e.code === 'EADDRINUSE') portBusy(HTTP_PORT); else throw e; });
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log('\n  PhoneDrop ' + VERSION + ' is running on ' + HOST + '\n');
  clearOld();
  console.log('  Open on this computer : http://localhost:' + HTTP_PORT);
  console.log('  Shared folder         : ' + DIR + '\n');
  startHttps();
  if (APP) openWindow();
  ensureShortcut();
});

// PhoneDrop.exe: add itself to the Start Menu so it can be found by searching "PhoneDrop"
function ensureShortcut() {
  if (!IS_EXE || process.platform !== 'win32') return;
  // installed with PhoneDrop-Setup.exe? The installer already made the shortcuts.
  if (fs.existsSync(path.join(path.dirname(process.execPath), 'installed.txt'))) return;
  const lnk = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'PhoneDrop.lnk');
  const stamp = path.join(BASE, 'shortcut.txt');
  try { if (fs.existsSync(lnk) && fs.readFileSync(stamp, 'utf8') === process.execPath) return; } catch (e) {}
  const q = (x) => "'" + String(x).replace(/'/g, "''") + "'";
  const ps = '$s=(New-Object -ComObject WScript.Shell).CreateShortcut(' + q(lnk) + ');' +
    '$s.TargetPath=' + q(process.execPath) + ';$s.WorkingDirectory=' + q(path.dirname(process.execPath)) + ';' +
    '$s.Description=' + q('Send photos and files from this PC to your phone') + ';$s.Save()';
  try {
    const c = spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, stdio: 'ignore' });
    c.on('error', () => {});
    c.on('exit', (code) => { if (code === 0) { try { fs.writeFileSync(stamp, process.execPath); } catch (e) {} } });
  } catch (e) {}
}
function startHttps() {
try {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const keyF = path.join(CERT_DIR, 'key.pem'), certF = path.join(CERT_DIR, 'cert.pem'), stamp = path.join(CERT_DIR, 'ip.txt');
  const ok = fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === IP && fs.existsSync(keyF) && fs.existsSync(certF);
  if (!ok) {
    const c = makeSelfSigned(IP);
    fs.writeFileSync(keyF, c.key); fs.writeFileSync(certF, c.cert); fs.writeFileSync(stamp, IP);
  }
  noLimits(https.createServer({ key: fs.readFileSync(keyF), cert: fs.readFileSync(certF) }, handler))
    .on('error', (e) => { if (e.code === 'EADDRINUSE') portBusy(HTTPS_PORT); else console.log('  (Secure link error: ' + e.message + ')'); })
    .listen(HTTPS_PORT, '0.0.0.0', () => {
      httpsUp = true;
      console.log('  Phone link (use this) : ' + HTTPS_URL);
      console.log('  Plain link            : ' + HTTP_URL + '\n');
    });
} catch (e) {
  console.log('  (Secure link unavailable: ' + String((e && e.message) || e).split('\n')[0] + ')');
  console.log('  Phone link            : ' + HTTP_URL + '\n');
}
}

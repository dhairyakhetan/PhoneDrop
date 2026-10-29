/*
  PhoneDrop test mode — for testing and debugging on one computer, without phones, networks or GitHub.

    node server.js --test                  (or PHONEDROP_TEST=1 node server.js)
    npm run test-mode                      same thing

  Only with `node server.js`, never inside PhoneDrop.exe. It changes nothing unless you ask:
  - keeps its files in .test-data/ (your real shared files are never touched; PHONEDROP_DATA=<folder> to pick another)
  - logs every request in the terminal
  - a TEST badge and a debug panel on the page (bottom left on the PC) to switch everything below
  - /api/test/* (this computer only) does the same for scripts and the automated tests in test/:
      POST /api/test/net        {preset: real|wifi|busy|iphone-hotspot|android-hotspot|pc-hotspot|cable|none}
      POST /api/test/phones     {add: {id, name}} a pretend phone asks to connect (Allow it on the page, or below);
                                {add, paired: true} one that's paired and connected | {remove: id} | {clear: true}
      POST /api/test/pair       {rotate: true} new QR pairing code | {life: ms} how long codes last (10 min) |
                                {allow: rid|'all'} | {block: rid|'all'} answer "Allow … to connect?" requests |
                                {forget: 'all'} unpair every phone (real ones too) | {requestLife: ms} (2 min) |
                                {clear: true} drop waiting requests and forget blocked addresses (Reset does too)
                                A request with the header x-phonedrop-ip: <address> pretends to come from there.
      POST /api/test/throttle   {bps}            slow every file download to bps bytes/s (0 = off)
      POST /api/test/faults     {cutAfter, cutCount, diskFull, grace}   cut the next cutCount downloads after
                                cutAfter bytes (like Wi-Fi dropping); uploads fail with "disk full"; grace = ms
                                before a phone that lost its connection counts as gone (8000)
                                {upCutAfter, upCutCount} cut the next upCutCount upload parts after upCutAfter bytes;
                                {upFullAfter} the disk fills up after that many more uploaded bytes;
                                {partIdle} ms without progress before a partial upload is deleted (1 hour)
      POST /api/test/release    {version, notes, size, quick, uac, badSum, stall, bps, building, quiet}   a fake GitHub
                                release; {} = none. building: the installer isn't attached yet (CI still running).
                                quiet: don't check for it now (PhoneDrop finds it on its next check or when installing)
                                quick: true (a quick update for this copy) | 'other' (one for a different exe, so
                                the installer is used) | 'broken' (crashes on start) | 'hang' (never starts);
                                leave it out for a release with only the installer
                                uac: yes | no | fail | noreopen (what the Windows prompt / installer does)
      POST /api/test/samples    {photos, photoMB, big, files}   add generated photos (PNG, photoMB big each), a big
                                video-like file (MB) and small files
      GET  /api/test/stats      requests, bytes sent, downloads cut, Range requests, …   POST /api/test/reset
      POST /api/test/quit       stop this server (after a test update it runs in the background, logging to
                                .test-data/restart.log)
  - a phone's browser counts as a phone on the Wi-Fi even when it's this computer pretending to be one (Chrome
    DevTools → device toolbar → iPhone/Pixel, on http://localhost:3000): its user agent decides. Scripts can send
    the header `x-phonedrop-phone: 1` instead. A pretend iPhone without a share sheet gets a pretend one.
  - after a test update, PhoneDrop restarts itself in the background: its output goes to .test-data/restart.log.
    Stop it with the panel's Stop server button (or POST /api/test/quit)
  - npm test runs the automated tests (test/), each against its own test-mode PhoneDrop
*/

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Transform } = require('stream');
const quick = require('./scripts/quick-update.js');

const NETS = {
  wifi: { ifaces: [['Wi-Fi', '192.168.1.23']], route: '192.168.1.23', ssid: { 'Wi-Fi': 'HomeNet' } },
  busy: { // the usual Windows laptop: WSL, VirtualBox and Bluetooth adapters next to the real Wi-Fi
    ifaces: [['vEthernet (WSL)', '172.29.112.1'], ['VirtualBox Host-Only Network', '192.168.56.1'], ['Wi-Fi', '192.168.1.23'], ['Bluetooth Network Connection', '169.254.3.4']],
    route: '192.168.1.23', ssid: { 'Wi-Fi': 'HomeNet' },
  },
  'iphone-hotspot': { ifaces: [['Wi-Fi', '172.20.10.2']], route: '172.20.10.2', ssid: { 'Wi-Fi': 'Dhairya’s iPhone' } },
  'android-hotspot': { ifaces: [['Wi-Fi', '192.168.43.120']], route: '192.168.43.120', ssid: { 'Wi-Fi': 'Galaxy S24' } },
  'pc-hotspot': { ifaces: [['Wi-Fi', '192.168.1.23'], ['Local Area Connection* 10', '192.168.137.1']], route: '192.168.1.23', ssid: { 'Wi-Fi': 'HomeNet' } },
  cable: { ifaces: [['Ethernet', '192.168.0.10']], route: '192.168.0.10', ssid: {} },
  none: { ifaces: [], route: '', ssid: {} },
};

function freshStats() { return { requests: 0, downloads: 0, bytesSent: 0, cut: 0, ranges: 0, closedEarly: 0, uploads: 0, upBytes: 0, upCut: 0 }; }

// the state server.js reads (T); server.js calls attach() once everything exists
const T = {
  net: null, throttle: 0, cut: null, diskFull: false, grace: 8000, release: null, stats: freshStats(), S: null,
  upCut: null, upFull: 0, partIdle: 3600000,
  attach(S) { T.S = S; },
};

// the counters, + partial uploads waiting in the shared folder
function stats() { return Object.assign({ partials: fs.readdirSync(T.S.DIR).filter((n) => n.startsWith('.up-')).length }, T.stats); }
// uploads in parts: count the bytes, and cut a request part way (like Wi-Fi dropping) or fill up the disk
T.upData = function (req, n) {
  T.stats.upBytes += n;
  req.got = (req.got || 0) + n;
  if (T.upFull > 0 && (T.upFull -= n) <= 0) { T.upFull = 0; return 'full'; }
  if (T.upCut && !req.cut && req.got > T.upCut.after) {
    req.cut = true; T.stats.upCut++;
    if (--T.upCut.count <= 0) T.upCut = null;
    return 'cut';
  }
  return null;
};

// ---------- request log + download shaping ----------
function unescaped(u) { try { return decodeURIComponent(u); } catch (e) { return u; } }
T.log = function (req, res, phone) {
  const t0 = Date.now();
  T.stats.requests++;
  res.on('close', () => {
    if (req.url.startsWith('/api/events')) return; // live connections, logged when they open would be noise
    const ms = Date.now() - t0, len = res.getHeader('content-length');
    console.log('  [test] ' + (phone ? 'phone ' : 'pc    ') + req.method.padEnd(6) + String(res.statusCode).padEnd(4) +
      unescaped(req.url).slice(0, 80) + (len ? '  ' + len + ' B' : '') + '  ' + ms + ' ms' + (res.writableFinished ? '' : '  (closed early)'));
  });
};
// a step in a file download (server.js pipes the file through it): counts bytes, slows it down, or cuts the
// connection part way
T.download = function (req, res) {
  T.stats.downloads++;
  if (req.headers.range) T.stats.ranges++;
  const cut = T.cut && T.cut.count > 0 ? T.cut : null;
  if (cut) cut.count--;
  let sent = 0;
  res.on('close', () => { if (!res.writableFinished) T.stats.closedEarly++; });
  const shape = new Transform({
    transform(chunk, enc, cb) {
      const send = (c) => { sent += c.length; T.stats.bytesSent += c.length; this.push(c); };
      if (cut && sent + chunk.length > cut.after) {
        send(chunk.subarray(0, Math.max(0, cut.after - sent)));
        T.stats.cut++;
        return setTimeout(() => res.socket && res.socket.destroy(), 50); // like the Wi-Fi dropping mid-download
      }
      if (!T.throttle) { send(chunk); return cb(); }
      send(chunk);
      setTimeout(cb, (chunk.length / T.throttle) * 1000);
    },
  });
  return shape;
};

// ---------- fake GitHub (used by the real update code, so test mode exercises it) ----------
const blobs = new Map(); // size -> deterministic installer bytes
function fakeSetup(size) {
  if (!blobs.has(size)) {
    const b = Buffer.alloc(size);
    for (let i = 0; i < size; i += 32) crypto.createHash('sha256').update(String(i)).digest().copy(b, i);
    blobs.set(size, b);
  }
  return blobs.get(size);
}
// a quick update made from these very files, as CI would make it (cached per release)
const bundles = new Map();
function bundle(r) {
  const id = r.version + ' ' + r.quick;
  if (!bundles.has(id)) {
    const replace = r.quick === 'broken' ? { 'server.js': 'throw new Error("test mode: this version is broken on purpose")\n' }
      : r.quick === 'hang' ? { 'server.js': 'setInterval(() => {}, 1 << 30); // test mode: never gets going\n' } : null;
    bundles.set(id, quick.make(__dirname, { version: r.version, base: bundleBase(r), replace, extra: ['testmode.js', 'scripts/quick-update.js'] }));
  }
  return bundles.get(id);
}
const bundleBase = (r) => (r.quick === 'other' ? 'other' : T.S.BUILD.base);
T.fetch = async function (url, opts = {}) {
  const r = T.release, repo = T.S.REPO, dl = 'https://github.com/' + repo + '/releases/download/v' + (r && r.version) + '/';
  if (url === 'https://api.github.com/repos/' + repo + '/releases/latest') {
    if (!r) return new Response('{"message":"Not Found"}', { status: 404 });
    const assets = r.building ? [] : [{ name: 'PhoneDrop-Setup.exe', size: r.size }, { name: 'PhoneDrop-Setup.exe.sha256', size: 65 }];
    if (r.quick && !r.building) { const n = 'PhoneDrop-app-' + bundleBase(r) + '.json.gz'; assets.push({ name: n, size: bundle(r).length }, { name: n + '.sha256', size: 65 }); }
    return Response.json({
      tag_name: 'v' + r.version, html_url: 'https://github.com/' + repo + '/releases/tag/v' + r.version,
      body: (r.notes || '## What\'s new\n- Test release made by test mode') + '\n\n<!-- install -->\nInstall help…',
      assets: assets.map((a) => Object.assign({ browser_download_url: dl + a.name }, a)),
    });
  }
  if (!r || !url.startsWith(dl)) return new Response('not found', { status: 404 });
  const name = url.slice(dl.length), file = name.replace(/\.sha256$/, '');
  if (file !== 'PhoneDrop-Setup.exe' && !(r.quick && file === 'PhoneDrop-app-' + bundleBase(r) + '.json.gz')) return new Response('not found', { status: 404 });
  const data = file === 'PhoneDrop-Setup.exe' ? fakeSetup(r.size) : bundle(r);
  if (name.endsWith('.sha256')) return new Response((r.badSum ? '0'.repeat(64) : crypto.createHash('sha256').update(data).digest('hex')) + '  ' + file + '\n');
  let i = 0;
  const bps = r.bps || 8 * 1048576, piece = 256 * 1024;
  const body = new ReadableStream({
    start(ctl) { if (opts.signal) opts.signal.addEventListener('abort', () => { try { ctl.error(new Error('aborted')); } catch (e) {} }); },
    async pull(ctl) {
      if (opts.signal && opts.signal.aborted) return ctl.error(new Error('aborted'));
      if (r.stall && i > data.length / 3) return new Promise(() => {}); // never sends another byte
      await new Promise((ok) => setTimeout(ok, (piece / bps) * 1000));
      if (i >= data.length) return ctl.close();
      ctl.enqueue(new Uint8Array(data.subarray(i, i + piece))); i += piece;
    },
  });
  return new Response(body, { headers: { 'content-length': String(data.length) } });
};

// what the Windows prompt + installer would do. handedOver(): the user said Yes and the installer took over
// (PhoneDrop then quits); ended(code): 1 = said No, anything else = the installer didn't start.
T.launchInstaller = function (version, handedOver, ended) {
  const what = (T.release && T.release.uac) || 'yes';
  setTimeout(() => {
    if (what === 'no') return ended(1);
    if (what === 'fail') return ended(-1);
    handedOver();
    if (what === 'noreopen') return; // the installer "forgot" to reopen PhoneDrop
    T.restartAs(version, 2500);
  }, 600);
};
// start a new copy of this server (after `delay` ms, once this one has quit), as the installer would
T.restartAs = function (version, delay) {
  const log = fs.openSync(path.join(T.S.BASE, 'restart.log'), 'a');
  const env = Object.assign({}, process.env, { PHONEDROP_TEST_VERSION: version || '' });
  const code = 'setTimeout(() => { require("child_process").spawn(process.execPath, JSON.parse(process.env.PD_ARGS), ' +
    '{ detached: true, stdio: ["ignore", 1, 2], env: process.env }).unref(); }, ' + delay + ');'; // 1, 2: this log
  env.PD_ARGS = JSON.stringify(process.argv.slice(1));
  spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', log, log], env }).unref();
};

// ---------- sample files ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// a w×h PNG with a colour gradient and some noise (so every sample looks different and isn't tiny)
function png(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let r = seed * 7919;
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      r = (r * 1103515245 + 12345) & 0x7fffffff;
      const n = (r & 31) - 16, o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.max(0, Math.min(255, ((seed * 53) % 256) * (1 - x / w) + 40 + n));
      raw[o + 1] = Math.max(0, Math.min(255, ((seed * 97) % 256) * (y / h) + 30 + n));
      raw[o + 2] = Math.max(0, Math.min(255, 255 * (x / w) * (1 - y / h) + n));
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function addSamples(o) {
  const S = T.S, made = [];
  const put = (name, data) => { const n = S.uniqueName(name); fs.writeFileSync(path.join(S.DIR, n), data); made.push(n); return n; };
  for (let i = 0; i < (o.photos || 0); i++) {
    const seed = Date.now() % 1000 + i, img = png(1600, 1200, seed);
    // photoMB: make it as big as a phone photo (extra bytes after the end of a PNG are ignored when it's shown)
    const pad = o.photoMB ? Math.max(0, o.photoMB * 1048576 - img.length) : 0;
    const n = put('Sample ' + String(i + 1).padStart(2, '0') + '.png', pad ? Buffer.concat([img, crypto.randomBytes(pad)]) : img);
    fs.writeFileSync(path.join(S.DIR, '.thumbs', n + '.jpg'), png(440, 330, seed)); // a thumbnail, like the PC's browser makes
  }
  for (let i = 0; i < (o.files || 0); i++) put('Notes ' + (i + 1) + '.txt', Buffer.from('PhoneDrop test file ' + (i + 1) + '\n'.repeat(100)));
  if (o.big) { // a big "video": a sparse-ish file of o.big MB, written in pieces
    const n = S.uniqueName('Big video.mp4'), fd = fs.openSync(path.join(S.DIR, n), 'w'), piece = crypto.randomBytes(1048576);
    for (let i = 0; i < o.big; i++) fs.writeSync(fd, piece);
    fs.closeSync(fd); made.push(n);
  }
  S.bump();
  return made;
}

// ---------- /api/test/* ----------
function body(req) {
  return new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { ok(null); } }); });
}
T.route = async function (req, res, p) {
  const S = T.S, out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  if (!S.isLocal(req)) return out(403, { error: 'test controls only work on this computer' });
  const b = req.method === 'POST' ? await body(req) : {};
  if (b === null) return out(400, { error: 'bad JSON' });
  switch (p) {
    case '/api/test': return out(200, { net: T.net ? T.net.preset : 'real', presets: ['real'].concat(Object.keys(NETS)), throttle: T.throttle, cut: T.cut,
      diskFull: T.diskFull, grace: T.grace, release: T.release, phones: S.devList(), paired: S.phoneList(), requests: S.requestList(), pair: S.pairInfo(),
      stats: stats(), version: S.VERSION, data: S.BASE, pid: process.pid });
    case '/api/test/stats': return out(200, stats());
    case '/api/test/net': {
      if (b.preset && b.preset !== 'real' && !NETS[b.preset]) return out(400, { error: 'unknown preset', presets: ['real'].concat(Object.keys(NETS)) });
      T.net = !b.preset || b.preset === 'real' ? null : Object.assign({ preset: b.preset }, NETS[b.preset]);
      await S.watchNet(true);
      return out(200, S.netInfo());
    }
    case '/api/test/phones': {
      let rid = null;
      if (b.add) {
        const id = String(b.add.id || 'test-' + Math.random().toString(36).slice(2, 6)), name = String(b.add.name || 'iPhone');
        if (b.paired) S.pairFake(id, name); else rid = S.fakeRequest(id, name);
      }
      if (b.remove) S.removeFakePhone(String(b.remove));
      if (b.clear) S.removeFakePhone(null);
      return out(200, { phones: S.devList(), rid, requests: S.requestList() });
    }
    case '/api/test/pair': {
      if (b.life) S.setPairLife(Math.max(1000, Number(b.life) || 600000));
      if (b.requestLife) S.setRequestLife(Math.max(500, Number(b.requestLife) || 120000));
      if (b.rotate) S.rotateCode();
      for (const k of ['allow', 'block']) if (b[k]) for (const r of S.requestList()) if (b[k] === 'all' || b[k] === r.rid) S.answerRequest(r.rid, k === 'allow');
      if (b.forget === 'all') S.forgetPhones();
      if (b.clear) S.clearRequests();
      return out(200, { pair: S.pairInfo(), requests: S.requestList(), phones: S.phoneList() });
    }
    case '/api/test/throttle': T.throttle = Math.max(0, Number(b.bps) || 0); return out(200, { throttle: T.throttle });
    case '/api/test/faults':
      if ('cutAfter' in b || 'cutCount' in b) T.cut = Number(b.cutCount) > 0 ? { after: Number(b.cutAfter) || 0, count: Number(b.cutCount) } : null;
      if ('diskFull' in b) T.diskFull = !!b.diskFull;
      if ('grace' in b) T.grace = Number(b.grace) || 8000;
      if ('upCutAfter' in b || 'upCutCount' in b) T.upCut = Number(b.upCutCount) > 0 ? { after: Number(b.upCutAfter) || 0, count: Number(b.upCutCount) } : null;
      if ('upFullAfter' in b) T.upFull = Math.max(0, Number(b.upFullAfter) || 0);
      if ('partIdle' in b) T.partIdle = Math.max(100, Number(b.partIdle) || 3600000);
      return out(200, { cut: T.cut, diskFull: T.diskFull, grace: T.grace, upCut: T.upCut, upFull: T.upFull, partIdle: T.partIdle });
    case '/api/test/release':
      if (b.version && !/^\d+\.\d+\.\d+$/.test(b.version)) return out(400, { error: 'version must look like 1.2.3' });
      T.release = b.version ? Object.assign({ size: 3 * 1048576, uac: 'yes' }, b) : null;
      if (!b.quiet) { S.resetUpdate(); if (T.release) await S.checkUpdate(); }
      return out(200, { release: T.release, update: S.updateInfo() });
    case '/api/test/samples': return out(200, { added: addSamples(b) });
    case '/api/test/quit': out(200, { ok: true }); return setTimeout(() => process.exit(0), 100);
    case '/api/test/reset':
      T.net = null; T.throttle = 0; T.cut = null; T.diskFull = false; T.grace = 8000; T.release = null; T.stats = freshStats();
      T.upCut = null; T.upFull = 0; T.partIdle = 3600000;
      for (const n of fs.readdirSync(S.DIR)) if (n.startsWith('.up-')) fs.rmSync(path.join(S.DIR, n), { force: true });
      S.resetUpdate(); S.removeFakePhone(null); S.clearRequests(); S.clearAll(); await S.watchNet(true);
      return out(200, { ok: true });
  }
  out(404, { error: 'unknown test control' });
};

module.exports = T;

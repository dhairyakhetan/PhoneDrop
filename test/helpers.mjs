// Shared bits for the automated tests (npm test). Every test starts its own PhoneDrop in test mode
// (node server.js --test) on free ports, with its own data folder, so nothing touches your real files.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
export const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
export const PHONE = { 'x-phonedrop-phone': '1' }; // test mode: this request comes from a phone on the Wi-Fi (not paired)

function free(port) {
  return new Promise((ok) => { const s = net.createServer().once('error', () => ok(false)).listen(port, '0.0.0.0', () => s.close(() => ok(true))); });
}
// an HTTP port whose HTTPS partner (port + 443) is free too
async function ports() {
  for (;;) {
    const p = 20000 + Math.floor(Math.random() * 20000);
    if ((await free(p)) && (await free(p + 443))) return p;
  }
}
export function tmpDir(name) { return fs.mkdtempSync(path.join(os.tmpdir(), 'phonedrop-' + (name || 'test') + '-')); }

// start PhoneDrop; { env, data, port, args } are optional. Resolves once it answers.
export async function startServer(o = {}) {
  const port = o.port || (await ports()), data = o.data || tmpDir();
  const env = Object.assign({}, process.env, { PORT: String(port), PHONEDROP_DATA: data, PHONEDROP_TEST: '1' }, o.env || {});
  delete env.KEEP;
  if (o.env && o.env.KEEP) env.KEEP = o.env.KEEP;
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--test'].concat(o.args || []), { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (c) => { log += c; });
  proc.stderr.on('data', (c) => { log += c; });
  const url = 'http://localhost:' + port;
  const s = {
    url, port, https: 'https://localhost:' + (port + 443), data, proc, get log() { return log; },
    exited: new Promise((ok) => proc.on('exit', (code) => ok(code))),
    api: (p, body, headers) => api(url, p, body, headers),
    // the QR code's pairing code (only this PC gets it)
    async pairCode() { return (await api(url, '/api/info')).body.pair.code; },
    // a phone paired the way scanning the QR code pairs it: headers for its requests (its cookie)
    async phone(name = 'iPhone', id) {
      const r = await api(url, '/api/pair', { code: await s.pairCode(), id: id || 'ph-' + crypto.randomBytes(3).toString('hex'), name }, PHONE);
      const c = /(pd(?:_s)?=[^;]+)/.exec(r.headers.get('set-cookie') || '');
      if (!c) throw new Error('pairing failed: ' + r.text);
      return Object.assign({ cookie: c[1] }, PHONE);
    },
    async stop() {
      await fetch(url + '/api/test/quit', { method: 'POST' }).catch(() => {}); // also stops a copy that restarted itself
      proc.kill();
      await sleep(150);
    },
  };
  if (o.noWait) return s;
  for (let i = 0; i < 100; i++) {
    if (await fetch(url + '/api/info').then((r) => r.ok, () => false)) return s;
    if (proc.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error('PhoneDrop did not start:\n' + log);
}
// One request on its own connection. (fetch() reuses idle connections; in a busy test machine it can take
// longer to start sending a big body than the server keeps an idle connection open, and then fails with EPIPE.)
export function request(url, o = {}) {
  return new Promise((ok, no) => {
    const body = o.body === undefined ? null : Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body);
    const headers = Object.assign({}, o.headers, body ? { 'Content-Length': body.length } : {});
    const rq = http.request(url, { method: o.method || (body ? 'POST' : 'GET'), headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks), text = buf.toString();
        let j = null; try { j = JSON.parse(text); } catch (e) {}
        const get = (k) => { const v = res.headers[k.toLowerCase()]; return v == null ? null : Array.isArray(v) ? v.join(', ') : v; };
        ok({ status: res.statusCode, body: j, text, buf, headers: { get } });
      });
      res.on('error', no);
    });
    rq.on('error', no);
    rq.end(body);
  });
}
// JSON in, JSON out (body undefined = GET)
export function api(url, p, body, headers) {
  return request(url + p, body === undefined ? { headers } : { headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body) });
}
export async function upload(url, name, data, query = '', headers) {
  const r = await request(url + '/upload?name=' + encodeURIComponent(name) + query, { body: data, headers });
  return { status: r.status, body: r.body };
}
export async function waitFor(fn, ms = 10000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => false); // e.g. the server is restarting: try again
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(100);
  }
}
// reads Server-Sent Events: ev.next(name) resolves with the next event of that name (data parsed)
export function events(url, query = '', headers) {
  const ac = new AbortController(), queue = [], waiters = [];
  const done = fetch(url + '/api/events' + query, { headers, signal: ac.signal }).then(async (r) => {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        let name = 'message', data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) name = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        let d = data; try { d = JSON.parse(data); } catch (e) {}
        const ev = { name, data: d };
        const w = waiters.findIndex((x) => x.name === ev.name && (!x.match || x.match(ev.data)));
        if (w >= 0) waiters.splice(w, 1)[0].ok(ev.data); else queue.push(ev);
      }
    }
  }).catch(() => {});
  return {
    next(name, match, ms = 8000) {
      const i = queue.findIndex((e) => e.name === name && (!match || match(e.data)));
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0].data);
      return new Promise((ok, no) => {
        const w = { name, match, ok };
        waiters.push(w);
        setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) { waiters.splice(j, 1); no(new Error('no "' + name + '" event within ' + ms + ' ms')); } }, ms);
      });
    },
    clear() { queue.length = 0; },
    close() { ac.abort(); return done; },
  };
}

// a browser for the UI tests: Playwright's own Chromium if it's installed, else Edge or Chrome.
// On Linux without a locale (LANG unset, as in many containers) Chromium can't read dropped folders with non-ASCII
// names (EncodingError), so it gets a UTF-8 one. Windows and macOS don't have that problem.
const env = () => (process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG ? process.env : Object.assign({}, process.env, { LANG: 'C.UTF-8' }));
let browserP = null;
export function browser() {
  if (!browserP) browserP = (async () => {
    const { chromium } = await import('playwright-core');
    const tries = [{}, { channel: 'msedge' }, { channel: 'chrome' }];
    if (process.env.PHONEDROP_BROWSER) tries.unshift({ executablePath: process.env.PHONEDROP_BROWSER });
    let err;
    for (const t of tries) { try { return await chromium.launch(Object.assign({ env: env() }, t)); } catch (e) { err = e; } }
    throw new Error('No browser for the UI tests. Install Edge or Chrome, or set PHONEDROP_BROWSER to a Chromium. (' + err.message.split('\n')[0] + ')');
  })();
  return browserP;
}
// a separate browser with extra Chromium switches (closed by the caller). `direct` = these host names never go
// through a proxy (a test machine may have one set up that only lets localhost through).
export async function browserWith(args, direct) {
  const { chromium } = await import('playwright-core');
  const tries = [{}, { channel: 'msedge' }, { channel: 'chrome' }];
  if (process.env.PHONEDROP_BROWSER) tries.unshift({ executablePath: process.env.PHONEDROP_BROWSER });
  const proxy = direct ? { proxy: { server: 'http://127.0.0.1:9', bypass: direct.concat(['localhost', '127.0.0.1']).join(',') } } : {};
  for (const t of tries) { try { return await chromium.launch(Object.assign({ args, env: env() }, proxy, t)); } catch (e) {} }
  throw new Error('No browser for the UI tests');
}
export async function closeBrowser() { if (browserP) { const b = await browserP.catch(() => null); browserP = null; if (b) await b.close(); } }

// a photo-like file with random bytes (the server never looks inside files)
export function randomFile(bytes) { return crypto.randomBytes(bytes); }

// A small zip reader (STORE zips like the page makes, ZIP64 too), straight from the file on disk:
// -> [{ name, size, crc, method, flags, data (where its bytes start), dir, read() }]
export function readZip(file) {
  const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size;
  const rd = (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; };
  const no = (what) => { throw new Error('not a valid zip: ' + what); };
  const tail = rd(Math.max(0, size - 22), 22);
  if (tail.readUInt32LE(0) !== 0x06054b50) no('end of central directory');
  let n = tail.readUInt16LE(10), cdSize = tail.readUInt32LE(12), cdOff = tail.readUInt32LE(16);
  if (n === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) {
    const loc = rd(size - 22 - 20, 20);
    if (loc.readUInt32LE(0) !== 0x07064b50) no('ZIP64 locator');
    const z = rd(Number(loc.readBigUInt64LE(8)), 56);
    if (z.readUInt32LE(0) !== 0x06064b50) no('ZIP64 end record');
    n = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
  }
  const cd = rd(cdOff, cdSize), out = [];
  for (let p = 0, i = 0; i < n; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) no('central record ' + i);
    let size = cd.readUInt32LE(p + 24), offset = cd.readUInt32LE(p + 42);
    const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
    const name = cd.toString('utf8', p + 46, p + 46 + nl), x = cd.subarray(p + 46 + nl, p + 46 + nl + xl);
    for (let q = 0; q < x.length; q += 4 + x.readUInt16LE(q + 2)) {
      if (x.readUInt16LE(q) !== 1) continue;
      let r = q + 4;
      if (size === 0xFFFFFFFF) { size = Number(x.readBigUInt64LE(r)); r += 16; }
      if (offset === 0xFFFFFFFF) offset = Number(x.readBigUInt64LE(r));
    }
    const lh = rd(offset, 30);
    if (lh.readUInt32LE(0) !== 0x04034b50) no('local header of ' + name);
    const data = offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    out.push({ name, size, crc: cd.readUInt32LE(p + 16), method: cd.readUInt16LE(p + 10), flags: cd.readUInt16LE(p + 8), data, dir: name.endsWith('/'), read: (at = 0, len = size) => rd(data + at, len) });
    p += 46 + nl + xl + cl;
  }
  return out;
}
// Python's zipfile, when Python is installed (else null): { names, sha: { name: sha256 } }. It reads every file
// up to `limit` bytes (zipfile checks each one's CRC as it reads, and fails on a wrong one).
export function pythonZip(file, limit = Infinity) {
  let py = null;
  for (const c of ['python3', 'python']) if (spawnSync(c, ['--version']).status === 0) { py = c; break; }
  if (!py) return null;
  const src = 'import zipfile,sys,hashlib,json\nz=zipfile.ZipFile(sys.argv[1])\nlim=float(sys.argv[2])\n' +
    'print(json.dumps({"names": [i.filename for i in z.infolist()],' +
    ' "sha": {i.filename: hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist() if not i.is_dir() and i.file_size <= lim}}))';
  const r = spawnSync(py, ['-I', '-c', src, file, String(limit === Infinity ? 'inf' : limit)], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error('Python zipfile: ' + r.stderr);
  return JSON.parse(r.stdout);
}

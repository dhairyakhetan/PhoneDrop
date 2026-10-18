// The server on its own: uploads, downloads, names, Range/resume, two-way files, live events, phones, safety.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { startServer, upload, events, waitFor, sleep, sha, randomFile, PHONE } from './helpers.mjs';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });
const files = async () => (await s.api('/api/files')).body;
const reset = () => s.api('/api/test/reset', {});
const get = (p, headers) => fetch(s.url + p, { headers });
// a raw HTTP request, for paths fetch() would clean up first
function raw(reqLine) {
  return new Promise((ok) => {
    const c = net.connect(s.port, '127.0.0.1', () => c.write(reqLine + '\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
    let b = ''; c.on('data', (d) => { b += d; }); c.on('end', () => ok(b)); c.on('error', () => ok(b));
  });
}

test('info: version, test mode, a network, no update', async () => {
  const i = (await s.api('/api/info')).body;
  assert.match(i.version, /^\d+\.\d+\.\d+$/);
  assert.equal(i.test, true);
  assert.equal(i.update, null);
  assert.ok(i.http.startsWith('http://'));
  assert.ok(Array.isArray(i.nets));
});

test('upload and download are byte-identical (photo metadata stays intact)', async () => {
  await reset();
  const data = randomFile(3 * 1048576 + 17);
  const r = await upload(s.url, 'IMG_0001.JPG', data);
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'IMG_0001.JPG');
  const back = Buffer.from(await (await get('/files/IMG_0001.JPG')).arrayBuffer());
  assert.equal(sha(back), sha(data));
  const f = (await files()).find((x) => x.name === 'IMG_0001.JPG');
  assert.equal(f.size, data.length);
  assert.equal(f.type, 'image/jpeg');
  assert.equal(f.from, ''); // sent from this PC
});

test('empty files and big files', async () => {
  await reset();
  assert.equal((await upload(s.url, 'empty.txt', Buffer.alloc(0))).status, 200);
  assert.equal((await files())[0].size, 0);
  const empty = await get('/files/empty.txt');
  assert.equal(empty.status, 200);
  assert.equal((await empty.arrayBuffer()).byteLength, 0);
  const big = randomFile(64 * 1048576);
  assert.equal((await upload(s.url, 'big.mov', big)).status, 200);
  assert.equal(sha(Buffer.from(await (await get('/files/big.mov')).arrayBuffer())), sha(big));
});

test('the same name twice gets a number, never overwrites', async () => {
  await reset();
  const a = await upload(s.url, 'photo.jpg', Buffer.from('a'));
  const b = await upload(s.url, 'photo.jpg', Buffer.from('b'));
  const c = await upload(s.url, 'photo.jpg', Buffer.from('c'));
  assert.deepEqual([a.body.name, b.body.name, c.body.name], ['photo.jpg', 'photo (1).jpg', 'photo (2).jpg']);
  assert.equal(await (await get('/files/photo.jpg')).text(), 'a');
});

test('a phone sending a file again (its answer got lost) doesn’t make a second copy', async () => {
  await reset();
  const data = randomFile(1000);
  const a = await upload(s.url, 'clip.mov', data, '&uid=abc123');
  const b = await upload(s.url, 'clip.mov', data, '&uid=abc123');
  assert.equal(a.body.name, 'clip.mov');
  assert.equal(b.body.name, 'clip.mov');
  assert.deepEqual((await files()).map((f) => f.name), ['clip.mov']);
  assert.deepEqual(fs.readdirSync(path.join(s.data, 'shared')).filter((n) => !n.startsWith('.')), ['clip.mov'], 'no temp file left');
  // another file with the same name (another id) still gets its own copy
  assert.equal((await upload(s.url, 'clip.mov', data, '&uid=def456')).body.name, 'clip (1).mov');
  // deleted in between: sending again makes it again
  await fetch(s.url + '/files/clip.mov', { method: 'DELETE' });
  assert.equal((await upload(s.url, 'clip.mov', data, '&uid=abc123')).body.name, 'clip.mov');
});

test('dangerous and odd file names are made safe', async () => {
  await reset();
  const cases = {
    '../../secret.txt': 'secret.txt',
    '..\\..\\win.ini': 'win.ini',
    'C:\\Windows\\evil.exe': 'evil.exe',
    '.hidden': 'hidden',
    '...': 'file',
    '': 'file',
    '   ': 'file',
    'CON': '_CON',
    'nul.txt': '_nul.txt',
    'com1.jpg': '_com1.jpg',
    'trailing dot.': 'trailing dot',
    'trailing space.jpg  ': 'trailing space.jpg',
    'a<b>c:d"e|f?g*h.png': 'a_b_c_d_e_f_g_h.png',
    'tab\there.jpg': 'tab_here.jpg',
    'Ünïcødé 照片 🎉.jpg': 'Ünïcødé 照片 🎉.jpg',
  };
  for (const [sent, want] of Object.entries(cases)) {
    const r = await upload(s.url, sent, Buffer.from(sent || 'x'));
    assert.equal(r.status, 200, sent);
    assert.equal(r.body.name.replace(/ \(\d+\)(?=\.|$)/, ''), want, JSON.stringify(sent));
  }
  const long = await upload(s.url, 'x'.repeat(500) + '.jpg', Buffer.from('x'));
  assert.ok(long.body.name.length <= 200);
  // nothing landed outside the shared folder
  assert.ok(!fs.existsSync(path.join(s.data, 'secret.txt')));
  assert.ok(!fs.existsSync(path.join(path.dirname(s.data), 'secret.txt')));
});

test('a name with a Windows device name in the middle is fine as is', async () => {
  await reset();
  assert.equal((await upload(s.url, 'console.log', Buffer.from('x'))).body.name, 'console.log');
  assert.equal((await upload(s.url, 'my con.txt', Buffer.from('x'))).body.name, 'my con.txt');
});

test('downloads can’t escape the shared folder', async () => {
  await reset();
  for (const p of ['/files/..%2F..%2Fserver.js', '/files/%2e%2e%2fpackage.json', '/files/..%5C..%5Cserver.js', '/thumbs/..%2F..%2Fserver.js']) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
  }
  const rawRes = await raw('GET /files/../../server.js HTTP/1.1');
  assert.doesNotMatch(rawRes, /require\('http'\)/);
  assert.match(rawRes, /^HTTP\/1\.1 404/);
  // the hidden folders inside shared/ aren't reachable either
  assert.equal((await get('/files/.thumbs')).status, 404);
  assert.equal((await get('/files/')).status, 404);
});

test('broken %-encoding in a path is a 400, not a crash', async () => {
  for (const p of ['/files/%E0%A4%A', '/files/%', '/thumbs/%zz', '/files/%C0%AF']) {
    const r = await raw('GET ' + p + ' HTTP/1.1');
    assert.match(r, /^HTTP\/1\.1 (400|404)/, p);
  }
  assert.equal((await s.api('/api/info')).status, 200); // still running
});

test('Range requests (video seeking, resuming)', async () => {
  await reset();
  const data = randomFile(10000);
  await upload(s.url, 'clip.mp4', data);
  const r1 = await get('/files/clip.mp4', { Range: 'bytes=0-0' });
  assert.equal(r1.status, 206);
  assert.equal(r1.headers.get('content-range'), 'bytes 0-0/10000');
  assert.deepEqual(Buffer.from(await r1.arrayBuffer()), data.subarray(0, 1));
  const r2 = await get('/files/clip.mp4', { Range: 'bytes=9000-' });
  assert.deepEqual(Buffer.from(await r2.arrayBuffer()), data.subarray(9000));
  const r3 = await get('/files/clip.mp4', { Range: 'bytes=-100' });
  assert.equal(r3.headers.get('content-range'), 'bytes 9900-9999/10000');
  const r4 = await get('/files/clip.mp4', { Range: 'bytes=500-99999' });
  assert.equal(r4.headers.get('content-range'), 'bytes 500-9999/10000');
  assert.equal((await get('/files/clip.mp4', { Range: 'bytes=10000-' })).status, 416);
  assert.equal((await get('/files/clip.mp4', { Range: 'bytes=600-500' })).status, 416);
  assert.equal((await get('/files/clip.mp4', { Range: 'garbage' })).status, 200);
  const head = await fetch(s.url + '/files/clip.mp4', { method: 'HEAD', headers: { Range: 'bytes=0-9' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), '10');
});

test('ETag + If-Range: resume only when the file is still the same', async () => {
  await reset();
  await upload(s.url, 'a.jpg', randomFile(5000));
  const first = await get('/files/a.jpg');
  const etag = first.headers.get('etag'), modified = first.headers.get('last-modified');
  assert.match(etag, /^"[0-9a-z]+-[0-9a-z]+"$/);
  assert.ok(modified);
  assert.equal(first.headers.get('accept-ranges'), 'bytes');
  assert.equal((await get('/files/a.jpg', { Range: 'bytes=100-', 'If-Range': etag })).status, 206);
  assert.equal((await get('/files/a.jpg', { Range: 'bytes=100-', 'If-Range': modified })).status, 206);
  // changed (or a different file with that name): the whole file again, never a mix of two files
  const stale = await get('/files/a.jpg', { Range: 'bytes=100-', 'If-Range': '"old-etag"' });
  assert.equal(stale.status, 200);
  assert.equal((await stale.arrayBuffer()).byteLength, 5000);
});

test('cancelled downloads close the file (they can be deleted, nothing piles up)', async () => {
  await reset();
  await upload(s.url, 'long.mp4', randomFile(20 * 1048576));
  for (let i = 0; i < 30; i++) {
    const ac = new AbortController();
    const r = await fetch(s.url + '/files/long.mp4', { signal: ac.signal });
    await r.body.getReader().read();
    ac.abort();
  }
  await sleep(500);
  if (fs.existsSync('/proc/' + s.proc.pid + '/fd')) {
    const open = fs.readdirSync('/proc/' + s.proc.pid + '/fd').filter((fd) => {
      try { return fs.readlinkSync('/proc/' + s.proc.pid + '/fd/' + fd).endsWith('long.mp4'); } catch (e) { return false; }
    });
    assert.equal(open.length, 0, 'long.mp4 still open ' + open.length + ' times');
  }
  assert.equal((await fetch(s.url + '/files/long.mp4', { method: 'DELETE' })).status, 200);
  assert.equal((await files()).length, 0);
});

test('test mode can cut downloads off part way, like Wi-Fi dropping', async () => {
  await reset();
  await upload(s.url, 'v.mp4', randomFile(2 * 1048576));
  await s.api('/api/test/faults', { cutAfter: 100000, cutCount: 1 });
  const r = await get('/files/v.mp4');
  let got = 0;
  await (async () => { for await (const c of r.body) got += c.length; })().catch(() => {});
  assert.ok(got >= 100000 && got < 2 * 1048576, 'got ' + got);
  // and resuming from there gives exactly the rest
  const rest = Buffer.from(await (await get('/files/v.mp4', { Range: 'bytes=' + got + '-' })).arrayBuffer());
  assert.equal(got + rest.length, 2 * 1048576);
  const stats = (await s.api('/api/test/stats')).body;
  assert.equal(stats.cut, 1);
  assert.ok(stats.ranges >= 1);
});

test('half-finished uploads never show up, and aborted ones leave nothing behind', async () => {
  await reset();
  const c = net.connect(s.port, '127.0.0.1');
  await new Promise((ok) => c.on('connect', ok));
  c.write('POST /upload?name=partial.jpg HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000000\r\n\r\n');
  c.write(Buffer.alloc(300000));
  await sleep(300);
  assert.equal((await files()).length, 0, 'not listed while uploading');
  const shared = path.join(s.data, 'shared');
  assert.equal(fs.readdirSync(shared).filter((n) => n.startsWith('.up-')).length, 1, 'a hidden temp file meanwhile');
  c.destroy();
  await waitFor(() => fs.readdirSync(shared).filter((n) => n.startsWith('.up-')).length === 0, 3000, 'temp file removed');
  assert.equal((await files()).length, 0);
});

test('disk full: the upload fails with 507 and nothing is kept', async () => {
  await reset();
  await s.api('/api/test/faults', { diskFull: true });
  const r = await upload(s.url, 'x.jpg', randomFile(1000));
  assert.equal(r.status, 507);
  assert.equal(r.body.error, 'disk full');
  await s.api('/api/test/faults', { diskFull: false });
  assert.equal((await files()).length, 0);
});

test('photos wait for their thumbnail so tiles appear once, fully drawn', async () => {
  await reset();
  await upload(s.url, 'p.jpg', randomFile(2000), '&thumb=1');
  assert.equal((await files()).length, 0, 'hidden until the thumbnail arrives');
  const t = await fetch(s.url + '/thumb?name=p.jpg&dur=12.5', { method: 'POST', body: randomFile(500) });
  assert.equal(t.status, 200);
  const [f] = await files();
  assert.equal(f.thumb, true);
  assert.equal(f.dur, 12.5);
  assert.equal((await get('/thumbs/p.jpg')).status, 200);
  // a thumbnail that never comes: the file shows up anyway after 5 s
  await upload(s.url, 'q.jpg', randomFile(2000), '&thumb=1');
  await waitFor(async () => (await files()).some((x) => x.name === 'q.jpg'), 7000, 'q.jpg shown without thumbnail');
});

test('thumbnails: unknown file 404, too big 413, empty body is fine', async () => {
  await reset();
  assert.equal((await fetch(s.url + '/thumb?name=nope.jpg', { method: 'POST', body: 'x' })).status, 404);
  await upload(s.url, 'v.mp4', randomFile(100));
  assert.equal((await fetch(s.url + '/thumb?name=v.mp4', { method: 'POST', body: randomFile(4 * 1048576) })).status, 413);
  assert.equal((await fetch(s.url + '/thumb?name=v.mp4&dur=3', { method: 'POST', body: '' })).status, 200);
  assert.equal((await files())[0].dur, 3);
  assert.equal((await get('/thumbs/v.mp4')).status, 404);
});

test('phone → PC: the sending phone is remembered; downloaded to the PC = transferred', async () => {
  await reset();
  const data = randomFile(50000);
  await upload(s.url, 'from-phone.jpg', data, '&from=phone-1&fromName=iPhone', PHONE);
  let [f] = await files();
  assert.equal(f.from, 'iPhone');
  assert.equal(f.fromId, 'phone-1');
  assert.equal(f.got, false);
  // a partial download doesn't count
  await (await get('/files/from-phone.jpg?dl=1', { Range: 'bytes=0-99' })).arrayBuffer();
  assert.equal((await files())[0].got, false);
  // a phone downloading it doesn't count either (only this PC)
  await (await get('/files/from-phone.jpg?dl=1', PHONE)).arrayBuffer();
  assert.equal((await files())[0].got, false);
  // the PC downloading it to the last byte does (a resumed download ending at the last byte too)
  await (await get('/files/from-phone.jpg?dl=1', { Range: 'bytes=100-' })).arrayBuffer();
  [f] = await files();
  assert.equal(f.got, true);
  // "from" is only taken from phones: the PC can't pretend
  await upload(s.url, 'pc.jpg', data, '&from=phone-1&fromName=iPhone');
  assert.equal((await files()).find((x) => x.name === 'pc.jpg').from, '');
});

test('saved by phones: counted per phone, bad requests rejected', async () => {
  await reset();
  await upload(s.url, 'a.jpg', randomFile(10));
  const ev = events(s.url);
  await ev.next('devices');
  assert.equal((await s.api('/api/saved', { id: 'p1', name: 'iPhone', files: ['a.jpg', 'missing.jpg'], media: true }, PHONE)).status, 200);
  const e = await ev.next('saved');
  assert.deepEqual(e, { name: 'iPhone', count: 1, media: true });
  await s.api('/api/saved', { id: 'p1', name: 'iPhone', files: ['a.jpg'] }, PHONE);
  await s.api('/api/saved', { id: 'p2', name: 'Android phone', files: ['a.jpg'] }, PHONE);
  assert.equal((await files())[0].saved, 2);
  const bad = await fetch(s.url + '/api/saved', { method: 'POST', body: '{nope' });
  assert.equal(bad.status, 400);
  assert.equal((await s.api('/api/saved', { files: 'a.jpg' })).status, 400);
  ev.close();
});

test('delete one, delete all (with their thumbnails and saved state)', async () => {
  await reset();
  await upload(s.url, 'a.jpg', randomFile(10), '&thumb=1');
  await fetch(s.url + '/thumb?name=a.jpg', { method: 'POST', body: randomFile(10) });
  await upload(s.url, 'b.jpg', randomFile(10));
  assert.equal((await fetch(s.url + '/files/a.jpg', { method: 'DELETE' })).status, 200);
  assert.ok(!fs.existsSync(path.join(s.data, 'shared', '.thumbs', 'a.jpg.jpg')));
  assert.deepEqual((await files()).map((f) => f.name), ['b.jpg']);
  assert.equal((await fetch(s.url + '/files/never-there.jpg', { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(s.url + '/api/files', { method: 'DELETE' })).status, 200);
  assert.equal((await files()).length, 0);
});

test('live updates: a change event when files change (also files added to the folder by hand)', async () => {
  await reset();
  const ev = events(s.url);
  await ev.next('devices');
  ev.clear();
  await upload(s.url, 'x.jpg', randomFile(10));
  assert.equal(await ev.next('message'), 'change');
  ev.clear();
  fs.writeFileSync(path.join(s.data, 'shared', 'dropped in.txt'), 'hello');
  assert.equal(await ev.next('message'), 'change');
  assert.ok((await files()).some((f) => f.name === 'dropped in.txt'));
  ev.close();
});

test('phones come and go (and a screen lock or reload isn’t "leaving")', async () => {
  await reset();
  await s.api('/api/test/faults', { grace: 600 });
  const pc = events(s.url);
  assert.deepEqual(await pc.next('devices'), []);
  const phone = events(s.url, '?id=ph1&name=iPhone', PHONE);
  assert.deepEqual(await pc.next('devices', (d) => d.length === 1), [{ id: 'ph1', name: 'iPhone' }]);
  // a second tab of the same phone, then a reload: still one phone, and no "left" in between
  const tab2 = events(s.url, '?id=ph1&name=iPhone', PHONE);
  await sleep(200);
  phone.close();
  const again = events(s.url, '?id=ph1&name=iPhone', PHONE);
  await sleep(900);
  assert.deepEqual(devicesNow(await s.api('/api/test')), ['iPhone']);
  tab2.close(); again.close();
  assert.deepEqual(await pc.next('devices', (d) => d.length === 0, 4000), []);
  // the PC's own page never counts as a phone
  const own = events(s.url, '?id=pc&name=Computer');
  await sleep(300);
  assert.deepEqual(devicesNow(await s.api('/api/test')), []);
  own.close(); pc.close();
  await s.api('/api/test/faults', { grace: 8000 });
});
const devicesNow = (r) => r.body.phones.map((p) => p.name);

test('fake phones from test mode show up like real ones', async () => {
  await reset();
  const pc = events(s.url);
  await pc.next('devices');
  await s.api('/api/test/phones', { add: { id: 'f1', name: 'Android phone' } });
  assert.deepEqual(await pc.next('devices', (d) => d.length === 1), [{ id: 'f1', name: 'Android phone' }]);
  await s.api('/api/test/phones', { clear: true });
  assert.deepEqual(await pc.next('devices', (d) => d.length === 0), []);
  pc.close();
});

test('only this PC may install updates or use the test controls', async () => {
  const phone = await s.api('/api/update/install', {}, PHONE);
  assert.equal(phone.status, 403);
  const site = await s.api('/api/update/install', {}, { Origin: 'http://evil.example' });
  assert.equal(site.status, 403);
  const rebind = await raw('POST /api/update/install HTTP/1.1\r\nHost: evil.example:' + s.port + '\r\nContent-Length: 0'); // DNS rebinding
  assert.match(rebind, /^HTTP\/1\.1 403/);
  assert.equal((await s.api('/api/update/install', {})).status, 404); // no update right now
  assert.equal((await s.api('/api/test', undefined, PHONE)).status, 403);
  assert.equal((await s.api('/api/test/reset', {}, PHONE)).status, 403);
  // phones never hear about updates
  await s.api('/api/test/release', { version: '99.0.0' });
  assert.equal((await s.api('/api/info', undefined, PHONE)).body.update, null);
  assert.equal((await s.api('/api/info')).body.update.version, '99.0.0');
  await s.api('/api/test/release', {});
});

test('test controls reject nonsense', async () => {
  assert.equal((await fetch(s.url + '/api/test/net', { method: 'POST', body: '{bad json' })).status, 400);
  assert.equal((await s.api('/api/test/net', { preset: 'moon-wifi' })).status, 400);
  assert.equal((await s.api('/api/test/release', { version: 'v2' })).status, 400);
  assert.equal((await s.api('/api/test/nothing', {})).status, 404);
});

test('QR code', async () => {
  const r = await get('/qr.svg?u=' + encodeURIComponent('http://192.168.1.23:3000'));
  assert.equal(r.headers.get('content-type'), 'image/svg+xml');
  assert.match(await r.text(), /^<svg[^>]+viewBox="0 0 \d+ \d+"/);
  const long = await get('/qr.svg?u=' + 'x'.repeat(3000)); // too long for a QR code: an error, not a crash
  assert.equal(long.status, 400);
  assert.equal((await s.api('/api/info')).status, 200);
});

test('icons, manifest and the page', async () => {
  for (const [p, type] of [['/icon.svg', 'image/svg+xml'], ['/icon.png', 'image/png'], ['/apple-touch-icon.png', 'image/png'], ['/manifest.json', 'application/manifest+json']]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('content-type'), type, p);
  }
  const m = await (await get('/manifest.json')).json();
  assert.equal(m.icons[0].src, '/icon.svg');
  const page = await (await get('/')).text();
  assert.match(page, /<link rel="icon" type="image\/svg\+xml" sizes="any" href="\/icon.svg">/);
  assert.match(page, /window\.PD_TEST = true/); // test mode marks the page
  assert.equal((await get('/nope')).status, 404);
});

test('networks: the right address is picked and the page hears about changes', async () => {
  const pc = events(s.url);
  await pc.next('devices');
  let n = (await s.api('/api/test/net', { preset: 'busy' })).body; // WSL, VirtualBox, Bluetooth next to the Wi-Fi
  assert.equal(n.ip, '192.168.1.23');
  assert.deepEqual(n.nets.map((x) => [x.iface, x.kind, x.ssid]), [['Wi-Fi', 'wifi', 'HomeNet']]);
  assert.equal((await pc.next('net', (d) => d.ip === '192.168.1.23')).nets.length, 1);
  n = (await s.api('/api/test/net', { preset: 'iphone-hotspot' })).body;
  assert.equal(n.nets[0].hotspot, 'phone');
  assert.equal(n.nets[0].ssid, 'Dhairya’s iPhone');
  n = (await s.api('/api/test/net', { preset: 'android-hotspot' })).body;
  assert.equal(n.nets[0].hotspot, 'phone');
  n = (await s.api('/api/test/net', { preset: 'pc-hotspot' })).body;
  assert.deepEqual(n.nets.map((x) => x.hotspot), ['', 'pc']);
  n = (await s.api('/api/test/net', { preset: 'cable' })).body;
  assert.equal(n.nets[0].kind, 'wired');
  n = (await s.api('/api/test/net', { preset: 'none' })).body;
  assert.equal(n.nets.length, 0);
  assert.equal(n.ip, 'localhost');
  pc.close();
  // the secure link's certificate covers the networks used lately (so the iPhone warning doesn't come back)
  await s.api('/api/test/net', { preset: 'wifi' });
  await s.api('/api/test/net', { preset: 'iphone-hotspot' });
  await sleep(300);
  const san = await new Promise((ok, no) => {
    const c = tls.connect({ host: '127.0.0.1', port: s.port + 443, rejectUnauthorized: false }, () => { ok(c.getPeerCertificate().subjectaltname); c.end(); });
    c.on('error', no);
  });
  assert.match(san, /IP Address:172\.20\.10\.2/);
  assert.match(san, /IP Address:192\.168\.1\.23/);
  assert.match(san, /DNS:localhost/);
  await s.api('/api/test/net', { preset: 'real' });
});

test('a second copy on the same port says so, exits, and doesn’t wipe the shared files', async () => {
  await reset();
  await upload(s.url, 'keep.jpg', randomFile(10));
  const second = await startServer({ port: s.port, data: s.data, noWait: true });
  assert.equal(await second.exited, 1);
  assert.match(second.log, /already running/);
  assert.deepEqual((await files()).map((f) => f.name), ['keep.jpg']);
});

test('starting again clears old shared files, unless KEEP=1', async () => {
  const one = await startServer();
  await upload(one.url, 'old.jpg', randomFile(10));
  await one.stop();
  const kept = await startServer({ data: one.data, env: { KEEP: '1' } });
  assert.deepEqual((await kept.api('/api/files')).body.map((f) => f.name), ['old.jpg']);
  await kept.stop();
  const fresh = await startServer({ data: one.data });
  assert.deepEqual((await fresh.api('/api/files')).body, []);
  await fresh.stop();
});

test('many uploads at once all arrive intact', async () => {
  await reset();
  const datas = Array.from({ length: 20 }, (_, i) => randomFile(100000 + i));
  const res = await Promise.all(datas.map((d, i) => upload(s.url, 'same.jpg', d)));
  const names = res.map((r) => r.body.name);
  assert.equal(new Set(names).size, 20, 'all got different names');
  for (let i = 0; i < 20; i++) assert.equal(sha(Buffer.from(await (await get('/files/' + encodeURIComponent(names[i]))).arrayBuffer())), sha(datas[i]));
});

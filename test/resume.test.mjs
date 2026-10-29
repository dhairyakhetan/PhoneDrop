// Resumable uploads (/upload/part): the server keeps what arrived, says how much that is, and the sender carries on
// from there. The page sends every file this way; the old one-request /upload still works (api.test.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { startServer, request, waitFor, sleep, sha, randomFile } from './helpers.mjs';

let s, phone;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });
const reset = async () => { await s.api('/api/test/reset', {}); phone = await s.phone('Android', 'dev-1'); };
const files = async () => (await s.api('/api/files')).body;
const stats = async () => (await s.api('/api/test/stats')).body;
const MB = 1048576;
// the part endpoint: q = { name, size, uid, offset, ... }
const qs = (q) => Object.entries(q).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
const status = (q, h = phone) => request(s.url + '/upload/part?' + qs(q), { headers: h }).then((r) => r.body);
const part = (q, body, h = phone) => request(s.url + '/upload/part?' + qs(q), { body, headers: h });
// send a whole file the way the page does: ask, then 8 MB parts from what the server has
async function send(q, data, h = phone) {
  let at = (await status(q, h)).received;
  for (;;) {
    const r = await part(Object.assign({ offset: at }, q), data.subarray(at, Math.min(data.length, at + 8 * MB)), h);
    if (r.body.name) return r.body.name;
    assert.ok(r.status === 200 || r.status === 409, 'HTTP ' + r.status + ' ' + r.text);
    at = r.body.received;
  }
}

test('parts arrive byte-identical; the server says how much it has; partial files stay hidden', async () => {
  await reset();
  const data = randomFile(20 * MB + 3), q = { name: 'VID_0001.mp4', size: data.length, uid: 'dev-1.abc123' };
  assert.deepEqual(await status(q), { received: 0 });
  let r = await part(Object.assign({ offset: 0 }, q), data.subarray(0, 8 * MB));
  assert.deepEqual(r.body, { received: 8 * MB });
  assert.deepEqual(await files(), [], 'a partial file is never listed');
  assert.equal((await stats()).partials, 1);
  assert.deepEqual(await status(q), { received: 8 * MB });
  // an offset that isn't what the server has: 409 with the right one, nothing written
  r = await part(Object.assign({ offset: 0 }, q), data.subarray(0, 1000));
  assert.equal(r.status, 409); assert.deepEqual(r.body, { received: 8 * MB });
  r = await part(Object.assign({ offset: 8 * MB + 5 }, q), data.subarray(8 * MB + 5, 9 * MB));
  assert.equal(r.status, 409); assert.deepEqual(r.body, { received: 8 * MB });
  // more than the file's size: refused
  r = await part(Object.assign({ offset: 8 * MB }, q), Buffer.alloc(13 * MB));
  assert.equal(r.status, 400);
  const name = await send(q, data);
  assert.equal(name, 'VID_0001.mp4');
  assert.equal(sha(fs.readFileSync(path.join(s.data, 'shared', name))), sha(data));
  const [f] = await files();
  assert.equal(f.from, 'Android', 'remembers the phone that sent it');
  assert.equal((await stats()).partials, 0);
});

test('the same file again: one copy while it’s still there, sent again once it was deleted on the PC', async () => {
  await reset();
  const data = randomFile(3 * MB), q = { name: 'IMG_7.jpg', size: data.length, uid: 'dev-1.same' };
  assert.equal(await send(q, data), 'IMG_7.jpg');
  // the answer to the last part got lost, or the page reloaded and the same photo was picked again
  assert.deepEqual(await status(q), { name: 'IMG_7.jpg' });
  const r = await part(Object.assign({ offset: 0 }, q), data);
  assert.deepEqual(r.body, { name: 'IMG_7.jpg' });
  assert.deepEqual((await files()).map((f) => f.name), ['IMG_7.jpg'], 'one copy');
  await fetch(s.url + '/files/IMG_7.jpg', { method: 'DELETE' });
  assert.deepEqual(await status(q), { received: 0 }, 'deleted on the PC: it’s sent again');
  assert.equal(await send(q, data), 'IMG_7.jpg');
  assert.equal(sha(fs.readFileSync(path.join(s.data, 'shared', 'IMG_7.jpg'))), sha(data));
});

test('two different files with the same name never merge', async () => {
  await reset();
  const a = randomFile(9 * MB), b = randomFile(9 * MB), c = randomFile(5 * MB);
  // same name and size, different files (the page's uid differs: it includes a sample of the contents)
  const qa = { name: 'image.jpg', size: a.length, uid: 'dev-1.aaaa' }, qb = { name: 'image.jpg', size: b.length, uid: 'dev-1.bbbb' };
  await part(Object.assign({ offset: 0 }, qa), a.subarray(0, 4 * MB));
  await part(Object.assign({ offset: 0 }, qb), b.subarray(0, 2 * MB));
  assert.deepEqual(await status(qa), { received: 4 * MB });
  assert.deepEqual(await status(qb), { received: 2 * MB });
  // same name, same uid, another size: another file too
  const qc = { name: 'image.jpg', size: c.length, uid: 'dev-1.aaaa' };
  assert.deepEqual(await status(qc), { received: 0 });
  // and another phone with the very same uid doesn't see this phone's partial file
  const other = await s.phone('iPhone', 'dev-2');
  assert.deepEqual(await status(qa, other), { received: 0 });
  const names = [await send(qa, a), await send(qb, b), await send(qc, c)];
  assert.deepEqual(names, ['image.jpg', 'image (1).jpg', 'image (2).jpg']);
  for (const [n, d] of [[names[0], a], [names[1], b], [names[2], c]]) assert.equal(sha(fs.readFileSync(path.join(s.data, 'shared', n))), sha(d), n);
});

test('a part cut off part way keeps what arrived, and the file carries on from there (cut 8 times)', async () => {
  await reset();
  const data = randomFile(24 * MB + 11), q = { name: 'long.mov', size: data.length, uid: 'dev-1.cut' };
  await s.api('/api/test/faults', { upCutAfter: 1.5 * MB, upCutCount: 8 });
  let at = 0, cuts = 0;
  for (;;) {
    const r = await part(Object.assign({ offset: at }, q), data.subarray(at, Math.min(data.length, at + 8 * MB))).catch(() => null);
    if (r && r.body && r.body.name) break;
    if (!r) { cuts++; await sleep(50); }
    at = (await status(q)).received; // ask the server: it's the one that knows
  }
  assert.equal(cuts, 8);
  const st = await stats();
  assert.equal(st.upCut, 8);
  assert.ok(st.upBytes < data.length * 1.25, 'bytes sent ' + st.upBytes + ' < 1.25 × ' + data.length);
  assert.equal(sha(fs.readFileSync(path.join(s.data, 'shared', 'long.mov'))), sha(data));
});

test('a newer request takes over from one that hangs (a dead Wi-Fi connection), with no bytes twice', async () => {
  await reset();
  const data = randomFile(6 * MB), q = { name: 'hang.jpg', size: data.length, uid: 'dev-1.hang' };
  // the old connection: says 6 MB are coming, sends 2 MB, then nothing (the phone walked out of the Wi-Fi)
  const old = http.request(s.url + '/upload/part?' + qs(Object.assign({ offset: 0 }, q)), { method: 'POST', agent: false, headers: Object.assign({ 'Content-Length': data.length }, phone) });
  let oldClosed = false;
  old.on('error', () => { oldClosed = true; }); old.on('close', () => { oldClosed = true; });
  old.write(data.subarray(0, 2 * MB));
  await waitFor(async () => (await status(q)).received === 2 * MB, 5000, '2 MB written');
  // the phone is back and carries on from 2 MB: the old request is stopped first, then this one writes
  const r = await part(Object.assign({ offset: 2 * MB }, q), data.subarray(2 * MB));
  assert.deepEqual(r.body, { name: 'hang.jpg' });
  await waitFor(() => oldClosed, 3000, 'the old connection closed');
  old.write(data.subarray(2 * MB, 3 * MB), () => {}); // late bytes from it go nowhere
  await sleep(300);
  assert.equal(sha(fs.readFileSync(path.join(s.data, 'shared', 'hang.jpg'))), sha(data));
});

test('stale partial files are deleted after a while without progress, and never listed', async () => {
  await reset();
  await s.api('/api/test/faults', { partIdle: 800 });
  const data = randomFile(2 * MB), q = { name: 'gone.jpg', size: data.length, uid: 'dev-1.stale' };
  await part(Object.assign({ offset: 0 }, q), data.subarray(0, MB));
  assert.equal((await stats()).partials, 1);
  assert.deepEqual(await files(), []);
  await waitFor(async () => (await stats()).partials === 0, 5000, 'the stale partial file deleted');
  assert.deepEqual(await status(q), { received: 0 }, 'it starts over');
  assert.deepEqual(await files(), []);
});

test('disk full part way: 507, and the partial file is deleted to give the space back', async () => {
  await reset();
  await s.api('/api/test/faults', { upFullAfter: 3 * MB });
  const data = randomFile(8 * MB), q = { name: 'full.mov', size: data.length, uid: 'dev-1.full' };
  const r = await part(Object.assign({ offset: 0 }, q), data);
  assert.equal(r.status, 507);
  assert.equal(r.body.error, 'disk full');
  await waitFor(async () => (await stats()).partials === 0, 3000, 'no partial file left');
  assert.deepEqual(await files(), []);
  // and with the disk full from the start
  await s.api('/api/test/faults', { diskFull: true });
  assert.equal((await part(Object.assign({ offset: 0 }, q), data)).status, 507);
  await s.api('/api/test/faults', { diskFull: false });
});

test('cancel throws the partial file away; bad requests are refused; unpaired phones are kept out', async () => {
  await reset();
  const data = randomFile(MB), q = { name: 'c.jpg', size: data.length, uid: 'dev-1.cancel' };
  await part(Object.assign({ offset: 0 }, q), data.subarray(0, MB / 2));
  assert.equal((await stats()).partials, 1);
  const d = await request(s.url + '/upload/part?' + qs(q), { method: 'DELETE', headers: phone });
  assert.equal(d.status, 200);
  await waitFor(async () => (await stats()).partials === 0, 3000, 'partial file removed');
  assert.deepEqual(await status(q), { received: 0 });
  for (const bad of [{ name: 'x', size: 10 }, { name: 'x', size: -1, uid: 'dev-1.x' }, { name: 'x', size: 'lots', uid: 'dev-1.x' }, { name: 'x', size: 10, uid: '../../etc' }]) {
    assert.equal((await request(s.url + '/upload/part?' + qs(bad), { headers: phone })).status, 400, JSON.stringify(bad));
  }
  const stranger = { 'x-phonedrop-phone': '1' };
  assert.equal((await request(s.url + '/upload/part?' + qs(q), { headers: stranger })).status, 401);
  assert.equal((await request(s.url + '/upload/part?' + qs(Object.assign({ offset: 0 }, q)), { body: data, headers: stranger })).status, 401);
  assert.equal((await stats()).partials, 0);
});

test('this PC sends in parts too; an empty file works', async () => {
  await reset();
  const data = randomFile(MB + 1), q = { name: 'from pc.bin', size: data.length, uid: 'pc-1.x1' };
  assert.equal(await send(q, data, {}), 'from pc.bin');
  assert.equal((await files())[0].from, '');
  assert.equal(await send({ name: 'empty.txt', size: 0, uid: 'pc-1.e0' }, Buffer.alloc(0), {}), 'empty.txt');
  assert.equal(fs.statSync(path.join(s.data, 'shared', 'empty.txt')).size, 0);
});

// The folder zip the page builds (makeZip in public/index.html, between "zip:begin" and "zip:end"), run here in
// Node: checked with our own reader (every CRC and SHA-256) and with Python's zipfile when Python is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT, tmpDir, sha, randomFile, readZip, pythonZip } from './helpers.mjs';

const page = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const code = page.slice(page.indexOf('/* zip:begin'), page.indexOf('/* zip:end */'));
const { makeZip, zipCrc } = new Function(code + '\nreturn { makeZip: makeZip, zipCrc: zipCrc };')();

// a pretend file of zeros, as big as you like: nothing is held in memory, and it's left as a hole in the zip file
function zeros(size) {
  const piece = new ArrayBuffer(1 << 22); // the zip reads 4 MB at a time: hand out the same zeros every time
  return { size, lastModified: Date.UTC(2024, 5, 1), zero: true, slice: (a, b) => ({ arrayBuffer: async () => (b - a === piece.byteLength ? piece : new ArrayBuffer(b - a)) }) };
}
// write the zip: header bytes and files at their offsets (zero files stay a sparse hole)
async function writeZip(z, file) {
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, z.size);
  let at = 0;
  for (const p of z.parts) {
    if (p instanceof ArrayBuffer) { fs.writeSync(fd, Buffer.from(p), 0, p.byteLength, at); at += p.byteLength; continue; }
    if (!p.zero) for (let o = 0; o < p.size; o += 1 << 22) { const b = Buffer.from(await p.slice(o, Math.min(p.size, o + (1 << 22))).arrayBuffer()); fs.writeSync(fd, b, 0, b.length, at + o); }
    at += p.size;
  }
  fs.closeSync(fd);
  assert.equal(at, z.size, 'parts add up to the size it says');
}

test('CRC-32 matches zlib’s, at every length and in pieces', () => {
  for (let n = 0; n < 40; n++) { const b = randomFile(n); assert.equal(zipCrc(0, b), zlib.crc32(b), n + ' bytes'); }
  const b = randomFile(100003);
  assert.equal(zipCrc(0, b), zlib.crc32(b));
  assert.equal(zipCrc(zipCrc(0, b.subarray(0, 1235)), b.subarray(1235)), zlib.crc32(b), 'in pieces');
});

test('a folder zip: subfolders kept, every file byte-identical, unicode names, empty files and folders', async () => {
  const when = Date.UTC(2023, 7, 15, 10, 30);
  const files = {
    'Holiday/IMG_0001.jpg': randomFile(3 * 1048576 + 5),
    'Holiday/notes.txt': Buffer.from('a note\n'),
    'Holiday/empty.txt': Buffer.alloc(0),
    'Holiday/Strand 🏖/Sonnenuntergang über dem Meer.jpg': randomFile(700000),
    'Holiday/Strand 🏖/日本/写真.png': randomFile(12345),
  };
  const entries = ['Holiday/', 'Holiday/Strand 🏖/', 'Holiday/Strand 🏖/日本/', 'Holiday/empty folder/'].map((p) => ({ path: p, dir: true }))
    .concat(Object.entries(files).map(([p, b]) => ({ path: p, file: new File([b], path.basename(p), { lastModified: when }) })));
  const seen = [];
  const z = await makeZip(entries, (d, t) => seen.push([d, t]));
  assert.ok(seen.length >= 2 && seen[seen.length - 1][0] === seen[seen.length - 1][1], 'progress up to 100%');
  const out = path.join(tmpDir('zip'), 'Holiday.zip');
  await writeZip(z, out);
  const list = readZip(out);
  assert.deepEqual(list.map((e) => e.name), entries.map((e) => e.path));
  for (const e of list) {
    assert.equal(e.method, 0, 'stored, not compressed');
    assert.ok(e.flags & 0x0800, 'names in UTF-8');
    if (e.dir) { assert.equal(e.size, 0); continue; }
    const data = e.read();
    assert.equal(sha(data), sha(files[e.name]), e.name);
    assert.equal(e.crc, zlib.crc32(data), e.name);
  }
  const py = pythonZip(out);
  if (py) {
    assert.deepEqual(py.names, entries.map((e) => e.path), 'Python zipfile sees the same');
    for (const [n, b] of Object.entries(files)) assert.equal(py.sha[n], sha(b), 'Python: ' + n);
  }
  // stored: a folder of photos only gets header bytes on top
  const sum = Object.values(files).reduce((a, b) => a + b.length, 0);
  assert.ok(z.size - sum < 2000, 'only headers added: ' + (z.size - sum) + ' bytes');
});

test('cancel stops it', async () => {
  let n = 0;
  await assert.rejects(makeZip([{ path: 'a.bin', file: new File([randomFile(9 * 1048576)], 'a.bin') }], null, () => ++n > 1), /cancelled/);
});

test('ZIP64: a file over 4 GB, and a file after it (offset over 4 GB)', { timeout: 300000 }, async () => {
  const big = 0x100000000 + 10;
  const entries = [{ path: 'Big/', dir: true }, { path: 'Big/movie.mov', file: zeros(big) }, { path: 'Big/after.txt', file: new File([Buffer.from('still here')], 'after.txt') }];
  const z = await makeZip(entries);
  const out = path.join(tmpDir('zip64'), 'Big.zip');
  await writeZip(z, out); // sparse: takes almost no disk space
  const list = readZip(out);
  assert.deepEqual(list.map((e) => [e.name, e.size]), [['Big/', 0], ['Big/movie.mov', big], ['Big/after.txt', 10]]);
  assert.ok(list[2].data > 0xFFFFFFFF, 'the last file starts past 4 GB');
  assert.equal(list[2].read().toString(), 'still here');
  // the CRC of 4 GB of zeros, as zlib works it out
  let crc = 0; const zero = Buffer.alloc(1 << 24);
  for (let left = big; left > 0; left -= zero.length) crc = zlib.crc32(zero.subarray(0, Math.min(zero.length, left)), crc);
  assert.equal(list[1].crc, crc);
  const py = pythonZip(out, 1048576); // Python reads the ZIP64 records and the small file (not the 4 GB of zeros)
  if (py) { assert.deepEqual(py.names, ['Big/', 'Big/movie.mov', 'Big/after.txt']); assert.equal(py.sha['Big/after.txt'], sha(Buffer.from('still here'))); }
  fs.rmSync(out, { force: true });
});

test('ZIP64: more than 65,535 entries', { timeout: 120000 }, async () => {
  const entries = [];
  for (let i = 0; i < 65600; i++) entries.push({ path: 'Many/' + i + '.txt', file: new File([String(i)], i + '.txt') });
  const z = await makeZip(entries);
  const out = path.join(tmpDir('zipmany'), 'Many.zip');
  await writeZip(z, out);
  const list = readZip(out);
  assert.equal(list.length, 65600);
  assert.equal(list[65599].name, 'Many/65599.txt');
  assert.equal(list[65599].read().toString(), '65599');
  const py = pythonZip(out);
  if (py) { assert.equal(py.names.length, 65600); assert.equal(py.sha['Many/65599.txt'], sha(Buffer.from('65599'))); }
  fs.rmSync(out, { force: true });
});

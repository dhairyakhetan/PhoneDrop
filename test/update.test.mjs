// In-app updates against test mode's pretend GitHub: quick updates (app files only), the full installer, and
// everything that can go wrong on the way. Real Windows still needs a manual check of the UAC prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { startServer, upload, events, waitFor, sleep, randomFile, ROOT } from './helpers.mjs';

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const info = async (s) => (await s.api('/api/info').catch(() => ({ body: null }))).body;
const version = async (s) => { const i = await info(s); return i && i.version; };
const install = (s) => s.api('/api/update/install', {});
async function stateIs(s, ...states) {
  return waitFor(async () => { const i = await info(s); return i && i.update && states.includes(i.update.state) && i.update; }, 20000, 'update state ' + states.join('/'));
}
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };

test('nothing to offer: no release, the same version, an older one, or one CI is still building', async () => {
  const s = await startServer();
  try {
    assert.equal((await info(s)).update, null);
    for (const v of [PKG.version, '0.0.1']) {
      const r = await s.api('/api/test/release', { version: v });
      assert.equal(r.body.update, null, v);
    }
    assert.equal((await s.api('/api/test/release', { version: '9.0.0', building: true })).body.update, null);
  } finally { await s.stop(); }
});

test('a release with only the installer: offered with its size, not as a quick update', async () => {
  const s = await startServer();
  try {
    const ev = events(s.url);
    const u = (await s.api('/api/test/release', { version: '9.0.0', notes: '## New\n- **Faster**' })).body.update;
    assert.equal(u.version, '9.0.0');
    assert.equal(u.quick, false);
    assert.equal(u.size, 3 * 1048576);
    assert.equal(u.notes, '## New\n- **Faster**'); // only what's above <!-- install -->
    assert.equal((await ev.next('update', (d) => d)).version, '9.0.0'); // the PC page hears about it straight away
    ev.close();
  } finally { await s.stop(); }
});

test('quick update: a few KB, restarts into the new version, keeps the shared files', async () => {
  const s = await startServer();
  try {
    await upload(s.url, 'keep me.jpg', randomFile(1000));
    const u = (await s.api('/api/test/release', { version: '9.0.0', quick: true })).body.update;
    assert.equal(u.quick, true);
    assert.ok(u.size > 10000 && u.size < 400000, 'quick update is ' + u.size + ' bytes');
    const ev = events(s.url);
    await ev.next('update');
    assert.equal((await install(s)).status, 200);
    assert.equal((await ev.next('update', (d) => d && d.state === 'restarting')).quick, true);
    assert.equal(await s.exited, 0, 'the old copy steps aside');
    await waitFor(async () => (await version(s)) === '9.0.0', 15000, 'version 9.0.0');
    assert.deepEqual((await s.api('/api/files')).body.map((f) => f.name), ['keep me.jpg']);
    const app = path.join(s.data, 'app', '9.0.0');
    assert.equal(JSON.parse(read(path.join(app, 'manifest.json'))).base, 'test');
    assert.equal(JSON.parse(read(path.join(app, 'package.json'))).version, '9.0.0');
    assert.equal(read(path.join(app, 'starts.txt')), '0', 'counted as a good start');
    assert.match(read(path.join(s.data, 'update-log.txt')), /quick update to 9\.0\.0: running/);
    assert.equal((await info(s)).update, null, 'nothing newer now');
    // it's the downloaded copy that runs: its server.js is the one in app/9.0.0
    assert.ok(fs.existsSync(path.join(app, 'server.js')));
    // and again on the next start (the built-in copy hands over to it every time)
    await s.api('/api/test/quit', {});
    await sleep(300);
    const again = await startServer({ data: s.data, port: s.port, env: { PHONEDROP_TEST_APP: '1', KEEP: '1' } });
    assert.equal(await version(again), '9.0.0');
    await again.stop();
  } finally { await s.stop(); }
});

test('the bundle is the app files and nothing else', async () => {
  const quick = (await import('../scripts/quick-update.js')).default;
  const b = JSON.parse(zlib.gunzipSync(quick.make(ROOT, { version: '9.9.9', base: 'abc' })));
  assert.equal(b.format, 1);
  assert.deepEqual(Object.keys(b.files).sort(), ['server.js'].concat(quick.ASSETS).sort());
  assert.equal(JSON.parse(b.files['package.json'][1]).version, '9.9.9');
  assert.equal(Buffer.from(b.files['public/icon.png'][1], 'base64').subarray(1, 4).toString(), 'PNG');
  assert.equal(b.files['public/index.html'][1], fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'));
  // every file server.js reads with asset() is in it (and so in the exe)
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  for (const m of src.matchAll(/asset\('([^']+)'/g)) assert.ok(quick.ASSETS.includes(m[1]), m[1] + ' missing from scripts/quick-update.js');
  assert.match(quick.base(ROOT, '22.1.0'), /^[0-9a-f]{12}$/);
  assert.notEqual(quick.base(ROOT, '22.1.0'), quick.base(ROOT, '24.0.0'), 'another Node version needs the installer');
  assert.equal(quick.base(ROOT, '22.1.0'), quick.base(ROOT, '22.9.9'));
});

test('quick update that crashes on start: back to the old version, never used again', async () => {
  const s = await startServer();
  try {
    await upload(s.url, 'keep.jpg', randomFile(10));
    await s.api('/api/test/release', { version: '9.0.0', quick: 'broken', uac: 'no' });
    await install(s);
    const u = await stateIs(s, 'failed');
    assert.match(u.error, /quick update didn’t start/);
    assert.equal(u.quick, false, 'next time: the installer');
    assert.equal(await version(s), PKG.version);
    assert.match(read(path.join(s.data, 'app', 'bad.txt')), /^9\.0\.0$/m);
    assert.ok(!fs.existsSync(path.join(s.data, 'app', '9.0.0')));
    assert.deepEqual((await s.api('/api/files')).body.map((f) => f.name), ['keep.jpg']);
    assert.equal(s.proc.exitCode, null, 'the old copy is still the one running');
    // Try again -> the installer (here the Windows prompt is answered No)
    await install(s);
    assert.equal((await stateIs(s, 'cancelled')).quick, false);
    // a later check doesn't offer the broken quick update again
    assert.equal((await s.api('/api/test/release', { version: '9.0.0', quick: true })).body.update.quick, false);
  } finally { await s.stop(); }
});

test('quick update that never gets going: given up after the wait, old version carries on', async () => {
  const s = await startServer();
  try {
    await s.api('/api/test/release', { version: '9.0.0', quick: 'hang' });
    await install(s);
    await stateIs(s, 'restarting');
    const u = await waitFor(async () => { const i = await info(s); return i && i.update && i.update.state === 'failed' && i.update; }, 25000, 'failed');
    assert.match(u.error, /didn’t start/);
    assert.match(read(path.join(s.data, 'update-log.txt')), /didn’t start in time/);
    assert.equal(await version(s), PKG.version);
  } finally { await s.stop(); }
});

test('a quick update made for another PhoneDrop.exe (other Node or installer) isn’t used: the installer is', async () => {
  const s = await startServer();
  try {
    const u = (await s.api('/api/test/release', { version: '9.0.0', quick: 'other', uac: 'no' })).body.update;
    assert.equal(u.quick, false);
    await install(s);
    await stateIs(s, 'cancelled');
    assert.ok(!fs.existsSync(path.join(s.data, 'app', '9.0.0')));
  } finally { await s.stop(); }
});

test('damaged download (checksum mismatch): nothing is installed', async () => {
  const s = await startServer();
  try {
    await s.api('/api/test/release', { version: '9.0.0', quick: true, badSum: true });
    await install(s);
    const u = await stateIs(s, 'failed');
    assert.match(u.error, /checksum/);
    assert.ok(!fs.existsSync(path.join(s.data, 'app', '9.0.0')));
    assert.equal(await version(s), PKG.version);
  } finally { await s.stop(); }
});

test('installer: progress while downloading, then Windows prompt answered No → "cancelled", Try again works', async () => {
  const s = await startServer();
  try {
    await s.api('/api/test/release', { version: '9.0.0', uac: 'no', bps: 4 * 1048576 });
    const ev = events(s.url);
    await install(s);
    const p = await ev.next('update-progress', (d) => d.got > 0 && d.got < d.total);
    assert.equal(p.total, 3 * 1048576);
    assert.equal((await ev.next('update-progress', (d) => d.got === d.total)).got, 3 * 1048576);
    await ev.next('update', (d) => d && d.state === 'installing');
    assert.equal((await ev.next('update', (d) => d && d.state === 'cancelled')).error, '');
    assert.equal((await install(s)).status, 200);
    await stateIs(s, 'downloading', 'installing');
    ev.close();
  } finally { await s.stop(); }
});

test('installer that doesn’t start → "failed"', async () => {
  const s = await startServer();
  try {
    await s.api('/api/test/release', { version: '9.0.0', uac: 'fail' });
    await install(s);
    assert.match((await stateIs(s, 'failed')).error, /installer didn’t start/);
  } finally { await s.stop(); }
});

test('download that stops half way → "failed: the download stopped", nothing left behind', async () => {
  const s = await startServer();
  try {
    await s.api('/api/test/release', { version: '9.0.0', stall: true });
    await install(s);
    assert.equal((await stateIs(s, 'failed')).error, 'the download stopped');
  } finally { await s.stop(); }
});

test('installer: Yes → PhoneDrop quits, the installer reopens the new version with the shared files kept', async () => {
  const s = await startServer();
  try {
    await upload(s.url, 'still here.jpg', randomFile(10));
    await s.api('/api/test/release', { version: '9.0.0', uac: 'yes' });
    await install(s);
    await stateIs(s, 'restarting');
    assert.equal(await s.exited, 0);
    await waitFor(async () => (await version(s)) === '9.0.0', 20000, 'version 9.0.0 after the installer');
    assert.deepEqual((await s.api('/api/files')).body.map((f) => f.name), ['still here.jpg']);
    assert.ok(!fs.existsSync(path.join(s.data, 'updated.txt')), 'updated.txt is used up');
  } finally { await s.stop(); }
});

test('two releases out: Update now installs the newest, not the one the banner showed first', async () => {
  const s = await startServer();
  try {
    await s.api('/api/test/release', { version: '9.0.0', quick: true });
    await s.api('/api/test/release', { version: '9.1.0', quick: true, quiet: true }); // 9.1.0 came out since
    assert.equal((await info(s)).update.version, '9.0.0');
    await install(s);
    await waitFor(async () => (await version(s)) === '9.1.0', 20000, 'version 9.1.0');
    assert.ok(!fs.existsSync(path.join(s.data, 'app', '9.0.0')));
  } finally { await s.stop(); }
});

test('Update now while one is running doesn’t start a second', async () => {
  const s = await startServer();
  try {
    await s.api('/api/test/release', { version: '9.0.0', uac: 'no', bps: 1048576 });
    await install(s); await install(s); await install(s);
    await stateIs(s, 'cancelled');
    const stats = (await s.api('/api/test/stats')).body;
    assert.ok(stats.requests > 0);
    assert.equal((s.log.match(/Update failed|Quick update didn’t work/g) || []).length, 0);
  } finally { await s.stop(); }
});

test('start-up picks the right downloaded copy (and never a broken, older or foreign one)', async () => {
  const data = (await import('./helpers.mjs')).tmpDir('loader');
  const apps = path.join(data, 'app');
  const quick = (await import('../scripts/quick-update.js')).default;
  const put = (v, o = {}) => {
    const b = JSON.parse(zlib.gunzipSync(quick.make(ROOT, { version: v, base: o.base || 'test', extra: ['testmode.js', 'scripts/quick-update.js'] })));
    const dir = path.join(apps, v);
    for (const [rel, [enc, d]] of Object.entries(b.files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), Buffer.from(d, enc)); }
    if (!o.noManifest) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: v, base: o.base || 'test' }));
    if (o.starts) fs.writeFileSync(path.join(dir, 'starts.txt'), String(o.starts));
  };
  const run = async () => { const s = await startServer({ data, env: { PHONEDROP_TEST_APP: '1' } }); const v = await version(s); await s.stop(); return v; };
  put('0.0.9');                         // older than this copy
  put('9.0.0', { base: 'elsewhere' });  // made for another exe
  put('9.1.0', { noManifest: true });   // half unpacked
  assert.equal(await run(), PKG.version);
  put('9.2.0', { starts: 3 });          // failed to start 3 times in a row
  assert.equal(await run(), PKG.version);
  assert.match(read(path.join(apps, 'bad.txt')), /9\.2\.0/);
  put('9.3.0');
  put('9.4.0');
  assert.equal(await run(), '9.4.0', 'the newest good one');
  assert.equal(await run(), '9.4.0', 'and again (its start counter was reset)');
  // without the test switch, `node server.js` always runs the files you're editing
  const plain = await startServer({ data });
  assert.equal(await version(plain), PKG.version);
  await plain.stop();
});

// The page in a real browser (Chromium): PC and phones (iPhone and Android are emulated: user agent, touch,
// screen size; the iPhone share sheet is replaced by a stub that hashes what it's given).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, browser, browserWith, closeBrowser, waitFor, sleep, sha, IOS_UA, ANDROID_UA, upload, randomFile, tmpDir, readZip, pythonZip } from './helpers.mjs';

let s;
before(async () => { s = await startServer(); await browser(); });
after(async () => { await s.stop(); await closeBrowser(); });

const shaOf = (name) => sha(fs.readFileSync(path.join(s.data, 'shared', name)));
const reset = async () => { await s.api('/api/test/reset', {}); await sleep(100); };
const stats = async () => (await s.api('/api/test/stats')).body;
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim());
const dock = (page) => text(page, '#t1');

// iPhone's share sheet, replaced: remembers the SHA-256 of every file it's given
function shareStub() {
  window.__shared = []; window.__shareCalls = 0;
  navigator.canShare = () => true;
  navigator.share = async (d) => {
    window.__shareCalls++;
    for (const f of d.files) {
      const h = await crypto.subtle.digest('SHA-256', await f.arrayBuffer());
      window.__shared.push({ name: f.name, size: f.size, sha: [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('') });
    }
  };
}
const contexts = [];
async function open(kind, o = {}) {
  const b = await browser();
  const phone = kind === 'iphone' || kind === 'android';
  const ctx = await b.newContext(Object.assign(phone
    ? { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, userAgent: kind === 'iphone' ? IOS_UA : ANDROID_UA }
    : { viewport: { width: 1440, height: 900 } }, { acceptDownloads: true, colorScheme: o.scheme || 'dark' }, o.ctx || {}));
  contexts.push(ctx);
  if (kind === 'iphone' && o.stub !== false) await ctx.addInitScript(shareStub);
  if (o.init) await ctx.addInitScript(o.init);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.downloads = [];
  page.on('download', async (d) => { const p = await d.path(); page.downloads.push({ name: d.suggestedFilename(), sha: sha(fs.readFileSync(p)) }); });
  // phones open the QR code's link (it pairs them), unless a test wants an unpaired one
  await page.goto(s.url + (o.path || (phone && !o.unpaired ? '/#p=' + (await s.pairCode()) : '/')));
  return page;
}
async function closeAll() { while (contexts.length) await contexts.pop().close().catch(() => {}); }
async function offline(page, on) {
  const cdp = page._cdp || (page._cdp = await page.context().newCDPSession(page));
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
}
const samples = async (o) => (await s.api('/api/test/samples', o)).body.added;

test('PC: test badge, SVG logo, debug panel switches the network and adds phones', async () => {
  await reset();
  const pc = await open('pc');
  await pc.waitForSelector('.tbadge');
  assert.equal(await pc.$eval('.logo', (e) => e.getAttribute('src')), '/icon.svg');
  assert.equal(await pc.$eval('link[rel=icon]', (e) => e.getAttribute('href')), '/icon.svg');
  await pc.click('.tbadge');
  await pc.waitForSelector('#tNet');
  await pc.selectOption('#tNet', 'iphone-hotspot');
  await waitFor(async () => /hotspot Dhairya’s iPhone/.test(await text(pc, '#netLine')), 8000, 'hotspot line');
  await pc.selectOption('#tNet', 'none');
  await waitFor(async () => /Not connected to a network/.test(await text(pc, '#cT')), 8000, 'no network');
  await pc.selectOption('#tNet', 'busy');
  await waitFor(async () => /Wi-Fi HomeNet/.test(await text(pc, '#netLine')), 8000, 'Wi-Fi line');
  assert.match(await text(pc, '#link'), /^http:\/\/192\.168\.1\.23:/);
  await pc.click('button[data-a=iphone]'); // a pretend iPhone asks to connect: the PC shows Allow / Block
  await pc.waitForSelector('#preqs .preq');
  assert.equal(await text(pc, '#preqs .preq b'), 'Allow iPhone to connect?');
  await pc.click('#preqs [data-allow]');
  await pc.waitForSelector('#slim:not([hidden])');
  assert.equal(await pc.$$eval('#preqs .preq', (x) => x.length), 0);
  assert.equal(await text(pc, '#slimT'), 'iPhone connected');
  await pc.click('button[data-a=nophones]');
  await pc.waitForSelector('#hero:not([hidden])', { timeout: 15000 });
  await pc.click('button[data-a=photos]');
  await pc.waitForFunction(() => document.querySelectorAll('#grid .tile').length === 6);
  assert.deepEqual(pc.errors, []);
  await s.api('/api/test/net', { preset: 'real' });
  await closeAll();
});

test('iPhone: one tap shares every photo, byte-identical to the originals', async () => {
  await reset();
  const names = await samples({ photos: 5 });
  const ip = await open('iphone');
  await waitFor(async () => (await dock(ip)) === 'Save all 5 to Photos', 15000, 'Save all 5');
  await ip.click('#save');
  await ip.waitForFunction(() => window.__shared.length === 5);
  const shared = await ip.evaluate(() => window.__shared);
  for (const f of shared) assert.equal(f.sha, shaOf(f.name), f.name);
  assert.deepEqual(shared.map((f) => f.name).sort(), names.slice().sort());
  await waitFor(async () => (await dock(ip)) === 'All saved', 5000, 'All saved');
  assert.equal(await ip.$$eval('#grid .tile.saved', (t) => t.length), 5);
  // the PC sees which ones a phone saved
  assert.ok((await s.api('/api/files')).body.every((f) => f.saved === 1));
  assert.deepEqual(ip.errors, []);
  await closeAll();
});

test('downloads cut off part way carry on where they stopped (no starting over), bytes identical', async () => {
  await reset();
  await samples({ photos: 6 });
  const total = (await s.api('/api/files')).body.reduce((a, f) => a + f.size, 0);
  await s.api('/api/test/throttle', { bps: 4 * 1048576 });
  await s.api('/api/test/faults', { cutAfter: 150000, cutCount: 8 });
  const before = await stats();
  const ip = await open('iphone');
  await waitFor(async () => (await dock(ip)) === 'Save all 6 to Photos', 40000, 'Save all 6');
  const after = await stats();
  await ip.click('#save');
  await ip.waitForFunction(() => window.__shared.length === 6);
  for (const f of await ip.evaluate(() => window.__shared)) assert.equal(f.sha, shaOf(f.name), f.name);
  assert.equal(after.cut - before.cut, 8, '8 downloads were cut off');
  assert.ok(after.ranges - before.ranges >= 8, 'and resumed with Range: ' + (after.ranges - before.ranges));
  const sent = after.bytesSent - before.bytesSent;
  assert.ok(sent < total * 1.25, 'sent ' + sent + ' bytes for ' + total + ' (starting over would be ~' + Math.round(total + 8 * 150000) + ')');
  await s.api('/api/test/throttle', { bps: 0 });
  await closeAll();
});

test('Android: Wi-Fi drops mid-download, it carries on by itself; one tap saves all to Downloads', async () => {
  await reset();
  await samples({ photos: 4, photoMB: 3 });
  await s.api('/api/test/throttle', { bps: 1048576 });
  const an = await open('android');
  await waitFor(async () => /Getting 4 photos ready… [1-9]/.test(await dock(an)), 15000, 'download going');
  await offline(an, true);
  await sleep(1500);
  await offline(an, false);
  await s.api('/api/test/throttle', { bps: 0 });
  await waitFor(async () => (await dock(an)) === 'Save all 4 to phone', 30000, 'Save all 4 (dock: ' + await dock(an) + ')');
  await an.click('#save');
  await waitFor(() => an.downloads.length === 4, 10000, '4 downloads');
  for (const d of an.downloads) assert.equal(d.sha, shaOf(d.name), d.name);
  await waitFor(async () => (await dock(an)) === 'All saved', 5000, 'All saved');
  assert.deepEqual(an.errors, []);
  await closeAll();
});

test('a download that keeps failing says so, and Tap to try again finishes it', async () => {
  await reset();
  await samples({ photos: 1 });
  await s.api('/api/test/faults', { cutAfter: 0, cutCount: 1000 }); // every download dies before its first byte
  const ip = await open('iphone', { init: () => { window.PD_RETRY = [50, 50, 50, 50, 50, 50]; } });
  await waitFor(async () => /Reconnecting/.test(await dock(ip)), 10000, 'Reconnecting… while it retries');
  await waitFor(async () => (await dock(ip)) === 'Download didn’t finish', 15000, '"Download didn’t finish"');
  assert.equal(await text(ip, '#t2'), 'Tap to try again');
  await s.api('/api/test/faults', { cutCount: 0 });
  await ip.click('#save');
  await waitFor(async () => (await dock(ip)) === 'Save photo to Photos', 15000, 'ready after Tap to try again');
  await ip.click('#save');
  await ip.waitForFunction(() => window.__shared.length === 1);
  await closeAll();
});

test('phone viewer: a photo downloads once, is shown from that download and saved from it', async () => {
  await reset();
  const [name] = await samples({ photos: 3 });
  const an = await open('android');
  const hits = [];
  an.on('request', (r) => { if (r.url().includes('/files/' + encodeURIComponent(name))) hits.push(r.url()); });
  await an.click('#grid .tile[data-name="' + name + '"]');
  await an.waitForFunction(() => document.getElementById('lbSave').textContent.trim() === 'Save to phone', null, { timeout: 15000 });
  await an.click('#lbSave');
  await waitFor(() => an.downloads.length === 1, 5000, 'saved');
  assert.equal(an.downloads[0].sha, shaOf(name));
  assert.equal(hits.length, 1, 'downloaded ' + hits.length + ' times');
  assert.match(await text(an, '#lbMeta'), /Saved/);
  await closeAll();
});

test('viewer: the batch pauses while you look at a photo, then carries on without starting over', async () => {
  await reset();
  await samples({ photos: 6, photoMB: 4 });
  const total = (await s.api('/api/files')).body.reduce((a, f) => a + f.size, 0);
  await s.api('/api/test/throttle', { bps: 1048576 });
  const ip = await open('iphone');
  await waitFor(async () => /ready… ([2-9]\d|1\d)%/.test(await dock(ip)), 30000, 'batch at 10%+');
  const before = await stats();
  await ip.click('#grid .tile:nth-child(6)');
  await sleep(800);
  const running = await ip.evaluate(() => { let n = 0; window.PD.dls.forEach((d) => { if (d.ctl) n++; }); return n; });
  assert.ok(running <= 1, running + ' downloads running while the viewer is open (only the photo shown should)');
  await ip.click('#lbX');
  await s.api('/api/test/throttle', { bps: 0 });
  await waitFor(async () => (await dock(ip)) === 'Save all 6 to Photos', 30000, 'Save all 6');
  const after = await stats();
  assert.ok(after.ranges > before.ranges, 'paused downloads resumed with Range');
  assert.ok(after.bytesSent < total * 1.3, 'sent ' + after.bytesSent + ' for ' + total);
  await ip.click('#save');
  await ip.waitForFunction(() => window.__shared.length === 6);
  for (const f of await ip.evaluate(() => window.__shared)) assert.equal(f.sha, shaOf(f.name), f.name);
  await closeAll();
});

test('big video: only downloads when you tap, shows progress, can be cancelled', async () => {
  await reset();
  await samples({ big: 310 });
  await s.api('/api/test/throttle', { bps: 30 * 1048576 });
  const ip = await open('iphone');
  await waitFor(async () => (await dock(ip)) === 'Save video to Photos', 10000, 'Save video');
  assert.match(await text(ip, '#t2'), /310\.0 MB/);
  await sleep(1000);
  assert.equal((await stats()).downloads, 0, 'nothing downloads by surprise');
  await ip.click('#save');
  await waitFor(async () => /^Downloading video… \d+%$/.test(await dock(ip)), 10000, 'progress');
  assert.equal(await ip.$eval('#cancelBtn', (b) => b.hidden), false);
  await ip.click('#cancelBtn');
  await waitFor(async () => (await dock(ip)) === 'Save video to Photos', 5000, 'back to Save video');
  await s.api('/api/test/throttle', { bps: 0 });
  await closeAll();
});

test('phone → PC: Android sends a photo, the PC downloads it, both show it as transferred', async () => {
  await reset();
  const pc = await open('pc');
  const an = await open('android');
  await pc.waitForSelector('#slim:not([hidden])');
  const tmp = path.join(s.data, 'from phone.jpg');
  fs.writeFileSync(tmp, randomFile(200000));
  await an.setInputFiles('#pickPhone', tmp);
  const tile = '#grid .tile[data-name="from phone.jpg"]';
  await pc.waitForSelector(tile + '.inc', { timeout: 10000 });
  assert.match(await pc.$eval(tile, (t) => t.title), /From Android phone · not downloaded/);
  assert.equal(await text(pc, '#getBtn'), 'Download from phone (1)');
  await an.waitForSelector(tile + '.out');
  assert.equal(await dock(an), 'Send files to computer', 'its own photo isn’t offered back to it');
  await pc.click('#getBtn');
  await waitFor(() => pc.downloads.length === 1, 10000, 'PC download');
  assert.equal(pc.downloads[0].sha, sha(fs.readFileSync(tmp)));
  await pc.waitForSelector(tile + '.saved');
  await an.waitForSelector(tile + '.saved', { timeout: 10000 });
  assert.match(await text(an, '#t2'), /all saved on computer/);
  assert.deepEqual(pc.errors.concat(an.errors), []);
  await closeAll();
});

test('phone → PC: the Wi-Fi drops while sending, it sends again by itself (once, intact)', async () => {
  await reset();
  const an = await open('android');
  const cdp = await an.context().newCDPSession(an);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 1048576 });
  const tmp = path.join(s.data, 'video.mp4');
  fs.writeFileSync(tmp, randomFile(3 * 1048576));
  await an.setInputFiles('#pickPhone', tmp);
  await sleep(1200);
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(800);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await waitFor(async () => (await s.api('/api/files')).body.length === 1, 20000, 'the file arrives');
  await sleep(5500); // a copy waiting for its thumbnail would show up by now
  const list = (await s.api('/api/files')).body;
  assert.deepEqual(list.map((f) => f.name), ['video.mp4'], 'once, no half copy');
  assert.equal(shaOf('video.mp4'), sha(fs.readFileSync(tmp)));
  await an.waitForFunction(() => /Sent 1 file/.test(document.getElementById('upT').textContent), null, { timeout: 10000 });
  await closeAll();
});

test('PC: drop files on the window to send them, with byte-identical results', async () => {
  await reset();
  const pc = await open('pc');
  const datas = [randomFile(300000), randomFile(5000)];
  await pc.evaluate(async (arr) => {
    const dt = new DataTransfer();
    arr.forEach((a, i) => dt.items.add(new File([new Uint8Array(a)], i ? 'notes.txt' : 'dropped.jpg', { type: i ? 'text/plain' : 'image/jpeg' })));
    const ev = (t) => new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true });
    window.dispatchEvent(ev('dragenter')); window.dispatchEvent(ev('dragover')); window.dispatchEvent(ev('drop'));
  }, datas.map((d) => [...d]));
  await pc.waitForFunction(() => document.querySelectorAll('#grid .tile').length === 2, null, { timeout: 15000 });
  assert.equal(shaOf('dropped.jpg'), sha(datas[0]));
  assert.equal(shaOf('notes.txt'), sha(datas[1]));
  await closeAll();
});

test('selection: long-press and slide selects a range on the phone; Shift-click and Delete on the PC', async () => {
  await reset();
  await samples({ photos: 9 });
  const ip = await open('iphone');
  await ip.waitForFunction(() => document.querySelectorAll('#grid .tile').length === 9);
  const box = async (i) => (await ip.$('#grid .tile:nth-child(' + i + ')')).boundingBox();
  const a = await box(1), b = await box(5);
  const cdp = await ip.context().newCDPSession(ip);
  const pt = (r) => [{ x: r.x + r.width / 2, y: r.y + r.height / 2 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(a) });
  await sleep(500);
  for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + a.width / 2 + (b.x - a.x) * i / 6, y: a.y + a.height / 2 + (b.y - a.y) * i / 6 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
  assert.equal(await ip.$$eval('#grid .tile.sel', (t) => t.length), 5);
  await waitFor(async () => /^Save 5 /.test(await dock(ip)), 20000, 'Save 5 (dock: ' + await dock(ip) + ')'); // once the 5 are downloaded
  const pc = await open('pc');
  await pc.waitForFunction(() => document.querySelectorAll('#grid .tile').length === 9);
  await pc.click('#grid .tile:nth-child(2) .chk');
  await pc.click('#grid .tile:nth-child(4)', { modifiers: ['Shift'] });
  assert.equal(await text(pc, '#pillN'), '3 selected');
  await pc.keyboard.press('Delete');
  await pc.waitForSelector('#modal:not([hidden])');
  await pc.click('#mRow .solid-danger');
  await pc.waitForFunction(() => document.querySelectorAll('#grid .tile').length === 6);
  await closeAll();
});

test('update banner: a quick update in one click, the window reloads into the new version', async () => {
  const u = await startServer();
  try {
    const b = await browser();
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
    const pc = await ctx.newPage();
    await pc.goto(u.url);
    await upload(u.url, 'stays.jpg', randomFile(1000));
    await u.api('/api/test/release', { version: '9.0.0', quick: true, notes: '## What’s new\n- **Quicker** updates' });
    await pc.waitForSelector('#upd:not([hidden])');
    assert.equal(await text(pc, '#updT'), 'PhoneDrop 9.0.0 is available');
    assert.match(await text(pc, '#updS'), /Quick update \(\d+ KB\): takes a few seconds, no installer/);
    await pc.click('#updNotes');
    assert.match(await text(pc, '#mP'), /What’s new Quicker updates|Quicker/);
    const reloaded = pc.waitForEvent('load', { timeout: 30000 }); // reloads by itself once the new copy answers
    await pc.click('#mRow .primary'); // Update now
    await pc.waitForFunction(() => /Restarting into PhoneDrop 9\.0\.0/.test(document.getElementById('updT').textContent), null, { timeout: 10000 });
    await reloaded;
    await waitFor(async () => (await u.api('/api/info')).body.version === '9.0.0', 10000, 'server 9.0.0');
    await pc.waitForFunction(() => document.querySelectorAll('#grid .tile').length === 1, null, { timeout: 10000 });
    assert.equal(await pc.$eval('#upd', (e) => e.hidden), true);
    await ctx.close();
  } finally { await u.stop(); }
});

test('update banner: failures say why, Try again, and Later has a way back', async () => {
  const u = await startServer();
  try {
    const b = await browser();
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
    const pc = await ctx.newPage();
    await pc.goto(u.url);
    await u.api('/api/test/release', { version: '9.0.0', uac: 'no' });
    await pc.waitForSelector('#upd:not([hidden])');
    assert.match(await text(pc, '#updS'), /Updating takes about a minute/);
    await pc.click('#updGo');
    await pc.waitForFunction(() => document.getElementById('updT').textContent === 'Update cancelled', null, { timeout: 15000 });
    assert.equal(await text(pc, '#updGo'), 'Try again');
    await u.api('/api/test/release', { version: '9.0.1', badSum: true });
    await pc.waitForFunction(() => /9\.0\.1/.test(document.getElementById('updT').textContent));
    await pc.click('#updGo');
    await pc.waitForFunction(() => document.getElementById('updT').textContent === 'Update failed', null, { timeout: 15000 });
    assert.match(await text(pc, '#updS'), /checksum/);
    assert.equal(await pc.$eval('#updMan', (e) => e.hidden), false, 'Download it manually');
    await u.api('/api/test/release', { version: '9.0.2' });
    await pc.waitForFunction(() => /9\.0\.2/.test(document.getElementById('updT').textContent));
    await pc.click('#updLater');
    assert.equal(await pc.$eval('#upd', (e) => e.hidden), true);
    assert.equal(await text(pc, '#updFootB'), 'Update to 9.0.2');
    await pc.reload();
    await pc.waitForSelector('#updFoot:not([hidden])');
    assert.equal(await pc.$eval('#upd', (e) => e.hidden), true, 'Later is remembered');
    await pc.click('#updFootB');
    assert.equal(await pc.$eval('#upd', (e) => e.hidden), false);
    // phones never show it
    const ph = await (await b.newContext({ userAgent: IOS_UA, isMobile: true, hasTouch: true, viewport: { width: 393, height: 852 } })).newPage();
    await ph.goto(u.url);
    await sleep(800);
    assert.equal(await ph.$eval('#upd', (e) => getComputedStyle(e).display), 'none');
    await ph.context().close();
    await ctx.close();
  } finally { await u.stop(); }
});

test('phone loses the computer: says which Wi-Fi to be on, and recovers by itself', async () => {
  const u = await startServer();
  try {
    await u.api('/api/test/net', { preset: 'wifi' });
    const b = await browser();
    const ctx = await b.newContext({ userAgent: ANDROID_UA, isMobile: true, hasTouch: true, viewport: { width: 393, height: 852 } });
    const an = await ctx.newPage();
    await an.goto(u.url + '/#p=' + (await u.pairCode()));
    await an.waitForFunction(() => document.querySelector('#live') && !document.querySelector('#live.off'));
    await u.stop();
    await an.waitForSelector('#lost:not([hidden])', { timeout: 15000 });
    assert.match(await text(an, '#lostP'), /Wi-Fi HomeNet/);
    const again = await startServer({ port: u.port, data: u.data, env: { KEEP: '1' } });
    await an.waitForSelector('#lost[hidden]', { state: 'attached', timeout: 15000 });
    await again.stop();
    await ctx.close();
  } finally { await u.stop(); }
});

test('iPhone without a share stub in test mode: the pretend share sheet', async () => {
  await reset();
  await samples({ photos: 2 });
  const ip = await open('iphone', { stub: false });
  await waitFor(async () => (await dock(ip)) === 'Save all 2 to Photos', 15000, 'Save all 2');
  await ip.click('#save');
  await ip.waitForSelector('#modal:not([hidden])');
  assert.equal(await text(ip, '#mT'), 'iPhone share sheet (test mode)');
  await ip.click('#mRow .primary');
  await waitFor(async () => (await dock(ip)) === 'All saved', 5000, 'All saved');
  await closeAll();
});

test('layouts: no sideways scrolling at any size, dark and light', async () => {
  await reset();
  await samples({ photos: 7, files: 2 });
  await upload(s.url, 'A very long file name that goes on and on and on for quite a while.pdf', randomFile(100));
  const b = await browser();
  const sizes = [
    ['pc', 1920, 1080], ['pc', 1440, 900], ['pc', 1280, 800], ['pc', 1024, 768], ['pc', 820, 900], ['pc', 640, 800], ['pc', 480, 800],
    ['iphone', 320, 568], ['android', 360, 780], ['iphone', 393, 852], ['iphone', 430, 932], ['iphone', 852, 393], ['iphone', 820, 1180], ['android', 800, 1280],
  ];
  for (const scheme of ['dark', 'light']) {
    for (const [kind, w, h] of sizes) {
      const phone = kind !== 'pc';
      const ctx = await b.newContext(Object.assign({ viewport: { width: w, height: h }, colorScheme: scheme }, phone ? { isMobile: true, hasTouch: true, userAgent: kind === 'iphone' ? IOS_UA : ANDROID_UA } : {}));
      if (kind === 'iphone') await ctx.addInitScript(shareStub);
      const p = await ctx.newPage();
      const errs = []; p.on('pageerror', (e) => errs.push(e.message));
      await p.goto(s.url + (phone ? '/#p=' + (await s.pairCode()) : ''));
      await p.waitForFunction(() => document.querySelectorAll('#grid .tile').length === 10);
      await sleep(150);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(over <= 0, kind + ' ' + w + '×' + h + ' ' + scheme + ': ' + over + ' px sideways scroll');
      assert.deepEqual(errs, [], kind + ' ' + w + '×' + h);
      if (phone && w === 320) { // the pairing screen too, on the narrowest phone
        const u = await (await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, isMobile: true, hasTouch: true, userAgent: IOS_UA })).newPage();
        await u.goto(s.url);
        await u.waitForSelector('#pairScr:not([hidden])');
        assert.ok((await u.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'pairing screen ' + scheme);
        await u.context().close();
        await s.api('/api/test/pair', { clear: true });
      }
      if (phone) {
        await p.click('#grid .tile:nth-child(2)');
        await p.waitForSelector('#lb:not([hidden])');
        const over2 = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(over2 <= 0, kind + ' ' + w + '×' + h + ' viewer');
      }
      await ctx.close();
    }
  }
});

test('pairing: the QR link carries the code, and the QR code changes with it', async () => {
  await reset();
  await s.api('/api/test/pair', { forget: 'all' });
  const pc = await open('pc');
  const code = await s.pairCode();
  await pc.waitForFunction((c) => document.getElementById('link').textContent.endsWith('/#p=' + c), code);
  assert.match(await pc.$eval('#qr', (i) => decodeURIComponent(i.getAttribute('src'))), new RegExp('#p=' + code + '$'));
  await s.api('/api/test/pair', { rotate: true });
  const code2 = await s.pairCode();
  await pc.waitForFunction((c) => document.getElementById('link').textContent.endsWith('/#p=' + c), code2);
  // a phone opening that link is in at once, and the code doesn't stay in its address bar
  const an = await open('android', { path: '/#p=' + code2 });
  await an.waitForSelector('#dock:not([hidden])');
  assert.equal(await an.evaluate(() => location.hash), '');
  assert.equal(await an.$eval('#pairScr', (e) => e.hidden), true);
  await pc.waitForFunction(() => /^1 phone$/.test(document.getElementById('phonesBtn').textContent));
  assert.deepEqual(pc.errors.concat(an.errors), []);
  await closeAll();
});

test('pairing: a typed address waits for Allow on the PC; Allow lets the phone in', async () => {
  await reset();
  await samples({ photos: 2 });
  const pc = await open('pc');
  const ip = await open('iphone', { unpaired: true });
  await ip.waitForFunction(() => /Waiting for the computer to allow this phone/.test(document.getElementById('psT').textContent));
  assert.equal(await ip.$eval('#grid', (g) => g.children.length), 0, 'nothing shown before it’s allowed');
  assert.equal(await ip.evaluate(() => getComputedStyle(document.querySelector('.wrap')).display), 'none');
  assert.ok((await ip.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
  await pc.waitForSelector('#preqs .preq');
  assert.match(await text(pc, '#preqs .preq'), /Allow iPhone to connect\?/);
  await pc.click('#preqs [data-allow]');
  await ip.waitForFunction(() => document.querySelectorAll('#grid .tile').length === 2, null, { timeout: 15000 });
  await waitFor(async () => (await dock(ip)) === 'Save all 2 to Photos', 15000, 'dock ready');
  await pc.waitForFunction(() => /iPhone (is paired|connected)/.test(document.getElementById('toast').textContent) || !document.getElementById('slim').hidden);
  await closeAll();
});

test('pairing: Block keeps the phone out, and Remove on the PC shows a paired phone the door', async () => {
  await reset();
  await s.api('/api/test/pair', { forget: 'all' }); // only this test's phone in the Phones list
  const pc = await open('pc');
  const stranger = await open('android', { unpaired: true, ctx: { extraHTTPHeaders: { 'x-phonedrop-ip': '10.9.9.9' } } });
  await pc.waitForSelector('#preqs .preq');
  await pc.click('#preqs [data-block]');
  await stranger.waitForFunction(() => document.getElementById('psT').textContent === 'The computer didn’t allow this phone');
  assert.equal(await stranger.$eval('#psGo', (b) => b.hidden), false);
  // a paired phone, removed on the PC
  const an = await open('android');
  await an.waitForSelector('#dock:not([hidden])');
  await pc.waitForSelector('#phonesBtn:not([hidden])');
  await pc.click('#phonesBtn');
  await pc.waitForSelector('#mP .prow');
  assert.match(await text(pc, '#mP .prow'), /Android phone/);
  await pc.click('#mP .prow [data-pid]');
  await an.waitForFunction(() => document.getElementById('psT').textContent === 'This phone isn’t allowed any more', null, { timeout: 15000 });
  assert.equal(await an.$eval('#psGo', (b) => b.textContent), 'Ask to connect');
  await pc.waitForFunction(() => !document.querySelector('#mP .prow'));
  await closeAll();
});

test('pairing: an iPhone on the http link switches to https (Save to Photos) and stays paired', async () => {
  await reset();
  await samples({ photos: 1 });
  // a name for 127.0.0.1 that isn't "localhost", so the http page isn't a secure context, like on a real Wi-Fi
  const b = await browserWith(['--host-resolver-rules=MAP phonedrop.test 127.0.0.1'], ['phonedrop.test']);
  try {
    const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, userAgent: IOS_UA, ignoreHTTPSErrors: true });
    await ctx.addInitScript(shareStub);
    const ip = await ctx.newPage();
    await ip.goto('http://phonedrop.test:' + s.port + '/#p=' + (await s.pairCode()));
    await ip.waitForSelector('#secure:not([hidden])');
    assert.equal(await ip.evaluate(() => window.isSecureContext), false);
    const before = (await s.api('/api/phones')).body.length;
    await ip.click('#secureGo');
    await waitFor(() => /^https:\/\/phonedrop\.test:\d+\/$/.test(ip.url()), 15000, 'the https page');
    await waitFor(async () => (await ip.$eval('#t1', (e) => e.textContent)) === 'Save photo to Photos', 15000, 'paired on https');
    assert.equal(await ip.$eval('#pairScr', (e) => e.hidden), true);
    assert.equal((await s.api('/api/phones')).body.length, before, 'still the same phone');
    await ip.click('#save');
    await ip.waitForFunction(() => window.__shared.length === 1);
  } finally { await b.close(); }
});

// ---------- notes: text and links ----------
const clip = { permissions: ['clipboard-read', 'clipboard-write'] };
test('notes: the PC sends text, the phone shows a card and the whole text, with Copy', async () => {
  await reset();
  const pc = await open('pc');
  const ip = await open('iphone', { ctx: clip });
  await ip.waitForSelector('#dock:not([hidden])');
  await pc.click('#textBtn');
  await pc.waitForSelector('#textIn');
  const text = 'Wi-Fi password: Tr0ub4dor&3\nDoor code 4711 · Grüße 🎉';
  await pc.fill('#textIn', text);
  await pc.click('#mRow .primary');
  await ip.waitForSelector('#grid .tile .notec');
  assert.equal(await ip.$eval('#grid .notec .nt', (e) => e.textContent), text);
  assert.equal(await dock(ip), 'Send files to computer', 'a note isn’t something to save');
  await ip.click('#grid .tile');
  await ip.waitForSelector('#mP .notefull');
  assert.equal(await ip.$eval('#mP .notefull', (e) => e.textContent), text);
  assert.equal(await ip.$eval('#mT', (e) => e.textContent), 'Note from the computer');
  assert.deepEqual(await ip.$$eval('#mRow button', (b) => b.map((x) => x.textContent)), ['Close', 'Copy']);
  await ip.click('#mRow button:nth-child(2)');
  assert.equal(await ip.evaluate(() => navigator.clipboard.readText()), text);
  assert.equal(await ip.$eval('#modal', (m) => m.hidden), true);
  await closeAll();
});

test('notes: a phone sends a link; the PC toasts it with Copy, and the note has Open link', async () => {
  await reset();
  const pc = await open('pc', { ctx: clip });
  const an = await open('android');
  await an.waitForSelector('#textSend:not([hidden])');
  await an.click('#textSend');
  await an.fill('#textIn', 'https://example.com/recipe?id=42');
  await an.click('#mRow .primary');
  await pc.waitForFunction(() => /Android phone sent a link/.test(document.getElementById('toast').textContent));
  await pc.click('#toast .tb');
  assert.equal(await pc.evaluate(() => navigator.clipboard.readText()), 'https://example.com/recipe?id=42');
  await pc.waitForSelector('#grid .tile .notec.link');
  assert.equal(await pc.$eval('#getBtn', (b) => b.hidden), true, 'notes aren’t "Download from phone" files');
  await pc.click('#grid .tile');
  await pc.waitForSelector('#mP .notefull');
  assert.equal(await pc.$eval('#mT', (e) => e.textContent), 'Link from Android phone');
  const popup = pc.context().waitForEvent('page');
  await pc.click('#mRow .primary');   // Open link
  const p2 = await popup;
  assert.equal(p2.url(), 'https://example.com/recipe?id=42');
  assert.equal(await p2.evaluate(() => window.opener).catch(() => null), null, 'opened with noopener');
  await closeAll();
});

test('notes: text from a phone is shown as text, never run as HTML', async () => {
  await reset();
  const pc = await open('pc');
  const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script> javascript:alert(1) <b>bold</b> https://ok.example/a"onmouseover="window.__xss=3';
  const ph = await s.phone('Android phone');
  await fetch(s.url + '/api/text', { method: 'POST', body: evil, headers: ph });
  await pc.waitForSelector('#grid .notec');
  assert.equal(await pc.$eval('#grid .notec .nt', (e) => e.textContent), evil);
  assert.equal(await pc.$$eval('#grid .notec img, #grid .notec script, #grid .notec b', (x) => x.length), 0);
  await pc.click('#grid .tile');
  await pc.waitForSelector('#mP .notefull');
  assert.equal(await pc.$eval('#mP .notefull', (e) => e.textContent), evil);
  assert.equal(await pc.$$eval('#mP img, #mP script, #mP b', (x) => x.length), 0);
  const links = await pc.$$eval('#mP a', (a) => a.map((x) => [x.getAttribute('href'), x.getAttribute('rel'), x.attributes.length]));
  assert.deepEqual(links, [['https://ok.example/a', 'noopener noreferrer', 3]], 'only the http(s) link is a link, with nothing else on it');
  await pc.hover('#mP a');
  assert.equal(await pc.evaluate(() => window.__xss), undefined);
  assert.deepEqual(pc.errors, []);
  await closeAll();
});

test('notes: Ctrl+V with text opens Send text, filled in; nothing is sent until you click Send', async () => {
  await reset();
  const pc = await open('pc');
  await pc.waitForSelector('#textBtn');
  const paste = (t) => pc.evaluate((x) => {
    const dt = new DataTransfer(); dt.setData('text/plain', x);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, t);
  await paste('a stray paste');
  await pc.waitForSelector('#textIn');
  assert.equal(await pc.$eval('#textIn', (a) => a.value), 'a stray paste');
  await sleep(500);
  assert.equal((await s.api('/api/files')).body.length, 0, 'not sent by itself');
  await pc.click('#mRow button:first-child'); // Cancel
  await sleep(300);
  assert.equal((await s.api('/api/files')).body.length, 0);
  await paste('meant to send');
  await pc.waitForSelector('#textIn');
  await pc.press('#textIn', 'Enter');   // a new line, not "send"
  assert.equal(await pc.$eval('#textIn', (a) => a.value), 'meant to send\n');
  await pc.press('#textIn', 'Control+Enter');
  await waitFor(async () => (await s.api('/api/files')).body.length === 1, 5000, 'sent');
  assert.equal((await s.api('/api/files')).body[0].preview, 'meant to send\n');
  // an empty box doesn't send
  await pc.click('#textBtn');
  await pc.click('#mRow .primary');
  assert.equal(await pc.$eval('#modal', (m) => m.hidden), false);
  await closeAll();
});

test('notes: never part of Save to Photos or Save to phone', async () => {
  await reset();
  await samples({ photos: 1 });
  await fetch(s.url + '/api/text', { method: 'POST', body: 'just a note' });
  const ip = await open('iphone');
  await waitFor(async () => (await dock(ip)) === 'Save photo to Photos', 15000, 'only the photo');
  await ip.click('#selBtn');
  await ip.click('#grid .tile:has(.notec)');
  await waitFor(async () => (await dock(ip)) === 'Select items to save', 3000, 'a selected note isn’t saved either');
  await sleep(300);
  await ip.click('#grid .tile:not(:has(.notec))');
  await waitFor(async () => (await dock(ip)) === 'Save photo to Photos', 3000, 'the selected photo only');
  await ip.click('#save');
  await ip.waitForFunction(() => window.__shared.length === 1);
  assert.deepEqual(await ip.evaluate(() => window.__shared.map((x) => x.name)), ['Sample 01.png']);
  await closeAll();
});

// drop files and folders from disk on the page, the way Explorer does it (folders arrive as directory entries)
async function dropPaths(page, paths) {
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: paths, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: 150, y: 300, data });
  // (the session stays: detaching it right away can end the drag before the page has read the folder)
}
// a folder on disk: { dir, files: { 'Holiday/...': bytes } } (system files go in too: they must never be sent)
function folder(name, list) {
  const root = tmpDir('folder'), files = {};
  for (const [p, b] of Object.entries(list)) {
    const f = path.join(root, name, p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, b);
    if (!/^(desktop\.ini|thumbs\.db|\.ds_store)$/i.test(path.basename(p))) files[name + '/' + p] = b;
  }
  return { dir: path.join(root, name), files };
}
const holiday = () => folder('Holiday', {
  'IMG_0001.jpg': randomFile(400000), 'notes.txt': Buffer.from('packing list\n'),
  'Strand 🏖/写真 über.jpg': randomFile(250000), 'Strand 🏖/Videos/clip.mov': randomFile(600000),
  'desktop.ini': Buffer.from('[.ShellClassInfo]'), 'Thumbs.db': Buffer.from('thumbs'), '.DS_Store': Buffer.from('mac'), 'Strand 🏖/.DS_Store': Buffer.from('mac'),
});
const names = async () => (await s.api('/api/files')).body.map((f) => f.name).sort();
// the zip PhoneDrop received: every file in it matches the folder's, and nothing else is in it
function checkZip(name, f, dirs) {
  const file = path.join(s.data, 'shared', name), list = readZip(file);
  assert.deepEqual(list.filter((e) => e.dir).map((e) => e.name).sort(), dirs.sort(), 'the folders');
  assert.deepEqual(list.filter((e) => !e.dir).map((e) => e.name).sort(), Object.keys(f.files).sort(), 'the files (no system files)');
  for (const e of list) if (!e.dir) { assert.equal(e.method, 0, 'stored'); assert.equal(sha(e.read()), sha(f.files[e.name]), e.name); }
  const py = pythonZip(file);
  if (py) for (const [n, b] of Object.entries(f.files)) assert.equal(py.sha[n], sha(b), 'Python zipfile: ' + n);
}

test('folders: a dropped folder asks first; Zip and send makes Holiday.zip, subfolders kept, files identical, no system files', async () => {
  await reset();
  const h = holiday();
  const pc = await open('pc');
  await dropPaths(pc, [h.dir]);
  await pc.waitForSelector('#modal:not([hidden])');
  assert.equal(await text(pc, '#mT'), 'Send “Holiday”?');
  const p = await text(pc, '#mP');
  assert.match(p, /^4 files · [\d.]+ MB · 2 subfolders/);
  assert.match(p, /the 2 files directly inside, straight away\. Skips the 2 subfolders\./);
  assert.match(p, /A zip is one file \(phones put it in Files\)\. Sending individually makes photos show up for Save to Photos\./);
  assert.deepEqual(await pc.$$eval('#mRow button', (b) => b.map((x) => x.textContent.trim())), ['Cancel', 'Send 2 files individually', 'Zip and send']);
  await pc.click('#mRow .primary');
  await waitFor(async () => (await names()).includes('Holiday.zip'), 20000, 'Holiday.zip');
  await pc.waitForFunction(() => /Sent 1 file/.test(document.getElementById('upT').textContent), null, { timeout: 10000 });
  assert.deepEqual(await names(), ['Holiday.zip'], 'one zip, nothing else');
  checkZip('Holiday.zip', h, ['Holiday/', 'Holiday/Strand 🏖/', 'Holiday/Strand 🏖/Videos/']);
  assert.deepEqual(pc.errors, []);
  await closeAll();
});

test('folders: Send contents individually sends only the files directly inside', async () => {
  await reset();
  const h = holiday();
  const pc = await open('pc');
  await dropPaths(pc, [h.dir]);
  await pc.waitForSelector('#modal:not([hidden])');
  await pc.click('#mRow button:has-text("individually")');
  await waitFor(async () => (await names()).length === 2, 15000, 'the two files');
  await pc.waitForFunction(() => /Sent 2 files/.test(document.getElementById('upT').textContent), null, { timeout: 10000 });
  await sleep(500);
  assert.deepEqual(await names(), ['IMG_0001.jpg', 'notes.txt'], 'no subfolders, no desktop.ini/Thumbs.db/.DS_Store');
  assert.equal(shaOf('IMG_0001.jpg'), sha(h.files['Holiday/IMG_0001.jpg']));
  assert.equal(shaOf('notes.txt'), sha(h.files['Holiday/notes.txt']));
  await closeAll();
});

test('folders: Cancel sends nothing (a tablet gets the same question); an empty folder says so', async () => {
  await reset();
  const h = holiday();
  const an = await open('android');
  await an.waitForSelector('#dock:not([hidden])');
  await dropPaths(an, [h.dir]);
  await an.waitForSelector('#modal:not([hidden])');
  assert.equal(await text(an, '#mT'), 'Send “Holiday”?');
  await an.click('#mRow button:has-text("Cancel")');
  await sleep(1500);
  assert.deepEqual(await names(), [], 'nothing sent');
  assert.equal(await an.$eval('#up', (e) => e.hidden), true);
  // a folder with only system files in it counts as empty
  const e = folder('Empty', { 'desktop.ini': Buffer.from('x'), '.DS_Store': Buffer.from('y') });
  const pc = await open('pc');
  await dropPaths(pc, [e.dir]);
  await waitFor(async () => /“Empty” is empty/.test(await text(pc, '#toast')), 5000, 'the empty-folder toast');
  assert.equal(await pc.$eval('#modal', (m) => m.hidden), true, 'no question');
  assert.deepEqual(await names(), []);
  await closeAll();
});

test('folders: several folders and a file in one drop: the file goes, one question for the folders, one zip each', async () => {
  await reset();
  const h = holiday();
  const f = folder('Ferien 日本 🏖', { 'Strand.jpg': randomFile(123456), 'Tag 2/Notizen für später.txt': Buffer.from('über') });
  const loose = path.join(tmpDir('loose'), 'loose.txt');
  fs.writeFileSync(loose, 'on its own');
  const pc = await open('pc');
  await dropPaths(pc, [h.dir, f.dir, loose]);
  await pc.waitForSelector('#modal:not([hidden])');
  assert.equal(await text(pc, '#mT'), 'Send 2 folders?');
  assert.match(await text(pc, '#mP'), /^6 files · [\d.]+ MB · 3 subfolders.*one zip per folder/);
  await waitFor(async () => (await names()).includes('loose.txt'), 10000, 'the loose file, straight away');
  await pc.click('#mRow .primary');
  await waitFor(async () => (await names()).length === 3, 20000, 'two zips');
  assert.deepEqual(await names(), ['Ferien 日本 🏖.zip', 'Holiday.zip', 'loose.txt']);
  checkZip('Holiday.zip', h, ['Holiday/', 'Holiday/Strand 🏖/', 'Holiday/Strand 🏖/Videos/']);
  checkZip('Ferien 日本 🏖.zip', f, ['Ferien 日本 🏖/', 'Ferien 日本 🏖/Tag 2/']);
  await closeAll();
});

test('folders: a subfolder the browser can’t read is left out and the question says so; ✕ while zipping stops it', async () => {
  await reset();
  const pc = await open('pc');
  // pretend folder entries (what webkitGetAsEntry gives), one of them unreadable, straight into the page's code
  await pc.evaluate(() => {
    const file = (name, data) => ({ name, isDirectory: false, file: (ok) => ok(new File([data], name)) });
    const dir = (name, kids, bad) => ({ name, isDirectory: true, createReader: () => { let done = false; return { readEntries: (ok, no) => (bad ? no(new Error('EncodingError')) : ok(done ? [] : (done = true, kids))) }; } });
    PD.askFolders([dir('Trip', [file('a.jpg', 'photo'), dir('Locked', [file('x.txt', 'x')], true)])]);
  });
  await pc.waitForSelector('#modal:not([hidden])');
  assert.match(await text(pc, '#mP'), /Couldn’t read “Trip\/Locked”: left out\./);
  await pc.click('#mRow .primary');
  await waitFor(async () => (await names()).includes('Trip.zip'), 10000, 'Trip.zip');
  assert.deepEqual(readZip(path.join(s.data, 'shared', 'Trip.zip')).map((e) => e.name), ['Trip/', 'Trip/a.jpg'], 'no empty Locked/ folder in it');
  // a folder that takes a while to read: ✕ stops the zipping, nothing is sent
  await reset();
  await pc.evaluate(() => {
    const slow = { name: 'big.mov', size: 50e6, lastModified: Date.now(), slice: (a, b) => ({ arrayBuffer: () => new Promise((r) => setTimeout(() => r(new ArrayBuffer(b - a)), 300)) }) };
    const dir = { name: 'Slow', isDirectory: true, createReader: () => { let done = false; return { readEntries: (ok) => ok(done ? [] : (done = true, [{ name: 'big.mov', isDirectory: false, file: (ok2) => ok2(slow) }])) }; } };
    PD.askFolders([dir]);
  });
  await pc.waitForSelector('#modal:not([hidden])');
  await pc.click('#mRow .primary');
  await waitFor(async () => /Zipping “Slow”…/.test(await text(pc, '#upT')), 5000, 'Zipping “Slow”…');
  await pc.click('#upX');
  await waitFor(async () => /Zipping cancelled/.test(await text(pc, '#toast')), 5000, 'Zipping cancelled');
  await sleep(800);
  assert.equal(await pc.$eval('#up', (e) => e.hidden), true);
  assert.deepEqual(await names(), []);
  await closeAll();
});

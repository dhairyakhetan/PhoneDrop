// Security: only phones that were paired (QR code, or Allow on the PC) can see or change anything.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import { startServer, upload, events, waitFor, sleep, randomFile, PHONE } from './helpers.mjs';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });
const as = (ip) => Object.assign({ 'x-phonedrop-ip': ip }, PHONE); // an unpaired phone at that address
const pair = (b, headers = PHONE) => s.api('/api/pair', Object.assign({ id: 'x', name: 'iPhone' }, b), headers);
const cookieOf = (r) => (/(pd(?:_s)?=[^;]+)/.exec(r.headers.get('set-cookie') || '') || [])[1];
function raw(lines) {
  return new Promise((ok) => {
    const c = net.connect(s.port, '127.0.0.1', () => c.write(lines + '\r\nConnection: close\r\n\r\n'));
    let b = ''; c.on('data', (d) => { b += d; }); c.on('end', () => ok(b)); c.on('error', () => ok(b));
  });
}
function httpsReq(p, o = {}) {
  return new Promise((ok, no) => {
    const body = o.body ? Buffer.from(JSON.stringify(o.body)) : null;
    const rq = https.request(s.https + p, { method: body ? 'POST' : 'GET', rejectUnauthorized: false, agent: false,
      headers: Object.assign({}, o.headers, body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}) }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) {} ok({ status: res.statusCode, body: j, cookie: [].concat(res.headers['set-cookie'] || []).join(', ') }); });
    });
    rq.on('error', no); rq.end(body);
  });
}

test('every route that reads or changes files needs a paired phone', async () => {
  await upload(s.url, 'a.jpg', randomFile(1000)); // from this PC
  await fetch(s.url + '/thumb?name=a.jpg', { method: 'POST', body: randomFile(10) });
  const routes = [
    ['GET', '/api/files'], ['GET', '/api/events'], ['POST', '/api/saved', '{"files":["a.jpg"]}'], ['POST', '/upload?name=x.jpg', 'hello'],
    ['POST', '/thumb?name=a.jpg', 'x'], ['GET', '/files/a.jpg'], ['HEAD', '/files/a.jpg'], ['GET', '/files/a.jpg?dl=1'], ['DELETE', '/files/a.jpg'],
    ['GET', '/thumbs/a.jpg'], ['DELETE', '/api/files'], ['GET', '/api/phones'], ['POST', '/api/pair/handoff', '{}'],
  ];
  for (const bad of [PHONE, Object.assign({ cookie: 'pd=' + 'A'.repeat(43) }, PHONE), Object.assign({ cookie: 'pd_s=nope; pd=' }, PHONE)]) {
    for (const [method, p, body] of routes) {
      const r = await fetch(s.url + p, { method, headers: bad, body });
      assert.equal(r.status, 401, method + ' ' + p);
      if (method !== 'HEAD') assert.deepEqual(await r.json(), { error: 'not paired' }, method + ' ' + p);
    }
  }
  // nothing happened
  assert.deepEqual((await s.api('/api/files')).body.map((f) => f.name), ['a.jpg']);
  // still open: the page, icons, manifest, QR codes and a trimmed /api/info
  for (const p of ['/', '/icon.svg', '/icon.png', '/apple-touch-icon.png', '/manifest.json', '/qr.svg?u=http%3A%2F%2Fx']) assert.equal((await fetch(s.url + p, { headers: PHONE })).status, 200, p);
  const info = (await s.api('/api/info', undefined, PHONE)).body;
  assert.deepEqual(Object.keys(info).sort(), ['host', 'httpPort', 'paired', 'test', 'version']);
  assert.equal(info.paired, false);
  // another website that pointed its own name at 127.0.0.1 (DNS rebinding) isn't "this PC"
  assert.match(await raw('GET /api/files HTTP/1.1\r\nHost: evil.example:' + s.port), /^HTTP\/1\.1 401/);
  // and a page from another site in this PC's browser can't change anything either
  assert.equal((await fetch(s.url + '/api/files', { method: 'DELETE', headers: { Origin: 'http://evil.example' } })).status, 401);
  assert.equal((await s.api('/api/files')).body.length, 1);
});

test('the QR code pairs at once; only this PC gets the code; an expired code doesn’t pair', async () => {
  const pcInfo = (await s.api('/api/info')).body;
  assert.match(pcInfo.pair.code, /^[\w-]{12}$/);
  assert.ok(pcInfo.pair.expires > Date.now() + 9 * 60000);
  const r = await pair({ code: pcInfo.pair.code, name: 'Pixel' });
  assert.equal(r.body.status, 'paired');
  const ph = Object.assign({ cookie: cookieOf(r) }, PHONE);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  assert.match(r.headers.get('set-cookie'), /SameSite=Strict/);
  assert.doesNotMatch(r.headers.get('set-cookie'), /Secure/); // plain http can't use it
  assert.equal((await s.api('/api/files', undefined, ph)).status, 200);
  const mine = (await s.api('/api/info', undefined, ph)).body;
  assert.equal(mine.paired, true);
  assert.equal(mine.name, 'Pixel');
  assert.equal(mine.pair, undefined, 'phones never get the pairing code');
  assert.equal(mine.phones, undefined);
  // only a hash of the token is stored
  const stored = fs.readFileSync(path.join(s.data, 'paired.json'), 'utf8');
  assert.ok(!stored.includes(cookieOf(r).split('=')[1]));
  assert.match(stored, /Pixel/);
  // the code changes (every 10 minutes); the one before still works for 2 more minutes; older ones never
  const old = pcInfo.pair.code;
  await s.api('/api/test/pair', { rotate: true });
  assert.equal((await pair({ code: old }, as('10.0.0.7'))).body.status, 'paired');
  await s.api('/api/test/pair', { rotate: true });
  const late = await pair({ code: old }, as('10.0.0.8'));
  assert.equal(late.body.status, 'waiting', 'expired code: has to be allowed on the PC instead');
  assert.equal(late.headers.get('set-cookie'), null);
  await s.api('/api/test/pair', { clear: true });
  // the PC page hears about a new code (its QR code changes)
  const ev = events(s.url);
  await ev.next('devices');
  const { pair: fresh } = (await s.api('/api/test/pair', { rotate: true })).body;
  assert.equal((await ev.next('pair')).code, fresh.code);
  ev.close();
  // codes rotate by themselves
  await s.api('/api/test/pair', { life: 1500 });
  const c1 = (await s.api('/api/info')).body.pair.code;
  await waitFor(async () => (await s.api('/api/info')).body.pair.code !== c1, 5000, 'a new code');
  await s.api('/api/test/pair', { life: 600000 });
});

test('typed address: the PC is asked; Allow pairs the phone, Block keeps it out', async () => {
  const pc = events(s.url);
  await pc.next('devices');
  const w = await pair({ name: 'Galaxy' }, as('10.0.0.21'));
  assert.equal(w.body.status, 'waiting');
  assert.ok(w.body.rid && w.body.secret);
  const reqs = await pc.next('pair-requests', (d) => d.some((r) => r.name === 'Galaxy'));
  const rq = reqs.find((r) => r.name === 'Galaxy');
  assert.equal(rq.ip, '10.0.0.21');
  assert.equal(rq.secret, undefined, 'the PC never needs the phone’s secret');
  // asking again from the same phone doesn't make a second request
  assert.equal((await pair({ name: 'Galaxy' }, as('10.0.0.21'))).body.rid, w.body.rid);
  // polling with a wrong secret gets nothing
  assert.equal((await pair({ rid: w.body.rid, secret: 'guess' }, as('10.0.0.21'))).body.status, 'expired');
  assert.equal((await pair({ rid: w.body.rid, secret: w.body.secret }, as('10.0.0.21'))).body.status, 'waiting');
  assert.equal((await s.api('/api/pair/allow', { rid: rq.rid })).status, 200);
  const ok = await pair({ rid: w.body.rid, secret: w.body.secret }, as('10.0.0.21'));
  assert.equal(ok.body.status, 'paired');
  assert.equal((await s.api('/api/files', undefined, Object.assign({ cookie: cookieOf(ok) }, PHONE))).status, 200);
  assert.ok((await pc.next('phones', (d) => d.some((p) => p.name === 'Galaxy'))));
  // Block
  const b = await pair({ name: 'Stranger' }, as('10.0.0.66'));
  const sr = (await pc.next('pair-requests', (d) => d.some((r) => r.name === 'Stranger'))).find((r) => r.name === 'Stranger');
  assert.equal((await s.api('/api/pair/block', { rid: sr.rid })).status, 200);
  assert.equal((await pair({ rid: b.body.rid, secret: b.body.secret }, as('10.0.0.66'))).body.status, 'blocked');
  assert.equal((await pair({ name: 'Stranger again' }, as('10.0.0.66'))).body.status, 'blocked', 'blocked for a while');
  assert.equal((await s.api('/api/pair/allow', { rid: sr.rid })).status, 404, 'answered already');
  pc.close();
});

test('at most 3 phones can ask at once, and requests run out after 2 minutes', async () => {
  await s.api('/api/test/pair', { clear: true });
  await s.api('/api/test/pair', { requestLife: 1500 });
  const asks = [];
  for (let i = 1; i <= 3; i++) asks.push(await pair({ name: 'Phone ' + i }, as('10.0.1.' + i)));
  assert.ok(asks.every((r) => r.body.status === 'waiting'));
  const fourth = await pair({ name: 'Phone 4' }, as('10.0.1.4'));
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.status, 'busy');
  assert.equal((await s.api('/api/info')).body.requests.length, 3);
  await waitFor(async () => (await s.api('/api/info')).body.requests.length === 0, 10000, 'requests expire');
  assert.equal((await pair({ rid: asks[0].body.rid, secret: asks[0].body.secret }, as('10.0.1.1'))).body.status, 'expired');
  assert.equal((await pair({ name: 'Phone 4' }, as('10.0.1.4'))).body.status, 'waiting', 'room again');
  await s.api('/api/test/pair', { requestLife: 120000, clear: true });
});

test('Remove: the phone is out at once, its live connection closes', async () => {
  const ph = await s.phone('Old phone', 'old-1');
  const ev = events(s.url, '?id=old-1&name=Old%20phone', ph);
  await ev.next('devices');
  const phones = (await s.api('/api/phones')).body;
  const me = phones.find((p) => p.name === 'Old phone');
  assert.equal(me.online, true);
  assert.equal((await s.api('/api/phones/remove', { pid: me.pid })).status, 200);
  await waitFor(async () => { await ev.close(); return true; }, 3000);
  assert.equal((await s.api('/api/files', undefined, ph)).status, 401);
  assert.equal((await fetch(s.url + '/api/events', { headers: ph })).status, 401);
  assert.ok(!(await s.api('/api/phones')).body.some((p) => p.pid === me.pid));
  assert.equal((await s.api('/api/phones/remove', { pid: me.pid })).status, 404);
});

test('the live connection really ends when its phone is removed', async () => {
  const ph = await s.phone('Watcher', 'w-1');
  const ac = new AbortController();
  const r = await fetch(s.url + '/api/events?id=w-1&name=Watcher', { headers: ph, signal: ac.signal });
  const reader = r.body.getReader();
  await reader.read();
  const pid = (await s.api('/api/phones')).body.find((p) => p.name === 'Watcher').pid;
  await s.api('/api/phones/remove', { pid });
  const t0 = Date.now();
  let ended = false;
  while (Date.now() - t0 < 3000) { const x = await reader.read(); if (x.done) { ended = true; break; } }
  ac.abort();
  assert.ok(ended, 'the server closed the event stream');
});

test('a phone can’t approve itself or another phone, list or remove phones', async () => {
  const ph = await s.phone('Sneaky');
  const w = await pair({ name: 'Friend' }, as('10.0.2.1'));
  const rid = (await s.api('/api/info')).body.requests.find((r) => r.name === 'Friend').rid;
  for (const h of [ph, PHONE, as('10.0.2.1')]) {
    assert.equal((await s.api('/api/pair/allow', { rid }, h)).status, 403);
    assert.equal((await s.api('/api/pair/block', { rid }, h)).status, 403);
    assert.equal((await s.api('/api/phones/remove', { pid: 'x' }, h)).status, 403);
  }
  assert.equal((await s.api('/api/phones', undefined, ph)).status, 403);
  assert.equal((await pair({ rid: w.body.rid, secret: w.body.secret }, as('10.0.2.1'))).body.status, 'waiting');
  await s.api('/api/test/pair', { clear: true });
});

test('approving from another website or through DNS rebinding is refused', async () => {
  await pair({ name: 'Target' }, as('10.0.3.1'));
  const rid = (await s.api('/api/info')).body.requests.find((r) => r.name === 'Target').rid;
  const body = JSON.stringify({ rid });
  for (const [host, origin] of [['evil.example:' + s.port, null], ['localhost:' + s.port, 'http://evil.example'], ['localhost:' + s.port, 'http://localhost:1']]) {
    const res = await raw('POST /api/pair/allow HTTP/1.1\r\nHost: ' + host + (origin ? '\r\nOrigin: ' + origin : '') +
      '\r\nContent-Type: application/json\r\nContent-Length: ' + body.length + '\r\n\r\n' + body);
    assert.match(res, /^HTTP\/1\.1 403/, host + ' ' + origin);
  }
  assert.equal((await s.api('/api/info')).body.requests.some((r) => r.rid === rid), true, 'still waiting');
  await s.api('/api/test/pair', { clear: true });
});

test('http → https (iPhone’s Save to Photos) keeps the phone paired, with a one-time code', async () => {
  const ph = await s.phone('iPhone', 'ip-https');
  const before = (await s.api('/api/phones')).body.length;
  const { code } = (await s.api('/api/pair/handoff', {}, ph)).body;
  assert.ok(code);
  assert.equal((await httpsReq('/api/files', { headers: PHONE })).status, 401);
  const r = await httpsReq('/api/pair', { body: { handoff: code, id: 'ip-https', name: 'iPhone' }, headers: PHONE });
  assert.equal(r.body.status, 'paired');
  assert.match(r.cookie, /^pd_s=/);
  assert.match(r.cookie, /Secure/);
  const ck = /(pd_s=[^;]+)/.exec(r.cookie)[1];
  assert.equal((await httpsReq('/api/files', { headers: Object.assign({ cookie: ck }, PHONE) })).status, 200);
  assert.equal((await s.api('/api/phones')).body.length, before, 'the same phone, not a new one');
  // the code works once
  const again = await httpsReq('/api/pair', { body: { handoff: code, name: 'iPhone' }, headers: Object.assign({ 'x-phonedrop-ip': '10.0.4.1' }, PHONE) });
  assert.equal(again.body.status, 'waiting');
  await s.api('/api/test/pair', { clear: true });
  // and the http cookie keeps working too
  assert.equal((await s.api('/api/files', undefined, ph)).status, 200);
});

test('pairing survives a restart (and an update, which restarts the same way)', async () => {
  const one = await startServer();
  const ph = await one.phone('Survivor');
  assert.equal((await one.api('/api/files', undefined, ph)).status, 200);
  await one.stop();
  const two = await startServer({ data: one.data, port: one.port });
  try {
    assert.equal((await two.api('/api/files', undefined, ph)).status, 200);
    assert.equal((await two.api('/api/phones')).body[0].name, 'Survivor');
  } finally { await two.stop(); }
});

test('this PC itself never has to pair', async () => {
  assert.equal((await s.api('/api/files')).status, 200);
  const i = (await s.api('/api/info')).body;
  assert.equal(i.paired, true);
  assert.ok(Array.isArray(i.phones) && Array.isArray(i.requests));
  await sleep(10);
});

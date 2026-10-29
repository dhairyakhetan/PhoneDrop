// The one admin step (Windows Firewall, PhoneDrop 1.x in Program Files): what PhoneDrop finds at start, "Finish
// setup" and its Windows prompt (pretend states from test mode), who may run it, and the installer being per-user.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT, startServer, events, waitFor, request } from './helpers.mjs';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });
const info = async (h) => (await s.api('/api/info', undefined, h)).body;
const pretend = (b) => s.api('/api/test/setup', b);
const finish = (h) => request(s.url + '/api/setup/finish', { method: 'POST', headers: h });
const require_ = (rel) => createRequire(import.meta.url)(path.join(ROOT, rel));

test('nothing to finish: no banner, and the button has nothing to do', async () => {
  await s.api('/api/test/reset', {});
  assert.equal((await info()).setup, null);
  for (const fw of ['ok', 'off', 'unknown']) { await pretend({ firewall: fw }); assert.equal((await info()).setup, null, fw); }
  assert.equal((await finish()).status, 404);
});

test('the firewall keeps phones out, or 1.x is still in Program Files: the PC hears about it, phones never do', async () => {
  await s.api('/api/test/reset', {});
  const ev = events(s.url);
  await pretend({ firewall: 'blocked' });
  assert.deepEqual(await ev.next('setup', (x) => x && x.firewall === 'blocked'), { firewall: 'blocked', old: '', state: '', error: '' });
  for (const fw of ['missing', 'partial']) { await pretend({ firewall: fw }); assert.equal((await info()).setup.firewall, fw); }
  await pretend({ firewall: 'ok', old: true });
  assert.deepEqual((await info()).setup, { firewall: 'ok', old: 'C:\\Program Files\\PhoneDrop', state: '', error: '' });
  // a paired phone: not a word about it, and it can't run it
  const phone = await s.phone('Android');
  assert.equal((await info(phone)).setup, null);
  assert.equal((await finish(phone)).status, 403);
  // nor can another website open in a browser on this PC, or one that points its own name at 127.0.0.1
  assert.equal((await finish({ Origin: 'http://evil.example' })).status, 403);
  assert.equal((await finish({ Host: 'evil.example:' + s.port })).status, 403);
  assert.equal((await info()).setup.state, '', 'nothing started');
  ev.close();
});

test('Finish setup: Windows prompt No → cancelled; Yes → done; Windows changing nothing → failed', async () => {
  await s.api('/api/test/reset', {});
  await pretend({ firewall: 'blocked', old: true, uac: 'no' });
  const ev = events(s.url);
  assert.equal((await finish()).status, 200);
  await ev.next('setup', (x) => x && x.state === 'working');
  assert.deepEqual(await ev.next('setup', (x) => x && x.state === 'cancelled'), { firewall: 'blocked', old: 'C:\\Program Files\\PhoneDrop', state: 'cancelled', error: '' });
  await pretend({ uac: 'fail' });
  await finish();
  const f = await ev.next('setup', (x) => x && x.state === 'failed');
  assert.match(f.error, /didn’t let it change everything/);
  await pretend({ uac: 'yes' });
  await finish();
  assert.equal((await ev.next('setup', (x) => x && x.state === 'done')).state, 'done');
  const st = (await info()).setup;
  assert.deepEqual(st, { firewall: 'ok', old: '', state: 'done', error: '' });
  assert.equal((await finish()).status, 404, 'nothing left to finish');
  ev.close();
});

test('the installer is per-user: no admin, HKCU only, Programs folder; the one admin step is finish-setup.ps1', () => {
  const nsi = fs.readFileSync(path.join(ROOT, 'installer/installer.nsi'), 'utf8');
  assert.match(nsi, /^RequestExecutionLevel user$/m);
  assert.match(nsi, /^InstallDir "\$LOCALAPPDATA\\Programs\\\$\{APP\}"$/m);
  assert.doesNotMatch(nsi, /(WriteReg\w+|DeleteRegKey|DeleteRegValue) HKLM/, 'never writes HKLM (that needs admin)');
  // all users' folders are only looked at (did 1.x have an all-users desktop shortcut?), never written to
  for (const m of nsi.matchAll(/SetShellVarContext all([\s\S]*?)SetShellVarContext current/g)) assert.doesNotMatch(m[1], /CreateShortcut|Delete|File |WriteReg/, 'no all-users shortcuts');
  assert.doesNotMatch(nsi, /netsh/, 'the firewall only through finish-setup.ps1');
  assert.match(nsi, /ExecShellWait "runas" [^\n]*finish-setup\.ps1[^\n]*-Mode finish/);
  assert.match(nsi, /ExecShellWait "runas" [^\n]*finish-setup\.ps1[^\n]*-Mode remove/, 'the uninstaller offers to remove the rule');
  assert.ok(require_('scripts/quick-update.js').ASSETS.includes('installer/finish-setup.ps1'), 'PhoneDrop.exe carries the script');
});

// finish-setup.ps1 itself, where PowerShell is installed (Windows has it; on Linux/macOS, PowerShell 7 if present):
// check mode answers in JSON without admin; finish refuses a program that isn't PhoneDrop.exe
const ps = ['pwsh', 'powershell'].find((c) => spawnSync(c, ['-NoProfile', '-Command', 'exit 0']).status === 0);
test('finish-setup.ps1: check answers in JSON; it never touches a program that isn’t PhoneDrop.exe', { skip: !ps && 'no PowerShell here' }, () => {
  const run = (...a) => spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'installer/finish-setup.ps1'), ...a], { encoding: 'utf8' });
  const c = run('-Mode', 'check', '-Exe', path.join(ROOT, 'PhoneDrop.exe'));
  assert.equal(c.status, 0, c.stderr);
  const r = JSON.parse(c.stdout.trim().split(/\r?\n/).pop());
  assert.ok(['ok', 'off', 'missing', 'partial', 'blocked', 'unknown'].includes(r.firewall), r.firewall);
  assert.equal(typeof r.old, 'string');
  for (const mode of ['finish', 'remove']) assert.equal(run('-Mode', mode, '-Exe', path.join(ROOT, 'evil.exe')).status, 3, mode);
});

// Builds PhoneDrop for Windows from this repo:
//   dist/PhoneDrop.exe        the app: Node.js + server.js + public/ + vendor/ in one file
//   dist/PhoneDrop-Setup.exe  the installer wizard (needs NSIS)
//   dist/PhoneDrop-app-<base>.json.gz   the quick update: just the app files (scripts/quick-update.js)
//
// Windows:  install NSIS (https://nsis.sourceforge.io), then:  npm install  &&  npm run build
// Linux/macOS also work (the Windows node.exe is fetched from npm); point MAKENSIS at a makensis binary.
// The exe is built from the Node.js version running this script (64-bit Node 22+).

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import * as ResEdit from 'resedit';
import * as PE from 'pe-library';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const isWin = process.platform === 'win32';
const run = (cmd, args, opts) => execFileSync(cmd, args, Object.assign({ stdio: 'inherit', shell: isWin && /\.cmd$/i.test(cmd) }, opts));
fs.mkdirSync(DIST, { recursive: true });

// the files server.js reads through asset() are listed in scripts/quick-update.js
const quick = createRequire(import.meta.url)('./quick-update.js');
const ASSETS = quick.ASSETS;

// 1. The Windows node.exe to build on: the running one on Windows, or the same version from npm elsewhere.
let baseExe = process.execPath;
if (!isWin) {
  const v = process.version.slice(1), dir = path.join(ROOT, '.cache', 'node-win-x64-' + v);
  baseExe = path.join(dir, 'package', 'bin', 'node.exe');
  if (!fs.existsSync(baseExe)) {
    fs.mkdirSync(dir, { recursive: true });
    run('npm', ['pack', 'node-win-x64@' + v, '--pack-destination', dir]);
    run('tar', ['-xzf', path.join(dir, 'node-win-x64-' + v + '.tgz'), '-C', dir]);
  }
}
console.log('> PhoneDrop ' + VERSION + ', building on ' + baseExe);
// what this exe can take quick updates for (server.js reads it as build-info.json)
const BASE = quick.base(ROOT, process.versions.node);
const buildInfo = path.join(DIST, 'build-info.json');
fs.writeFileSync(buildInfo, JSON.stringify({ version: VERSION, base: BASE, node: process.versions.node }));

// 2. Pack server.js + assets into a blob Node can run by itself ("single executable application").
const seaConfig = path.join(DIST, 'sea-config.json'), blob = path.join(DIST, 'sea-prep.blob');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: path.join(ROOT, 'server.js'),
  output: blob,
  disableExperimentalSEAWarning: true,
  useCodeCache: false, // must stay false when building on a different OS than the target
  useSnapshot: false,
  assets: Object.assign(Object.fromEntries(ASSETS.map((a) => [a, path.join(ROOT, a)])), { 'build-info.json': buildInfo }),
}));
run(process.execPath, ['--experimental-sea-config', seaConfig]);

// 3. Copy node.exe and inject the blob.
const exePath = path.join(DIST, 'PhoneDrop.exe');
fs.copyFileSync(baseExe, exePath);
run(path.join(ROOT, 'node_modules', '.bin', isWin ? 'postject.cmd' : 'postject'),
  [exePath, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2']);

// 4. Icon + name + version. Done AFTER injecting: doing it before corrupts the file layout.
//    This also drops node.exe's signature, which the injection made invalid anyway.
const exe = PE.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = PE.NtExecutableResource.from(exe);
const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ROOT, 'assets', 'PhoneDrop.ico')));
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map((i) => i.data));
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  CompanyName: 'PhoneDrop', ProductName: 'PhoneDrop', FileDescription: 'PhoneDrop',
  OriginalFilename: 'PhoneDrop.exe', InternalName: 'PhoneDrop', LegalCopyright: 'Built on Node.js (MIT license)',
});
const [a, b, c] = VERSION.split('.').map(Number);
vi.setFileVersion(a, b, c, 0, 1033);
vi.setProductVersion(a, b, c, 0, 1033);
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
const buf = Buffer.from(exe.generate());

// 5. Windowed app (GUI subsystem): no black console window when it starts.
const pe = buf.readUInt32LE(0x3c);
if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('PhoneDrop.exe is not a valid Windows program');
buf.writeUInt16LE(2, pe + 4 + 20 + 68); // IMAGE_SUBSYSTEM_WINDOWS_GUI
fs.writeFileSync(exePath, buf);
fs.rmSync(blob, { force: true });
fs.rmSync(seaConfig, { force: true });
fs.rmSync(buildInfo, { force: true });
console.log('> built dist/PhoneDrop.exe (' + (buf.length / 1048576).toFixed(1) + ' MB)');

// 5b. The quick update for exes with this same base (older ones from another base get the installer).
for (const f of fs.readdirSync(DIST)) if (/^PhoneDrop-app-.*\.json\.gz$/.test(f)) fs.rmSync(path.join(DIST, f));
const app = path.join(DIST, 'PhoneDrop-app-' + BASE + '.json.gz');
fs.writeFileSync(app, quick.make(ROOT, { version: VERSION, base: BASE }));
console.log('> built ' + path.relative(ROOT, app) + ' (' + Math.round(fs.statSync(app).size / 1024) + ' KB, quick update)');

// 6. The installer wizard.
const makensis = process.env.MAKENSIS || (isWin
  ? ['C:\\Program Files (x86)\\NSIS\\makensis.exe', 'C:\\Program Files\\NSIS\\makensis.exe'].find((p) => fs.existsSync(p))
  : 'makensis');
if (!makensis) {
  console.log('\n! NSIS not found, so only dist/PhoneDrop.exe was built. Install NSIS from https://nsis.sourceforge.io and run again.');
  process.exit(0);
}
run(makensis, ['-V2', '-WX', '-DVERSION=' + VERSION, path.join(ROOT, 'installer', 'installer.nsi')]);
const setup = path.join(DIST, 'PhoneDrop-Setup.exe');
console.log('> built dist/PhoneDrop-Setup.exe (' + (fs.statSync(setup).size / 1048576).toFixed(1) + ' MB)');

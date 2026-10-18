// What goes into a quick update, and how it's packed. Used by scripts/build.mjs (CI) and by test mode.
//
// PhoneDrop.exe = Node.js + the app (server.js, the page, icons). Most releases only change the app, so next to
// PhoneDrop-Setup.exe each release gets PhoneDrop-app-<base>.json.gz: just the app files (~100 KB). Installed
// copies download that instead of the 20 MB installer, with no Windows "allow changes?" prompt (server.js,
// "in-app updates"). <base> fingerprints everything a quick update can't change: Node's major version, the
// installer, the exe icon and how a downloaded copy is started (APP_FORMAT in server.js). A PhoneDrop.exe only
// takes a quick update with its own base; when any of those changed, it gets the full installer.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// Files server.js reads through asset() (they're embedded in PhoneDrop.exe and shipped in quick updates).
// Add a file here when server.js starts reading a new one, or the exe can't find it.
const ASSETS = [
  'package.json',
  'public/index.html',
  'public/icon.svg',
  'public/icon.png',
  'public/favicon.png',
  'public/apple-touch-icon.png',
  'public/manifest.json',
  'vendor/qrcode.js',
  'installer/appid.ps1', // PhoneDrop.exe labels its window with it (Windows taskbar icon)
];
// what <base> is made of, besides APP_FORMAT and Node's major version
const BASE_FILES = ['installer/installer.nsi', 'installer/wizard.bmp', 'installer/header.bmp', 'assets/PhoneDrop.ico'];

function base(root, nodeVersion) {
  const fmt = (/const APP_FORMAT = (\d+)/.exec(fs.readFileSync(path.join(root, 'server.js'), 'utf8')) || [])[1];
  if (!fmt) throw new Error('APP_FORMAT not found in server.js');
  const h = crypto.createHash('sha256').update('format ' + fmt + '\nnode ' + String(nodeVersion || process.versions.node).split('.')[0] + '\n');
  for (const f of BASE_FILES) h.update(f + '\n').update(fs.readFileSync(path.join(root, f)));
  return h.digest('hex').slice(0, 12);
}

const TEXT = /\.(js|json|html|svg|css|txt|md|ps1)$/;
// gzipped JSON: { format: 1, version, base, files: { 'server.js': ['utf8', text], 'public/icon.png': ['base64', data] } }
// `extra` adds files (test mode ships testmode.js too); `replace` swaps a file's contents (test mode's broken builds)
function make(root, o) {
  const files = {};
  for (const rel of ['server.js'].concat(ASSETS, o.extra || [])) {
    let buf = o.replace && o.replace[rel] !== undefined ? Buffer.from(o.replace[rel]) : fs.readFileSync(path.join(root, rel));
    if (rel === 'package.json') buf = Buffer.from(JSON.stringify(Object.assign(JSON.parse(buf), { version: o.version }), null, 2) + '\n');
    files[rel] = TEXT.test(rel) ? ['utf8', buf.toString('utf8')] : ['base64', buf.toString('base64')];
  }
  return zlib.gzipSync(JSON.stringify({ format: 1, version: o.version, base: o.base, files }), { level: 9 });
}

module.exports = { ASSETS, BASE_FILES, base, make };

# PhoneDrop

Send photos, videos and files between your Windows PC and your phone over Wi-Fi, both ways. No cables, no cloud, no accounts, and no AirDrop needed: it works with **Android phones and iPhones**. Everything arrives in full quality, with dates and locations kept.

- Drop files onto the PhoneDrop window on your PC, then scan the QR code with your phone.
- **Android:** one tap saves everything to the phone (Downloads, shows up in the Gallery). **iPhone:** one tap saves straight to the Photos app.
- No shared Wi-Fi? Turn on your **phone's hotspot** and connect the PC to it. PhoneDrop notices and updates the QR code by itself.
- The PC tells you which Wi-Fi your phone should join.
- Works the other way too: send files from your phone, then **Download from phone** on the PC. They count as transferred once they're on the PC.
- Big videos work too, with progress, speed and time left. Pick photos with long-press + slide like the Photos app.
- Fits every screen: phones, tablets, small laptop windows and big monitors.

## Install (Windows)

1. Download **PhoneDrop-Setup.exe** from the [latest release](https://github.com/dhairyakhetan/PhoneDrop/releases/latest/download/PhoneDrop-Setup.exe).
2. Run it. Windows may say "Windows protected your PC": click **More info → Run anyway** (the app isn't code-signed). Click **Yes** on the admin prompt.
3. Follow the wizard and tick **Open PhoneDrop now**.

PhoneDrop is then in the Start Menu. To remove it: Settings → Apps → Installed apps → PhoneDrop → Uninstall.

**Updates:** PhoneDrop checks for new versions by itself. When it says **PhoneDrop x.y.z is available**, click **Update now**. Windows asks for permission once, and PhoneDrop reopens on the new version a few seconds later.

## Use it

1. Open PhoneDrop on the PC and drop in photos, videos or files (or press Ctrl+V to paste).
2. Pick **Android** or **iPhone** above the QR code, connect the phone to the Wi-Fi it names, and scan the code.
3. **Android:** tap **Save all to phone**. The files go to Downloads and show up in the Gallery.
4. **iPhone:** the first time, Safari says the connection isn't private. Tap **Show Details → visit this website** (it's your own PC). Then tap **Save all to Photos** and **Save N Images** in the share sheet.

Closing the PhoneDrop window stops it. Files are cleared the next time it starts.

**Phone can't connect?** Is the phone on the Wi-Fi the PC names? Guest/hotel/office Wi-Fi often blocks devices from seeing each other: turn on your phone's hotspot and connect the PC to it instead. If Windows Firewall blocks it, search "Allow an app through Windows Firewall" and tick PhoneDrop for Private and Public.

## Run from source

Needs [Node.js](https://nodejs.org) 22 or newer. No `npm install` needed to run it.

```
git clone https://github.com/dhairyakhetan/PhoneDrop.git
cd PhoneDrop
node server.js
```

Open http://localhost:3000. Your phone's links are printed in the terminal.

| Command | What it does |
|---|---|
| `node server.js` | run it |
| `node server.js --app` | run it in its own window; quits when the window closes |
| `npm run dev` | restart automatically when `server.js` changes (page edits only need a refresh) |
| `set KEEP=1 && node server.js` | keep shared files between restarts (Windows cmd) |
| `set PORT=4000 && node server.js` | use another port |

## Build the installer yourself

1. Install [NSIS](https://nsis.sourceforge.io) (default options).
2. `npm install`
3. `npm run build`

This makes `dist/PhoneDrop.exe` (the app, with Node.js built in) and `dist/PhoneDrop-Setup.exe` (the installer).

## Releasing a new version

Nothing is built when you push to `main`. To publish a version:

1. On GitHub: **Releases → Draft a new release**.
2. **Choose a tag** → type a new version higher than the last, like `v1.0.1` → **Create new tag on publish**.
3. Write what's new (or click **Generate release notes**) → **Publish release**.

A few minutes later GitHub Actions attaches `PhoneDrop-Setup.exe` to the release, and installed copies of PhoneDrop offer the update. Tick **Set as a pre-release** for a test build: it gets an installer too, but nobody's PhoneDrop updates to it automatically.

## Project layout

```
server.js            backend: web server, file transfer, live updates, HTTPS certificate
public/index.html    frontend: the whole page for both PC and phone
public/icon.svg      the app icon (the PNGs and assets/PhoneDrop.ico are rendered from it)
vendor/qrcode.js     QR code generator (MIT)
assets/              Windows icon
installer/           installer wizard script and artwork (NSIS)
scripts/build.mjs    builds the .exe and the installer
.github/workflows/   builds the installer when a release is published
CLAUDE.md            detailed guide to how everything works
```

## Privacy and safety

Everything stays on your local network: files go straight from your PC to your phone. There's no login, so anyone on the same Wi-Fi who has the link can see the shared files. Use it on networks you trust.

## Credits

[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase (MIT). The Windows app is built on [Node.js](https://nodejs.org) (MIT).

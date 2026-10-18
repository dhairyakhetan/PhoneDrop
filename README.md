# PhoneDrop

Send photos, videos and files from your PC to your phone over Wi-Fi. No cables, no cloud, no accounts. On iPhone, one tap saves everything straight to the Photos app, in full quality with dates and locations kept.

- Drop files onto the PhoneDrop window on your PC, then scan the QR code with your phone.
- **Save all to Photos** in one tap (in batches of 25), or pick photos with long-press + slide like the Photos app.
- Big videos work too, with progress, speed and time left for everything that takes a while.
- Works the other way: send files from your phone to the PC.
- The PC sees which phone is connected and which files were saved, and can clean up saved files.

## Install (Windows)

1. Download **PhoneDrop-Setup.exe** from the [latest release](https://github.com/YOUR-USERNAME/phonedrop/releases/latest/download/PhoneDrop-Setup.exe).
2. Run it. Windows may say "Windows protected your PC": click **More info → Run anyway** (the app isn't code-signed). Click **Yes** on the admin prompt.
3. Follow the wizard and tick **Open PhoneDrop now**.

PhoneDrop is then in the Start Menu. To remove it: Settings → Apps → Installed apps → PhoneDrop → Uninstall.

## Use it

1. Open PhoneDrop on the PC and drop in photos, videos or files (or press Ctrl+V to paste).
2. On your phone (same Wi-Fi), scan the QR code.
3. The first time, Safari says the connection isn't private. Tap **Show Details → visit this website**. That's expected: the page comes from your own PC.
4. Tap **Save all to Photos**, then **Save N Images** in the share sheet.

Closing the PhoneDrop window stops it. Files are cleared the next time it starts.

**Phone can't connect?** Same Wi-Fi on both? Guest/hotel/office Wi-Fi often blocks devices from seeing each other. Try your phone's hotspot. If Windows Firewall blocks it, search "Allow an app through Windows Firewall" and tick PhoneDrop for Private and Public.

## Run from source

Needs [Node.js](https://nodejs.org) 22 or newer. No `npm install` needed to run it.

```
git clone https://github.com/YOUR-USERNAME/phonedrop.git
cd phonedrop
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

This makes `dist/PhoneDrop.exe` (the app, with Node.js built in) and `dist/PhoneDrop-Setup.exe` (the installer). Bump `version` in `package.json` for a new release.

## Project layout

```
server.js            backend: web server, file transfer, live updates, HTTPS certificate
public/index.html    frontend: the whole page for both PC and phone
public/*.png         icons
vendor/qrcode.js     QR code generator (MIT)
assets/              Windows icon
installer/           installer wizard script and artwork (NSIS)
scripts/build.mjs    builds the .exe and the installer
CLAUDE.md            detailed guide to how everything works
```

## Privacy and safety

Everything stays on your local network: files go straight from your PC to your phone. There's no login, so anyone on the same Wi-Fi who has the link can see the shared files. Use it on networks you trust.

## Credits

[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase (MIT). The Windows app is built on [Node.js](https://nodejs.org) (MIT).

# PhoneDrop

Send photos, videos and files between your Windows PC and your phone over Wi-Fi, both ways. No cables, no cloud, no accounts, and no AirDrop needed: it works with **Android phones and iPhones**. Everything arrives in full quality, with dates and locations kept.

- Drop files onto the PhoneDrop window on your PC, then scan the QR code with your phone.
- **Android:** one tap saves everything to the phone (Downloads, shows up in the Gallery). **iPhone:** one tap saves straight to the Photos app.
- No shared Wi-Fi? Turn on your **phone's hotspot** and connect the PC to it. PhoneDrop notices and updates the QR code by itself.
- The PC tells you which Wi-Fi your phone should join.
- Works the other way too: send files from your phone, then **Download from phone** on the PC. They count as transferred once they're on the PC.
- Whole folders too: drop a folder on the PC and choose **Zip and send** (one .zip with its subfolders, every photo inside untouched) or **Send contents individually** (the files directly inside, so photos show up for Save to Photos).
- Text and links too: **Send text** on either side (or just Ctrl+V some text on the PC). It shows up as a note with **Copy**, and **Open link** for a link.
- Big videos work too, with progress, speed and time left. A download or upload cut off by a Wi-Fi hiccup or a locked screen carries on by itself where it stopped. Even if the phone reloads the page, picking the same video again continues instead of starting over.
- Pick photos with long-press + slide like the Photos app.
- Fits every screen: phones, tablets, small laptop windows and big monitors.

## Install (Windows)

1. Download **PhoneDrop-Setup.exe** from the [latest release](https://github.com/dhairyakhetan/PhoneDrop/releases/latest/download/PhoneDrop-Setup.exe).
2. Run it. Windows may say "Windows protected your PC": click **More info → Run anyway** (the app isn't code-signed).
3. Follow the wizard and tick **Open PhoneDrop now**. At the end, Windows asks **once** to allow changes: click **Yes**. That lets phones through Windows Firewall.

PhoneDrop installs just for you, in your own folder (`%LOCALAPPDATA%\Programs\PhoneDrop`), so it needs no admin rights and **updates never ask for permission**. The one admin step is that firewall question. Said No, or don't have admin? PhoneDrop installs anyway and shows **Finish setup · needs admin once** until someone clicks it (with admin). Coming from PhoneDrop 1.x (installed in Program Files)? The update moves PhoneDrop to your own folder: click **Yes** when Windows asks, and the old copy is removed.

PhoneDrop is then in the Start Menu. To remove it: Settings → Apps → Installed apps → PhoneDrop → Uninstall.

**Updates:** PhoneDrop checks for new versions by itself. When it says **PhoneDrop x.y.z is available**, click **Update now**. Most updates are quick: only the changed app (about 100 KB) is downloaded and PhoneDrop restarts on it in a few seconds, without the installer. When an update needs the installer, it runs by itself in the background (no Windows prompt) and PhoneDrop reopens on the new version a few seconds later. If several versions came out, you get the newest straight away.

## Use it

1. Open PhoneDrop on the PC and drop in photos, videos or files (or press Ctrl+V to paste).
2. Pick **Android** or **iPhone** above the QR code, connect the phone to the Wi-Fi it names, and scan the code. That also pairs the phone, so next time it just connects. (Typed the address instead? Click **Allow** on the PC.)
3. **Android:** tap **Save all to phone**. The files go to Downloads and show up in the Gallery.
4. **iPhone:** the first time, Safari says the connection isn't private. Tap **Show Details → visit this website** (it's your own PC). Then tap **Save all to Photos** and **Save N Images** in the share sheet.

Closing the PhoneDrop window stops it. Files are cleared the next time it starts.

**Phone can't connect?** Is the phone on the Wi-Fi the PC names? Guest/hotel/office Wi-Fi often blocks devices from seeing each other: turn on your phone's hotspot and connect the PC to it instead. If PhoneDrop shows **Finish setup**, click it (Windows Firewall is keeping phones out). Or search "Allow an app through Windows Firewall" and tick PhoneDrop for Private and Public.

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
| `npm run test-mode` | test mode: pretend phones, networks, slow or broken Wi-Fi and updates, with a debug panel (see `testmode.js`) |
| `npm install` then `npm test` | the automated tests (needs Edge or Chrome for the page tests) |

## Build the installer yourself

1. Install [NSIS](https://nsis.sourceforge.io) (default options).
2. `npm install`
3. `npm run build`

This makes `dist/PhoneDrop.exe` (the app, with Node.js built in), `dist/PhoneDrop-Setup.exe` (the installer) and `dist/PhoneDrop-app-….json.gz` (the quick update: just the app files).

## Releasing a new version

**Automatic:** change `"version"` in `package.json` to a higher number (like `1.2.0`) and push to `main`. GitHub Actions makes the release **PhoneDrop 1.2.0** by itself: its notes list the commits since the last release, it builds `PhoneDrop-Setup.exe` and the quick update, attaches them and publishes it (a few minutes). Installed copies of PhoneDrop then offer the update. It also checks every hour, so a run that failed half way is finished later. Pushes that don't change the version release nothing. You can edit the notes on GitHub afterwards: the app's "What's new" shows them.

**By hand** (still works): **Releases → Draft a new release** → **Choose a tag** → a new version like `v1.0.1` → write what's new → **Publish release**. Tick **Set as a pre-release** for a test build: it gets an installer too, but nobody's PhoneDrop updates to it automatically.

## Project layout

```
server.js            backend: web server, file transfer, live updates, HTTPS certificate, updates
public/index.html    frontend: the whole page for both PC and phone
public/icon.svg      the app icon (the PNGs, assets/PhoneDrop.ico and the installer artwork are rendered from it)
testmode.js          test mode (npm run test-mode)
test/                automated tests (npm test)
vendor/qrcode.js     QR code generator (MIT)
assets/              Windows icon
installer/           installer wizard script and artwork (NSIS), taskbar helper, the one admin step (firewall)
scripts/build.mjs    builds the .exe, the installer and the quick update
scripts/quick-update.js  what goes into a quick update
.github/workflows/   builds the installer when a release is published
CLAUDE.md            detailed guide to how everything works
```

## Privacy and safety

Everything stays on your local network: files go straight from your PC to your phone. Only phones you paired can see or send anything: scanning the QR code pairs a phone straight away (the code in it changes every 10 minutes), and someone who types the address by hand has to be allowed on the PC first. The PC lists paired phones under **Phones**, where you can remove one. The Wi-Fi traffic itself isn't encrypted (except the iPhone's secure link), so prefer networks you trust.

## Credits

[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase (MIT). The Windows app is built on [Node.js](https://nodejs.org) (MIT).

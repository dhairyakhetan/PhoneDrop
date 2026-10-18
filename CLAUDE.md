# CLAUDE.md — PhoneDrop

Instructions and reference for working on this repo with Claude Code. Read this whole file before changing anything.

## Talking to the owner

- **Start every response with the owner's name: "DHAIRYA".** The owner asked for this explicitly and wants it remembered. It applies to every reply, in every session.

## What PhoneDrop is

A tiny local web app that moves photos, videos and files **from a Windows PC to a phone over the same Wi-Fi** (and phone → PC too). The PC runs a Node.js server; the phone opens a page served by it (via QR code). On iPhone, one tap sends a batch of photos/videos to the iOS share sheet, where the user taps **Save N Images** → straight into the Photos app, originals untouched (EXIF date/location intact).

Main users: a Windows laptop + family iPhones. The owner is learning to program, so keep explanations plain and the code readable.

## Ground rules

- **Zero runtime dependencies.** `server.js` uses only Node built-ins. `npm install` is only needed to *build the .exe* (`postject`, `resedit` are devDependencies). Never add a runtime npm dependency.
- **`node server.js` must always work straight after `git pull`** — no build step for development.
- **No CDNs / internet at runtime.** The phone is on a LAN and may have no internet. Everything (QR code, icons, page) is served by `server.js`.
- **The page is one self-contained file**: `public/index.html` (HTML + `<style>` + one `<script>`). No framework, no bundler. The script is written in plain ES5-style JS (`var`, `function`, no optional chaining) so older iOS Safari keeps working — keep that style.
- **Never re-encode user files.** Uploads are streamed to disk byte-for-byte; downloads/shares send the original bytes. This is what keeps photo metadata intact. Verify with SHA-256 when touching the transfer path.
- **No `.exe` or build output in git** (`dist/`, `.cache/`, `node_modules/`, `*.exe` are gitignored). The installer is built by CI (`.github/workflows/release.yml`) only when a GitHub release is published, never on a plain push.
- If you add a file that `server.js` reads, read it through `asset()` **and** add it to `ASSETS` in `scripts/build.mjs`, or the .exe will crash.

## Repo layout

```
server.js                 the whole backend (HTTP+HTTPS server, API, SSE, cert generation, app mode)
public/index.html         the whole frontend (desktop + phone UI in one page)
public/icon.png           256px app icon (window/taskbar)
public/favicon.png        32px favicon
public/apple-touch-icon.png  180px iPhone home-screen icon
vendor/qrcode.js          qrcode-generator 1.4.4 (MIT, Kazuhiko Arase) — used server-side to draw the QR SVG
assets/PhoneDrop.ico      Windows icon for the .exe and the installer
installer/installer.nsi   NSIS installer wizard script
installer/wizard.bmp      164x314 side image for Welcome/Finish pages
installer/header.bmp      150x57 header image for inner pages
scripts/build.mjs         builds dist/PhoneDrop.exe + dist/PhoneDrop-Setup.exe
package.json              version for dev runs/local builds (CI overwrites it with the release tag); "repository" = update source
.github/workflows/release.yml  CI: when a release is published, builds the installer and attaches it to that release
.github/release-notes.md  install help appended to each release's notes, below an <!-- install --> marker
```

Runtime folders created next to `server.js` when run from the repo (gitignored): `shared/` (the shared files, `shared/.thumbs/` for thumbnails + `<name>.json` metadata) and `.certs/` (self-signed HTTPS cert). When running as the installed .exe these live in `%LOCALAPPDATA%\PhoneDrop\` instead (plus `error-log.txt`, and `updated.txt` for a moment during an in-app update).

## Running

```
node server.js            # http://localhost:3000 on the PC; phone links are printed
node server.js --app      # opens its own Chrome/Edge app window; quits ~6s after that window closes
npm run dev               # node --watch server.js (server restarts on edits)
```
- Edits to `public/index.html` show up on a browser refresh without restarting (the page is re-read per request in dev; cached in the exe).
- `KEEP=1` keeps `shared/` between restarts (default: cleared on every start). `PORT=4000` changes ports (HTTPS = PORT + 443, so 3000/3443 by default).
- Starting a second copy doesn't wipe anything: it detects the busy port, prints a message and exits (in `--app`/exe mode it just opens the window of the running copy).
- Update checks never run from the repo: only the installed exe asks GitHub for new versions (see **In-app updates**).

## How the backend works (`server.js`)

**Two servers, same handler.** HTTP on 3000 and HTTPS on 3443. HTTPS exists because **iOS only allows `navigator.share({files})` (→ "Save to Photos") on a secure page.** The cert is self-signed, generated in pure Node (hand-rolled DER/X.509 in `makeSelfSigned`, SAN = LAN IP + localhost), cached in `.certs/` and regenerated when the LAN IP changes. Phones see a one-time "not private" warning (Show Details → visit this website). The desktop QR defaults to the HTTPS link.

**LAN IP** — `lanIP()` prefers 192.168.x, then 10.x, then 172.16–31.x.

**Exe mode** (`IS_EXE` = `require('node:sea').isSea()`): always app mode; data in `%LOCALAPPDATA%\PhoneDrop`; uncaught errors appended to `error-log.txt` there (the exe has no console). `INSTALLED` = exe mode and `installed.txt` sits next to the exe (the installer writes it): then in-app updates are on; otherwise the exe creates its own Start Menu shortcut.

**App mode** (`--app` or exe): opens `http://localhost:PORT` with `chrome.exe`/`msedge.exe --app=...` (falls back to the default browser). It counts SSE connections from loopback; when the last local one has been gone for 6 s the process exits (so a page refresh doesn't kill it).

**Uploads** stream to a hidden temp file `shared/.up-xxxx`, then are renamed to a unique name (`name (1).jpg` …). Half-finished uploads never appear; aborted ones are deleted. `requestTimeout = 0` so multi-GB uploads aren't cut off after Node's default 5 minutes. 1 MB stream buffers. Disk full → HTTP 507 `{error:'disk full'}`.

**Thumbnails** are made **in the browser that uploads** (canvas → JPEG, short side 440px; for video, a frame at ~1s + duration), then POSTed to `/thumb`. While a thumbnail is expected (`?thumb=1` on upload) the file is hidden from `/api/files` (`pendingThumb`, max 5 s) so tiles appear once, already drawn.

**Live updates** via Server-Sent Events on `/api/events`: a plain `change` message (debounced) whenever files change (also triggered by `fs.watch` on `shared/`), plus named events `devices` and `saved`. Clients refetch `/api/files` on `change`. A 15 s poll is the fallback.

**Phone presence**: each page connects to `/api/events?id=<device id>&name=<iPhone|Android phone|...>`. Non-loopback connections are tracked as devices (8 s grace for screen-locks/reloads) and broadcast as `devices`.

**Saved tracking**: phones POST `/api/saved` after saving; the server keeps `savedBy` (in memory only) and the PC shows green ticks + "Remove saved".

**In-app updates** (section "in-app updates" in `server.js`; only when `INSTALLED` and `package.json` has `"repository": "github:<owner>/<repo>"`):
- 10 s after start and every 6 h, `checkUpdate()` fetches `https://api.github.com/repos/<repo>/releases/latest`. That endpoint skips pre-releases and drafts, so **only stable releases are offered**. A release counts once its tag (`v1.2.3`) is numerically newer than `VERSION` and both `PhoneDrop-Setup.exe` and `PhoneDrop-Setup.exe.sha256` are attached (a just-published release has no assets until CI finishes; it's picked up next time). Offline or rate-limited → silently try again later.
- Found → `update = {version, notes, page, url, sumUrl, size, state, error}`. `notes` is the release body above `<!-- install -->` (what the owner wrote). It reaches the page via `/api/info` and the SSE event `update`, **loopback clients only** (`sendLocal`): phones never hear about it.
- `POST /api/update/install` (loopback only, else 403) → `installUpdate()`: `state` goes `downloading` (SSE `update-progress` `{got,total}`, ~5/s) → `installing` → `restarting`, or ends in `failed` (with `error`) / `cancelled`. Downloads only from `github.com`, `objects.githubusercontent.com` and `release-assets.githubusercontent.com`, following redirects by hand (`githubGet`) so every hop is checked. Saves to `%TEMP%\PhoneDrop-Setup-<version>.exe`, gives up if nothing arrives for 60 s, checks the size and the SHA-256 from the `.sha256` asset, and deletes the file on any failure.
- Launch: `powershell Start-Process -FilePath <setup> -ArgumentList '/S'`. It must be `Start-Process` (ShellExecute): a plain `spawn` of an exe that requires admin fails on Windows instead of showing the UAC prompt. PowerShell exits 1 if UAC is answered No → `cancelled` (PhoneDrop keeps running, "Try again"). Exit 0 → write `updated.txt`, `restarting`, exit after 1 s. The silent installer replaces the exe and reopens PhoneDrop (`.onInstSuccess`).
- Next start sees `updated.txt` (`justUpdated()`): it **keeps the shared files** (no `clearOld`) and **doesn't open a window for 5 s**, because the old window is still open and reloads itself (the page polls `/api/info` until the server no longer says `restarting`). If no window connects within 5 s, it opens one. Leftover `PhoneDrop-Setup-*.exe` files in `%TEMP%` are deleted 10 s after start.

### HTTP API

| Method & path | What it does |
|---|---|
| `GET /` | the page (`public/index.html`) |
| `GET /icon.png`, `/favicon.png`, `/apple-touch-icon.png` | icons |
| `GET /api/info` | `{host, ip, http, https, app, version, update}` (`https` is null if HTTPS failed; `update` is `{version, notes, page, size, state, error}` or null, and always null for non-loopback clients) |
| `GET /api/files` | `[{name, size, type, mtime, thumb, saved, dur}]`, newest first. `saved` = number of phones that saved it, `dur` = video seconds |
| `GET /api/events?id&name` | SSE: `change` (default message), `devices` (`[{id,name}]`), `saved` (`{name,count,media}`); loopback only: `update` (same object as in `/api/info`, also sent on connect), `update-progress` (`{got,total}`) |
| `POST /api/saved` | body `{id, name, files:[names], media:bool}` |
| `GET /qr.svg?u=<url>` | QR code SVG |
| `POST /upload?name=<file>[&thumb=1]` | raw file body → `{name}` (final unique name) |
| `POST /thumb?name=<file>[&dur=<sec>]` | JPEG body (may be empty when only a duration is sent) |
| `GET/HEAD /files/<name>[?v=<mtime>][&dl=1]` | file with Range support (video seeking). `?v=` → cached forever (immutable); `dl=1` → download |
| `DELETE /files/<name>` | delete one file (+ thumbnail/metadata/saved state) |
| `DELETE /api/files` | delete everything |
| `GET /thumbs/<name>` | thumbnail JPEG |
| `POST /api/update/install` | loopback only (403 otherwise): download, verify and run the newer installer; progress arrives over SSE |

There is **no authentication** — anyone on the Wi-Fi who knows the link can use it. That's intentional for home use; don't expose it to the internet.

## How the page works (`public/index.html`)

One page serves both the PC and the phone. `body` gets class `desktop` or `mobile` (UA sniffing: `isIOS`, `isAndroid`, `isMobile`). CSS helpers: `.desk-only`, `.mob-only`, `.mob-flex`. Dark + light themes via CSS variables on `:root` and `prefers-color-scheme`.

Script sections (search for the `/* ===== ... ===== */` banners):

1. **setup** — platform detection. `canShareFiles` (secure context + `navigator.canShare({files})`), `useShare = isIOS && canShareFiles`. Constants `BATCH_MAX=25`, `BATCH_BYTES=300MB`. Inline SVG icons in `IC`.
2. **small helpers** — `fmt` (bytes), `kind(f)` (image/video/file), `showable(f)` (HEIC only shown on Apple), `key(f)` = `name|mtime|size` (identity of a file version), `toast`, `sheet()` (generic modal/bottom sheet returning the chosen action index), `confirmBox`, `showHelp` ("Phone can't connect?").
3. **connection info** — fetches `/api/info`; desktop QR + Secure/Plain switch + Copy; on an iPhone using the plain HTTP link shows the "Turn on Save to Photos" banner pointing at the HTTPS link.
4. **file list + live updates** — `load()` fetches `/api/files` (skips work if JSON unchanged); EventSource handles `change`/`devices`/`saved`. Device id is random, stored in `localStorage['pd.id']`.
5. **grid** — keyed reconcile: one DOM node per file (`nodes[name]`), created once, moved/removed as needed → no flicker. Tile = `.tile > .m` (media) + `.vid` (play icon + duration) + `.svd` (green saved tick) + `.chk` (selection circle). Image src = thumbnail if present, else the original (if `showable`), else a file "face" (extension badge + name). Images use `?v=mtime` so they're cached forever.
6. **chrome** — `renderChrome()` updates header subtitle, toolbar (count/size, Select all, Remove saved, Clear all), empty state, desktop hero vs slim "iPhone connected" bar, the desktop selection pill, and calls `renderDock()` on phones.
7. **selection** — Select/Done button; tap toggles while selecting; **long-press (320 ms) then slide** selects the range between start tile and finger like the Photos app (auto-scrolls near edges; starts on a selected tile → deselects); mouse press-and-drag; Shift-click range; Ctrl/Cmd-click; Ctrl+A; Esc; Delete key (desktop).
8. **progress helpers** — `Meter` (smoothed bytes/s → time left), `fmtLeft`, `fmtDur`, `throttle`.
9. **saving on the phone** — the bottom **dock** button is a state machine (`dockMode`):
   - `send` (no files: pick files to send to PC) · `secure` (iPhone on HTTP → go to HTTPS link) · `download` (Android/non-share: triggers browser downloads) · `big` · `prep` · `share` · `retry` · `again` (all saved → sheet: Remove from computer / Save again) · `selectfiles` · `none`.
   - **Targets** = selected files when selecting, else all unsaved photos/videos. `nextBatch()` takes up to 25 files / 300 MB, media first, never mixing media with other files (so the share sheet offers "Save N Images").
   - Batches ≤ 300 MB are **prefetched automatically** in the background (XHR `responseType='blob'`, 3 at a time, progress per byte) so the user's tap opens the share sheet instantly — iOS requires `navigator.share` to run directly inside a tap, it can't wait for a download. Bigger batches (long videos) only download after a tap (`big` → `prep` with % / MB / time left / cancel ✕ → `share` "Downloaded · tap to save"). Over 1.5 GB a sheet offers "Download to Files" instead.
   - Only the current batch is kept in memory (`cache`); everything else is aborted/evicted.
   - After a successful share: `markSaved()` → `localStorage['pd.saved']` (per phone, keyed by `key(f)`) + POST `/api/saved`. If the share fails with many files, `batchSize` halves.
10. **desktop actions** — delete (confirm sheet), download selected, Clear all, Remove saved.
11. **update banner** (desktop only) — `#upd` above the hero/slim bar, fed by `setUpdate()` (from `/api/info` and SSE `update`) and `updProgress()` (SSE `update-progress`). `renderUpdate()` draws each server `state`: available ("PhoneDrop X is available" · What's new · Later · **Update now**), `downloading` (% · MB of MB · time left via `Meter`, bar), `installing` ("Click Yes if Windows asks…"), `restarting` (polls `/api/info` every 1.5 s, reloads once the server stops saying `restarting`), `cancelled` and `failed` (red; Try again; failed also shows "Download it manually" → release page). What's new = `sheet()` with `notesHtml()` (escapes HTML, light Markdown: headings/bold → `<b>`, bullets → •, links/code → text). **Later** stores `localStorage['pd.skipUpdate'] = version`: hidden until a newer version, with a small "Update to X" link in the footer (`#updFoot`) as a way back.
12. **uploading** — used by both PC (drop/paste/choose) and phone (`#sendBtn`). Per file: make thumbnail → XHR POST with progress → POST thumbnail. 3 in parallel. Each file gets a **pending tile** in `#pgrid` with a progress ring (% shown for files > 8 MB). Panel `#up` shows "Sending 3 of 12 · 45% · 200 MB of 506 MB · 50 MB/s · 6s left" and a cancel ✕.
13. **drag & drop** — whole-window overlay (`#ov`), counts dragenter/leave depth, only reacts to real files; paste (Ctrl+V) uploads clipboard files.
14. **viewer** (lightbox `#lb`) — thumbnail first then full image (top loading bar), video with controls + poster, file face for others. Swipe left/right, swipe down to close, arrow keys, Esc, browser Back (history.pushState). On iPhone the Save button prefetches the file (≤ 300 MB automatically, bigger on tap with in-button progress) then shares it.
15. **keyboard** — modal: Esc/Enter; viewer: arrows/Esc; grid: Ctrl+A, Esc, Delete.

Key element ids: `#grid`, `#pgrid` (uploading tiles), `#hero`, `#slim`, `#tools`, `#dock` + `#save` (`#t1`, `#t2`, `#fill`, `#lead`), `#cancelBtn`, `#sendBtn`, `#delBtn`, `#pill`, `#up`, `#ov`, `#lb`, `#modal`, `#toast`, `#upd` (`#updT`, `#updS`, `#updBar`, `#updGo`, `#updLater`, `#updNotes`, `#updMan`), `#updFoot`.

`localStorage` keys: `pd.id` (device id), `pd.saved` (what this phone saved), `pd.skipUpdate` (version dismissed with Later).

## Building the Windows app (`npm run build`)

`scripts/build.mjs`:
1. Picks a Windows `node.exe` (the running one on Windows; on Linux/macOS it fetches `node-win-x64@<same version>` from npm into `.cache/`).
2. Writes a SEA config (`main: server.js`, `assets:` the `ASSETS` list, `useCodeCache:false`) and runs `node --experimental-sea-config`.
3. Copies node.exe → `dist/PhoneDrop.exe`, injects the blob with `postject`.
4. **Then** sets icon + version info with `resedit` (doing this *before* postject corrupts the PE relocation table — keep the order).
5. Patches the PE subsystem to GUI (2) so no console window appears.
6. Runs `makensis -WX -DVERSION=<package.json version> installer/installer.nsi` → `dist/PhoneDrop-Setup.exe` (~21 MB, LZMA). Uses `MAKENSIS` env var if set; on Windows looks in Program Files\NSIS. On Linux, `apt-get install nsis` works (the whole build runs fine on Linux).

The installer (`installer.nsi`, NSIS Modern UI 2): Welcome → Components (Desktop shortcut ✓, Start with Windows ☐) → Folder (`Program Files\PhoneDrop`) → Install → Finish ("Open PhoneDrop now", launched via `explorer.exe` so it runs **un-elevated** — an elevated window can't receive drag & drop from Explorer). It kills a running PhoneDrop first (so it doubles as the updater), writes `installed.txt`, all-users Start Menu shortcut, removes old per-user shortcuts, adds firewall rule `PhoneDrop` (program-based, all profiles), registers in Settings → Apps with an uninstaller (which also removes `%LOCALAPPDATA%\PhoneDrop`). Requires admin (that's the shield on the icon). Unsigned → SmartScreen "More info → Run anyway".

Silent mode (`/S`, used by the in-app updater): no pages; `.onInit` reads `HKLM\Software\PhoneDrop\InstallDir` itself (with the 64-bit registry view) so the update lands in the existing folder (`InstallDirRegKey` reads the 32-bit view and misses it); the desktop shortcut is only refreshed if it still exists; `.onInstSuccess` reopens PhoneDrop through `explorer.exe` (un-elevated).

## Releasing (`.github/workflows/release.yml`)

**Nothing is built on a push to `main`.** The workflow runs on `release: published`:
1. The owner creates a release on GitHub (Releases → Draft a new release → new tag like `v1.0.1` → Publish). The release tag is the version: it must be `vMAJOR.MINOR.PATCH` (three numbers, no suffix, because Windows version resources need numbers); anything else fails the job with a clear error. If `package.json` differs, the job warns and builds the tag's version anyway (`npm version <tag> --no-git-tag-version`, not committed).
2. On `windows-latest` (bash): checkout of the tagged commit → Node 22 → `npm ci` → NSIS 3.11 from the official portable zip (SourceForge, pinned SHA-256; the runner image no longer has NSIS and Chocolatey's feed timed out on the very first run) → `npm run build` → `PhoneDrop-Setup.exe.sha256`.
3. `gh release upload <tag> PhoneDrop-Setup.exe PhoneDrop-Setup.exe.sha256 --clobber`, then appends `<!-- install -->` + `.github/release-notes.md` + "Built from <commit>" to the release notes (only once, so re-running the job is safe; pre-releases also get a "test version" line).

**Stable vs test:** a normal release becomes GitHub's "latest": the README download link (`/releases/latest/download/PhoneDrop-Setup.exe`) and installed apps follow it. "Set as a pre-release" builds an installer too, but neither the link nor the in-app updater sees it. Older releases are kept (nothing is deleted).

## Testing

There are no automated tests in the repo yet. What has been used to verify changes (please keep doing this):
- Playwright (Chromium) at desktop 1440×900 and iPhone 393×852 (iPhone Safari user agent, `isMobile`, `hasTouch`), dark and light.
- iOS sharing is faked by stubbing `navigator.canShare`/`navigator.share` in an init script; the stub hashes each shared `File` with `crypto.subtle.digest('SHA-256')` so you can assert the bytes equal the originals.
- A phone must connect from a non-loopback address to count as a "device" (e.g. `curl --interface 127.0.0.2 http://127.0.0.2:3000/api/events?id=x&name=iPhone`).
- Big-file paths: a ~400 MB file + throttled network (CDP `Network.emulateNetworkConditions`) to see progress, speed, ETA and cancel.
- Long-press glide: CDP `Input.dispatchTouchEvent` (touchStart, wait 450 ms, touchMove…, touchEnd).
- Exe runtime: build the same SEA for Linux (`node --experimental-sea-config` + `postject` on a copy of `node`) and run it — it exercises `IS_EXE`, assets and app mode.
- In-app updates (not in the repo; recreate in a scratch folder): a preload `node -r harness.js server.js` that makes `require('node:sea')` return `{isSea: () => true, getAsset}` (assets read from the repo; `package.json` version overridable), sets `process.execPath` to a folder containing `installed.txt`, points `LOCALAPPDATA`/`TMPDIR` at scratch folders, replaces `global.fetch` with fake GitHub answers (release JSON → 302 → a throttled stream of the real `dist/PhoneDrop-Setup.exe`, plus its `.sha256`), and replaces `child_process.spawn` with a stub whose `powershell` "exits" 0 or 1. Then drive the page with Playwright: available → What's new → Update now → progress → installing → restarting; start a second server with the new version and check the old window reloads, files are kept and no second window opens. Also: UAC No (`cancelled`), bad checksum, redirect to a non-GitHub host, Later + footer link, phones (non-loopback `/api/info` has `update: null`, install → 403), no checks in dev / non-installed exe. Real Windows still needs a manual check: UAC prompt, silent install, reopen.

Real-device checks still matter: share sheet on a real iPhone, Windows firewall, installer UAC/SmartScreen.

## Planned work

### 0. Put the repo on GitHub (first) — done
Repo: `dhairyakhetan/PhoneDrop`, default branch `main`. Kept for reference:
- `git init -b main`, commit everything, then create the GitHub repo and push (`gh repo create phonedrop --public --source . --push`, or via github.com). It should be **public**: the in-app updater reads releases without a token, and the README download link must work for anyone.
- Replace `YOUR-USERNAME` in `README.md` with the real GitHub username, and add `"repository": "github:<owner>/phonedrop"` to `package.json`.
- `package-lock.json` is committed so CI can use `npm ci`.

### 1. CI: build the installer and publish it on GitHub — done (now release-triggered)

First built on every push to `main` (version `MAJOR.MINOR.<run number>`, older releases deleted). The owner then asked for builds and updates **only after a stable release**, so the workflow now runs when a GitHub release is published (see **Releasing**). The first push-triggered run failed (NSIS missing, Chocolatey 504), so no release was ever published by it.

### 2. In-app updates ("Update available" banner) — done

Implemented. Beyond the original plan: only stable releases (via `/releases/latest`), shared files kept and the same window reused across the update, Later has a footer link as a way back, and the silent installer updates the existing folder and doesn't re-add a deleted desktop shortcut. See **In-app updates**, the page's section 11 and **Releasing**. Still to check on a real Windows PC: the UAC prompt, the silent install and PhoneDrop reopening.

### Nice-to-haves (only if asked)
Code signing (removes SmartScreen/red-shield friction), a per-user (no admin) install option, an automated Playwright test script in the repo.

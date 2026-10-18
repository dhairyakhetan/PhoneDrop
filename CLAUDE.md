# CLAUDE.md — PhoneDrop

Instructions and reference for working on this repo with Claude Code. Read this whole file before changing anything.

## Talking to the owner

- **Start every response with the owner's name: "DHAIRYA".** The owner asked for this explicitly and wants it remembered. It applies to every reply, in every session.
- **Work on `main` and push straight to `main`** (no feature branches, no PRs) until the owner says otherwise. Pushing to `main` builds nothing; releases only happen when the owner publishes one (see **Releasing**).

## What PhoneDrop is

A tiny local web app that moves photos, videos and files **between a Windows PC and a phone on the same Wi-Fi or the phone's hotspot**, both ways. The PC runs a Node.js server; the phone opens a page served by it (via QR code). Originals are never touched (EXIF date/location intact).
- **Android:** one tap saves a batch of photos/videos to the phone (Downloads → shows in the Gallery). No certificate warning.
- **iPhone:** one tap sends a batch to the iOS share sheet → **Save N Images** → straight into Photos (needs the HTTPS link).
- **Phone → PC:** files sent from a phone count as transferred once the PC downloads them.

Main users: people **without the Apple-only route (AirDrop)**: Windows laptops with Android phones, and Windows laptops with iPhones. The owner is learning to program, so keep explanations plain and the code readable.

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
public/icon.svg           THE app icon (page/window icon, sharp at any size); everything below is rendered from it
public/icon.png           256px PNG of icon.svg
public/favicon.png        32px PNG of icon.svg
public/apple-touch-icon.png  180px iPhone home-screen icon (icon.svg, square and opaque: iOS rounds it)
vendor/qrcode.js          qrcode-generator 1.4.4 (MIT, Kazuhiko Arase) — used server-side to draw the QR SVG
assets/PhoneDrop.ico      Windows icon for the .exe and the installer: icon.svg at 16,20,24,32,40,48,64,96,128,256 px
installer/installer.nsi   NSIS installer wizard script
installer/wizard.bmp      164x314 side image for Welcome/Finish pages
installer/header.bmp      150x57 header image for inner pages
scripts/build.mjs         builds dist/PhoneDrop.exe + dist/PhoneDrop-Setup.exe
package.json              version for dev runs/local builds (CI overwrites it with the release tag); "repository" = update source
.github/workflows/release.yml  CI: when a release is published, builds the installer and attaches it to that release
.github/release-notes.md  install help appended to each release's notes, below an <!-- install --> marker
```

**Changing the icon:** edit `public/icon.svg`, then re-render the PNGs and `assets/PhoneDrop.ico` from it (the last ones were made by screenshotting the SVG in Playwright Chromium at each size with a transparent background; the `.ico` is a plain ICO header + one PNG per size). Keep the same file names; `server.js` and `scripts/build.mjs` already list them.

Runtime folders created next to `server.js` when run from the repo (gitignored): `shared/` (the shared files, `shared/.thumbs/` for thumbnails + `<name>.json` metadata: `dur`, `from`) and `.certs/` (self-signed HTTPS cert + `ips.json`). When running as the installed .exe these live in `%LOCALAPPDATA%\PhoneDrop\` instead (plus `error-log.txt`, `update-log.txt` (one line per in-app update), and `updated.txt` for a moment during an update).

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

**Two servers, same handler.** HTTP on 3000 and HTTPS on 3443. HTTPS exists because **iOS only allows `navigator.share({files})` (→ "Save to Photos") on a secure page.** Android never needs it. The cert is self-signed, generated in pure Node (hand-rolled DER/X.509 in `makeSelfSigned(ips)`). `ensureCert()` keeps it in `.certs/` with **every address PhoneDrop was reachable at lately** in the SAN (current ones first, up to 10, list in `ips.json`) + localhost. It is regenerated only when a new address appears, and swapped into the running HTTPS server with `setSecureContext` (no restart). Going back to a network used before keeps the same cert, so iPhones don't see the warning again. The iPhone sees a one-time "not private" warning (Show Details → visit this website).

**Network** (section "network" in `server.js`) — which address phones should use, and which Wi-Fi that is:
- `candidates()`: IPv4 adapters, minus loopback, link-local `169.254.x` and **virtual adapters** (`VIRTUAL` regex: vEthernet/WSL/Hyper-V, VirtualBox, VMware, Docker, VPNs/TAP/WireGuard/Tailscale, Bluetooth…). Phones can't reach those; the old "prefer 192.168.x" rule picked VirtualBox's 192.168.56.1 over the real Wi-Fi.
- `routeIP()`: the local address of the default route (UDP `connect` to 1.1.1.1 sends nothing). That adapter wins; then Wi-Fi (`WIFI` regex or a known SSID) over wired.
- `lookupSSIDs()`: Wi-Fi names per adapter. Windows: PowerShell `Get-NetConnectionProfile` (+ `Get-NetAdapter` media type) — the profile name is the Wi-Fi name, and unlike `netsh wlan` it doesn't need location permission (Windows 11 24H2+). macOS: `ipconfig getsummary <if>`. Linux: `nmcli`. Run at start, on every network change and every 2 min (not every 4 s: PowerShell is slow to start).
- `describe()`: `{ip, iface, kind: wifi|wired, ssid, hotspot}`. `hotspot: 'phone'` = this computer is on a phone's hotspot (172.20.10.x = iPhone, 192.168.43.x = older Android, or an SSID like "…iPhone"/"Galaxy"/"Pixel"/"AndroidAP"); `'pc'` = 192.168.137.1, Windows' own Mobile hotspot.
- `watchNet()` every 4 s: on a change it logs `Network changed`, updates the cert and broadcasts SSE `net`. `net.nets` (primary first) is exposed through `/api/info` with an `http`/`https` URL for each network.

**Two-way files.** Uploads from a non-loopback client store `from: {id, name}` (the phone's device id/name, sent as `?from=&fromName=`) in the file's metadata (`setMeta`). `/api/files` returns it as `from`/`fromId`. A **download to this PC** (`GET /files/<name>?dl=1` from loopback) that finishes to the last byte adds the name to `gotOnPc` (in memory) → `got: true`. For a phone's file that's what "transferred" means; the sending phone shows it as saved too.

**Exe mode** (`IS_EXE` = `require('node:sea').isSea()`): always app mode; data in `%LOCALAPPDATA%\PhoneDrop`; uncaught errors appended to `error-log.txt` there (the exe has no console). `INSTALLED` = exe mode and `installed.txt` sits next to the exe (the installer writes it): then in-app updates are on; otherwise the exe creates its own Start Menu shortcut.

**App mode** (`--app` or exe): opens `http://localhost:PORT` with `chrome.exe`/`msedge.exe --app=...` (falls back to the default browser). It counts SSE connections from loopback; when the last local one has been gone for 6 s the process exits (so a page refresh doesn't kill it).

**Uploads** stream to a hidden temp file `shared/.up-xxxx`, then are renamed to a unique name (`name (1).jpg` …). Half-finished uploads never appear; aborted ones are deleted. `requestTimeout = 0` so multi-GB uploads aren't cut off after Node's default 5 minutes. 1 MB stream buffers. Disk full → HTTP 507 `{error:'disk full'}`.

**Thumbnails** are made **in the browser that uploads** (canvas → JPEG, short side 440px; for video, a frame at ~1s + duration), **at the same time as the upload** (it doesn't wait for them), then POSTed to `/thumb` (empty body if none could be made). Every photo/video upload sends `?thumb=1`: the file is hidden from `/api/files` until its `/thumb` arrives (`pendingThumb`, max 5 s) so tiles appear once, already drawn.

**Live updates** via Server-Sent Events on `/api/events`: a plain `change` message (debounced) whenever files change (also triggered by `fs.watch` on `shared/`), plus named events `devices`, `saved` and `net`. Clients refetch `/api/files` on `change`. A 15 s poll is the fallback.

**Phone presence**: each page connects to `/api/events?id=<device id>&name=<iPhone|Android phone|...>`. Non-loopback connections are tracked as devices (8 s grace for screen-locks/reloads) and broadcast as `devices`.

**Saved tracking**: phones POST `/api/saved` after saving; the server keeps `savedBy` (in memory only) and the PC shows green ticks + "Remove saved".

**In-app updates** (section "in-app updates" in `server.js`; only when `INSTALLED` and `package.json` has `"repository": "github:<owner>/<repo>"`):
- 10 s after start and every 6 h, `checkUpdate()` fetches `https://api.github.com/repos/<repo>/releases/latest`. That endpoint skips pre-releases and drafts, so **only stable releases are offered**. A release counts once its tag (`v1.2.3`) is numerically newer than `VERSION` and both `PhoneDrop-Setup.exe` and `PhoneDrop-Setup.exe.sha256` are attached (a just-published release has no assets until CI finishes; it's picked up next time). Offline or rate-limited → silently try again later.
- Found → `update = {version, notes, page, url, sumUrl, size, state, error}`. `notes` is the release body above `<!-- install -->` (what the owner wrote). It reaches the page via `/api/info` and the SSE event `update`, **loopback clients only** (`sendLocal`): phones never hear about it.
- `POST /api/update/install` (loopback only, else 403) → `installUpdate()`: `state` goes `downloading` (SSE `update-progress` `{got,total}`, ~5/s) → `installing` → `restarting`, or ends in `failed` (with `error`) / `cancelled`. Downloads only from `github.com`, `objects.githubusercontent.com` and `release-assets.githubusercontent.com`, following redirects by hand (`githubGet`) so every hop is checked. Saves to `%TEMP%\PhoneDrop-Setup-<version>.exe`, gives up if nothing arrives for 60 s, checks the size and the SHA-256 from the `.sha256` asset, and deletes the file on any failure.
- Launch: a hidden, detached **PowerShell helper** that outlives PhoneDrop. It runs `Start-Process -FilePath <setup> -ArgumentList '/S' -PassThru`. It must be `Start-Process` (ShellExecute): a plain `spawn` of an exe that requires admin fails on Windows instead of showing the UAC prompt. UAC answered No → the helper exits 1 → `cancelled` (PhoneDrop keeps running, "Try again"). Yes → the helper writes `updated.txt`; PhoneDrop polls for that file (250 ms), goes `restarting` and exits after 1 s (the installer would close it anyway). The helper then waits for the installer process (max 5 min), waits 10 s, and **if no `PhoneDrop` process is running it starts PhoneDrop itself** (un-elevated, as the user). It appends a line to `update-log.txt`: installer exit code + whether PhoneDrop reopened or it had to start it.
- Why all the safety nets: the first real update (1.0.0 → 1.1.0, Oct 2026) installed but PhoneDrop never came back on the owner's PC and the page spun forever. The same installers did reopen it under Wine, so it's something on that PC: most likely the `explorer.exe` hand-off, maybe a lock or antivirus. 1.0.0 had none of these nets; the installer-side ones help every update from now on (the installer is always the new version's), the helper only updates started from 1.1.1 or later.
- Next start sees `updated.txt` (`justUpdated()`): it **keeps the shared files** (no `clearOld`) and **doesn't open a window for 5 s**, because the old window is still open and reloads itself (the page polls `/api/info` until the server no longer says `restarting`). If no window connects within 5 s, it opens one. Leftover `PhoneDrop-Setup-*.exe` files in `%TEMP%` are deleted 10 s after start.

### HTTP API

| Method & path | What it does |
|---|---|
| `GET /` | the page (`public/index.html`) |
| `GET /icon.svg`, `/icon.png`, `/favicon.png`, `/apple-touch-icon.png` | icons |
| `GET /api/info` | `{host, app, version, update, ip, http, https, nets}`. `ip/http/https` = primary network (`https` null if HTTPS failed; `ip` is `localhost` with no network). `nets` = `[{ip, iface, kind, ssid, hotspot, http, https}]`, primary first. `update` is `{version, notes, page, size, state, error}` or null, and always null for non-loopback clients |
| `GET /api/files` | `[{name, size, type, mtime, thumb, saved, dur, from, fromId, got}]`, newest first. `saved` = number of phones that saved it, `dur` = video seconds, `from`/`fromId` = the phone that sent it ('' if added on the PC), `got` = downloaded to this PC |
| `GET /api/events?id&name` | SSE: `change` (default message), `devices` (`[{id,name}]`), `saved` (`{name,count,media}`), `net` (same fields as `/api/info`'s `ip/http/https/nets`); loopback only: `update` (same object as in `/api/info`, also sent on connect), `update-progress` (`{got,total}`) |
| `POST /api/saved` | body `{id, name, files:[names], media:bool}` |
| `GET /qr.svg?u=<url>` | QR code SVG |
| `POST /upload?name=<file>[&thumb=1][&from=<device id>&fromName=<name>]` | raw file body → `{name}` (final unique name). `from` is only recorded for non-loopback senders |
| `POST /thumb?name=<file>[&dur=<sec>]` | JPEG body (may be empty when only a duration is sent) |
| `GET/HEAD /files/<name>[?v=<mtime>][&dl=1]` | file with Range support (video seeking). `?v=` → cached forever (immutable); `dl=1` → download (from loopback, a finished one sets `got`) |
| `DELETE /files/<name>` | delete one file (+ thumbnail/metadata/saved state) |
| `DELETE /api/files` | delete everything |
| `GET /thumbs/<name>` | thumbnail JPEG |
| `POST /api/update/install` | loopback only (403 otherwise): download, verify and run the newer installer; progress arrives over SSE |

There is **no authentication** — anyone on the Wi-Fi who knows the link can use it. That's intentional for home use; don't expose it to the internet.

## How the page works (`public/index.html`)

One page serves both the PC and the phone. `body` gets class `desktop` or `mobile` (UA sniffing: `isIOS`, `isAndroid`, `isMobile`; tablets get `mobile` too). CSS helpers: `.desk-only`, `.mob-only`, `.mob-flex`. Dark + light themes via CSS variables on `:root` and `prefers-color-scheme`.

**Buttons:** `.btn` (40 px) / `.btn.sm` (32 px chips), variants `primary`, `tint` (soft accent), `ghost`, `danger`, `solid-danger`; icon + label via `setBtn(el, IC.x, label)`. Touch screens (`pointer:coarse`) get 44 px buttons, 36 px chips, 50 px viewer/sheet buttons. Keyboard focus shows a ring (`:focus-visible`).

**Sizes** (the "in-between sizes" block at the end of `<style>`): PC window ≥1600 (wider page, bigger tiles) · ≤1100 (smaller QR) · ≤900 (QR card and drop card stacked) · ≤760 (smaller tiles, "phone connected" bar stacks, selection pill full width) · ≤560 (QR card stacks, picker full width). Phone layout: <360 (3 columns, compact dock) · landscape phones `max-height:500px` (compact header/dock/viewer) · tablets `min-width:700px and min-height:501px` (spaced rounded tiles, viewer arrows). Check all of these with screenshots when changing layout.

Script sections (search for the `/* ===== ... ===== */` banners):

1. **setup** — platform detection. `canShareFiles` (secure context + `navigator.canShare({files})`), `useShare = isIOS && canShareFiles`, `useBlob = isMobile && !isIOS` (Android & co), `usePrefetch = useShare || useBlob`. Constants `BATCH_MAX=25`, `BATCH_BYTES=300MB`. Inline SVG icons in `IC`.
2. **small helpers** — `fmt` (bytes), `kind(f)` (image/video/file), `showable(f)` (HEIC only shown on Apple), `key(f)` = `name|mtime|size` (identity of a file version), `ownFile(f)` (this phone sent it), `doneOnPc(f)` (PC view of "transferred": a phone's file once downloaded here, a PC file once a phone saved it), `toast`, `setBtn`, `sheet()` (generic modal/bottom sheet returning the chosen action index), `confirmBox`, `showHelp` ("Phone can't connect?", names the Wi-Fi and explains the hotspot route).
3. **connection info** — fetches `/api/info` (and applies SSE `net` via `applyNet`). PC: QR card with an **Android / iPhone** picker (`localStorage['pd.phone']`, default Android): Android → plain http link (no warning), iPhone → https link (needed for Save to Photos). `netLine()` says what to do: "Connect your phone to the Wi-Fi **X**", "This computer is on the hotspot **X**", cable, the PC's own hotspot, or "Not connected to a network" (QR card turns into `.nonet`). Network chips (`#nets`) when the PC is on more than one network. The header shows `netShort()` ("· Wi-Fi HomeNet"). Phones: Android on the https link is moved to http; iPhone on http gets the "Turn on Save to Photos" banner. Links are built from `location.hostname`, so they match the network the phone actually used.
4. **file list + live updates** — `load()` fetches `/api/files` (skips work if JSON unchanged; on the PC toasts "iPhone sent 3 files"); EventSource handles `change`/`devices`/`saved`/`net`/`update`. Phones show `#lost` ("Can't reach the computer · make sure this phone is on Wi-Fi X") after 4 s offline. Device id is random, stored in `localStorage['pd.id']`.
5. **grid** — keyed reconcile: one DOM node per file (`nodes[name]`), created once, moved/removed as needed → no flicker. Tile = `.tile > .m` (media) + `.vid` (play icon + duration) + `.svd` (green tick) + `.dir` (arrow badge: `.inc` on the PC = from a phone, not downloaded yet; `.out` on a phone = sent by this phone, not downloaded by the PC yet) + `.chk` (selection circle). Image src = thumbnail if present, else the original (if `showable`), else a file "face" (extension badge + name). Images use `?v=mtime` so they're cached forever.
6. **chrome** — `renderChrome()` updates header subtitle, toolbar (count/size + chips: Select all, **Download from phone (N)**, Remove saved, Clear all), empty state, desktop hero vs slim "iPhone connected" bar, the desktop selection pill, and calls `renderDock()` on phones.
7. **selection** — Select/Done button; tap toggles while selecting; **long-press (320 ms) then slide** selects the range between start tile and finger like the Photos app (auto-scrolls near edges; starts on a selected tile → deselects); mouse press-and-drag; Shift-click range; Ctrl/Cmd-click; Ctrl+A; Esc; Delete key (desktop).
8. **progress helpers** — `Meter` (smoothed bytes/s → time left), `fmtLeft`, `fmtDur`, `throttle`.
9. **saving on the phone** — the bottom **dock** button is a state machine (`dockMode`):
   - `send` (nothing from the PC: pick files to send; t2 says "3 files sent · 1 saved on computer") · `secure` (iPhone on HTTP → go to HTTPS link) · `download` (fallback when nothing can be prefetched: plain browser downloads) · `big` · `prep` · `share` · `retry` · `again` (all saved → sheet: Remove from computer / Save again) · `selectfiles` · `none`.
   - **Targets** = selected files when selecting, else all unsaved photos/videos **except the ones this phone sent**. `nextBatch()` takes up to 25 files / 300 MB, media first, never mixing media with other files (so the share sheet offers "Save N Images").
   - Batches ≤ 300 MB are **prefetched automatically** in the background (XHR `responseType='blob'`, 3 at a time, progress per byte) so the user's tap opens the share sheet instantly — iOS requires `navigator.share` to run directly inside a tap, it can't wait for a download. Bigger batches (long videos) only download after a tap (`big` → `prep` with % / MB / time left / cancel ✕ → `share` "Downloaded · tap to save"). Over 1.5 GB a sheet offers "Download to Files" instead.
   - Only the current batch is kept in memory (`cache`); everything else is aborted/evicted.
   - **iPhone** (`share` tap): `navigator.share`. **Android** (`useBlob`): `saveBlobs()` clicks a `blob:` download link per file, 250 ms apart → Downloads/Gallery, instant because the bytes are already on the phone, and no "insecure download" warning on the http page. Over 1.5 GB: "Download directly".
   - While the **viewer** is open, background downloads pause (`pfPaused()`, unless the user started them) and the in-flight ones are aborted, so the photo being looked at gets the whole Wi-Fi.
   - After saving: `markSaved()` → `localStorage['pd.saved']` (per phone, keyed by `key(f)`) + POST `/api/saved`. If the share fails with many files, `batchSize` halves.
10. **desktop actions** — delete (confirm sheet), download selected, Clear all, Remove saved (`doneOnPc`), Download from phone (`#getBtn`).
11. **update banner** (desktop only) — `#upd` above the hero/slim bar, fed by `setUpdate()` (from `/api/info` and SSE `update`) and `updProgress()` (SSE `update-progress`). `renderUpdate()` draws each server `state`: available ("PhoneDrop X is available" · What's new · Later · **Update now**), `downloading` (% · MB of MB · time left via `Meter`, bar), `installing` ("Click Yes if Windows asks…"), `restarting`. From `installing` on, `waitForRestart()` polls `/api/info` every 1.5 s and reloads once the server answers without `installing`/`restarting`; if nothing answers for 60 s it shows "PhoneDrop didn't reopen by itself · Open PhoneDrop from the Start Menu" (keeps polling and still reloads if it comes back). `cancelled` and `failed` (red; Try again; failed also shows "Download it manually" → release page). What's new = `sheet()` with `notesHtml()` (escapes HTML, light Markdown: headings/bold → `<b>`, bullets → •, links/code → text). **Later** stores `localStorage['pd.skipUpdate'] = version`: hidden until a newer version, with a small "Update to X" link in the footer (`#updFoot`) as a way back.
12. **uploading** — used by both PC (drop/paste/choose) and phone (`#sendBtn`). Per file: XHR POST with progress (with `from`/`fromName`) **while** the thumbnail is made → POST thumbnail. 3 in parallel. Each file gets a **pending tile** in `#pgrid` with a progress ring (% shown for files > 8 MB). Panel `#up` shows "Sending 3 of 12 · 45% · 200 MB of 506 MB · 50 MB/s · 6s left" and a cancel ✕.
13. **drag & drop** — whole-window overlay (`#ov`), counts dragenter/leave depth, only reacts to real files; paste (Ctrl+V) uploads clipboard files.
14. **viewer** (lightbox `#lb`) — thumbnail first then full image (top loading bar), video with controls + poster, file face for others. Swipe left/right, swipe down to close, arrow keys, Esc, browser Back (history.pushState). On phones (`usePrefetch`) a photo ≤ 300 MB is **downloaded once** (`fetchFile`) and that blob is both shown (`lbUrl` object URL) and saved by the Save button ("Save to Photos" on iPhone, "Save to phone" on Android); before, the photo was downloaded twice. Bigger files download on tap with in-button progress.
15. **keyboard** — modal: Esc/Enter; viewer: arrows/Esc; grid: Ctrl+A, Esc, Delete.

Key element ids: `#grid`, `#pgrid` (uploading tiles), `#hero` (`#connect`, `#seg`, `#netLine`, `#nets`, `#linkRow`, `#qrOff`), `#slim`, `#tools` (`#getBtn`, `#clearSaved`), `#lost`, `#dock` + `#save` (`#t1`, `#t2`, `#fill`, `#lead`), `#cancelBtn`, `#sendBtn`, `#delBtn`, `#pill`, `#up`, `#ov`, `#lb`, `#modal`, `#toast`, `#upd` (`#updT`, `#updS`, `#updBar`, `#updGo`, `#updLater`, `#updNotes`, `#updMan`), `#updFoot`.

`localStorage` keys: `pd.id` (device id), `pd.saved` (what this phone saved), `pd.skipUpdate` (version dismissed with Later), `pd.phone` (PC: android/iphone link choice).

## Building the Windows app (`npm run build`)

`scripts/build.mjs`:
1. Picks a Windows `node.exe` (the running one on Windows; on Linux/macOS it fetches `node-win-x64@<same version>` from npm into `.cache/`).
2. Writes a SEA config (`main: server.js`, `assets:` the `ASSETS` list, `useCodeCache:false`) and runs `node --experimental-sea-config`.
3. Copies node.exe → `dist/PhoneDrop.exe`, injects the blob with `postject`.
4. **Then** sets icon + version info with `resedit` (doing this *before* postject corrupts the PE relocation table — keep the order).
5. Patches the PE subsystem to GUI (2) so no console window appears.
6. Runs `makensis -WX -DVERSION=<package.json version> installer/installer.nsi` → `dist/PhoneDrop-Setup.exe` (~21 MB, LZMA). Uses `MAKENSIS` env var if set; on Windows looks in Program Files\NSIS. On Linux, `apt-get install nsis` works (the whole build runs fine on Linux).

The installer (`installer.nsi`, NSIS Modern UI 2): Welcome → Components (Desktop shortcut ✓, Start with Windows ☐) → Folder (`Program Files\PhoneDrop`) → Install → Finish ("Open PhoneDrop now", launched via `explorer.exe` so it runs **un-elevated** — an elevated window can't receive drag & drop from Explorer). It kills a running PhoneDrop first (so it doubles as the updater), writes `installed.txt`, all-users Start Menu shortcut, removes old per-user shortcuts, adds firewall rule `PhoneDrop` (program-based, all profiles), registers in Settings → Apps with an uninstaller (which also removes `%LOCALAPPDATA%\PhoneDrop`). Requires admin (that's the shield on the icon). Unsigned → SmartScreen "More info → Run anyway".

Replacing the exe (every install): `CloseApp` taskkills PhoneDrop and waits (max 10 s) until `IsAppRunning` says it's gone (`cmd /c tasklist /NH | find "PhoneDrop.exe"`: works on Windows and under Wine; Wine's tasklist ignores `/FI` and its find has no `/I`). Then the old exe is **renamed** to `PhoneDrop.old` (a locked file can be renamed but not overwritten, so `File` can't fail and pop an error box nobody sees during a silent update), the new one written, and `PhoneDrop.old` deleted (`/REBOOTOK`).

Silent mode (`/S`, used by the in-app updater): no pages; `.onInit` reads `HKLM\Software\PhoneDrop\InstallDir` itself (with the 64-bit registry view) so the update lands in the existing folder (`InstallDirRegKey` reads the 32-bit view and misses it); the desktop shortcut is only refreshed if it still exists; `.onInstSuccess` reopens PhoneDrop through `explorer.exe` (un-elevated) and, **if PhoneDrop still isn't running 15 s later, starts it directly** (that copy runs as admin, so drag & drop from Explorer won't work until its next start, but the update never leaves the user without PhoneDrop).

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
- Windows installer under **Wine** (`apt-get install wine64`, plus `dpkg --add-architecture i386 && apt-get install wine32:i386`: the NSIS installer is 32-bit; binaries in `/usr/lib/wine`): download the real release installers, `wine PhoneDrop-Setup.exe /S` over a running copy, then check `installed.txt`, the process list and `localhost:3000/api/info`. Install time tells the reopen path (a few s = explorer hand-off, ≥15 s = fallback). To test the fallback, build a temporary copy of `installer.nsi` with an empty `LaunchApp`. 7-Zip (`7z x`) extracts `PhoneDrop.exe` from an installer, and the 64-bit exe runs under `wine64`.
- The update helper's PowerShell can be run with PowerShell 7 for Linux (GitHub release tarball): take the `-Command` string from a harness spawn log, swap in a fake installer script and a fake relaunch target, and check the three paths (not running → started, running → left alone, start fails → exit 1, no `updated.txt`).
- Exe runtime: build the same SEA for Linux (`node --experimental-sea-config` + `postject` on a copy of `node`) and run it — it exercises `IS_EXE`, assets and app mode.
- In-app updates (not in the repo; recreate in a scratch folder): a preload `node -r harness.js server.js` that makes `require('node:sea')` return `{isSea: () => true, getAsset}` (assets read from the repo; `package.json` version overridable), sets `process.execPath` to a folder containing `installed.txt`, points `LOCALAPPDATA`/`TMPDIR` at scratch folders, replaces `global.fetch` with fake GitHub answers (release JSON → 302 → a throttled stream of the real `dist/PhoneDrop-Setup.exe`, plus its `.sha256`), and replaces `child_process.spawn` with a stub whose `powershell` "exits" 0 or 1. Then drive the page with Playwright: available → What's new → Update now → progress → installing → restarting; start a second server with the new version and check the old window reloads, files are kept and no second window opens. Also: UAC No (`cancelled`), bad checksum, redirect to a non-GitHub host, Later + footer link, phones (non-loopback `/api/info` has `update: null`, install → 403), no checks in dev / non-installed exe. Real Windows still needs a manual check: UAC prompt, silent install, reopen.

- Networks (not in the repo): a preload that replaces `os.networkInterfaces`, `dgram.createSocket` (the route lookup) and `child_process.execFile('powershell')` with answers read from a JSON file on every call, and sets `process.platform = 'win32'`. Edit the file while the server runs to simulate: home Wi-Fi with WSL/VirtualBox/Bluetooth adapters, joining an iPhone hotspot live (page + QR + cert follow), the PC's own Mobile hotspot (two networks), cable only, no network.
- Phones from Wi-Fi: in a cloud container the agent proxy intercepts connections to the machine's own LAN address (HTTPS resets), so phones connect via `localhost` and a test preload marks requests with an iPhone/Android user agent as coming from `192.168.1.50` (`Object.defineProperty(req.socket, 'remoteAddress', …)`). Without that, phone uploads look like the PC's own.
- Android saving: Playwright `download` events; hash each saved file. iPhone: the share stub above.
- Speed: 25 × 12 MP JPEGs, phone throttled to 8 MB/s down (CDP), open photo #20 while the batch prefetches, time until the full image shows and Save is ready, and count requests for that file (should be 1). Was 1.77 s and 2 downloads on iPhone; now ~0.5 s and 1.
- Layout: screenshots at 1920/1440/1280/1024/820/640 (PC), 320/360/393/412/430 (phones), 852×393 (landscape), iPad 820/1180, Android tablet 800, dark and light; assert no horizontal scroll.

Real-device checks still matter: share sheet on a real iPhone, Android saving to the Gallery, phone hotspots, Windows firewall, the Wi-Fi name on Windows, installer UAC/SmartScreen.

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

### 3. Hotspots, Wi-Fi name, Android, two-way, speed, layouts, SVG icon — done

Owner's list (one round): works on a phone's hotspot (network detection that follows changes live, multi-address cert), says which Wi-Fi to join, first-class Android (link picker, one-tap save to Downloads), faster single-photo viewing/saving (one download, background downloads pause), phone → PC files count as transferred when the PC downloads them, better buttons and in-between layouts for all sizes, and `icon.svg` as the source of every icon. Still to check on real devices: see **Testing**.

### Nice-to-haves (only if asked)
Code signing (removes SmartScreen/red-shield friction), a per-user (no admin) install option, an automated Playwright test script in the repo.

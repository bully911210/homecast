# Decisions

Every dependency and every non-obvious choice, one line each. The rule: platform first, reuse second, delete third, write last.

## Runtime dependencies (6 of 6)

| Dep | Why it earns its place |
|---|---|
| `hono` | Tiny router on Web-standard `Request`/`Response`. Providers return a `Response`, so there's no adapter layer. |
| `@hono/node-server` | Runs Hono on Node's HTTP server and exposes the remote address for the LAN guard. |
| `ffmpeg-static` | One binary for remux, transcode, thumbnails (video, images with EXIF rotation, cover art) and subtitle extraction. Replaces sharp and any native image library. |
| `ffprobe-static` | Codec and duration probing for the playback decision. It ships ffprobe 4.0.2, which still probes HEVC, AV1, VP9 and DTS correctly (verified against the fixtures). |
| `qrcode` | Shows the LAN URL as a QR code on the admin page and in the console. Writing a QR encoder is not lazy. |
| `bonjour-service` | Optional `homecast.local` mDNS name. Off with `"mdns": false`; the QR code covers discovery anyway. |

`hls.js` is a client asset, not a server dependency. It's bundled as a separate file and only downloaded by browsers that need it (see below).

## Platform over libraries

- `node:sqlite` instead of better-sqlite3/Drizzle: no native compile. It's loaded with `process.getBuiltinModule` so it works inside the single executable, and only its own ExperimentalWarning is silenced.
- Schema lives in `server/schema.ts` as ordered migrations keyed by `PRAGMA user_version`. It's a TS string rather than a `.sql` file so it bundles into the exe untouched.
- `fs.watch({ recursive: true })` instead of chokidar, with a 2 s debounce. UNC paths and watch errors fall back to a 5-minute poll.
- A hand-written spatial navigation module (`client/nav.ts`, about 180 lines) instead of a library.
- Hand-written input guards (`shared/guards.ts`, about 70 lines) instead of Zod.
- `Readable.toWeb(fs.createReadStream(start, end))` for direct play: cancelling the web stream closes the file handle (covered by a leak test).

## Playback

- Exactly two paths. Direct play needs a trusted container: MP4/MOV, `.webm` files, or plain audio files. ffprobe reports MKV and WebM identically, so only the `.webm` extension counts.
- One pure `buildHlsArgs()`. Video is copied when it is 8-bit H.264, or HEVC on a device that reported HEVC (into fMP4 segments). Everything else is encoded to H.264. Audio is copied when it is AAC or MP3, otherwise encoded to stereo AAC.
- H.264 is assumed universal: it's also what we transcode to, so a device without it couldn't play anything anyway.
- `safe=1` retry: if a device fails to decode what its caps promised (Chrome reports HEVC even without a hardware decoder), the client retries once and the server sends plain H.264/AAC.
- The client uses hls.js wherever Media Source Extensions exist. Desktop Chrome's new native HLS treats our growing EVENT playlist as live and jumps to the live edge. Native HLS is the fallback for browsers without MSE (iOS Safari, some TVs).
- Playlists carry `#EXT-X-START:TIME-OFFSET=0` so native players start at the beginning, not the live edge.
- Seeking past what ffmpeg has produced restarts ffmpeg with `-ss`. The client keeps one clock (`offset + currentTime`), and repeated presses are debounced into one restart.
- A new start offset for the same item and device replaces the old job. Over the 2-job cap, the least recently used job is killed. Idle jobs die after 60 s. PIDs go to `pids.json`; leftovers are killed at startup, but only if the PID still belongs to an ffmpeg process.

## Security additions beyond the brief

- A `Host` allowlist (IP literals, `localhost`, `homecast.local`, this PC's name) against DNS rebinding, plus a same-origin check on every non-GET request.
- Admin writes require `Content-Type: application/json`, so a cross-site page can't send them without a CORS preflight, which we never answer.
- `/api/health` gives the LAN only `{ok, name, version}`. The full report goes to this PC and paired devices.

## Windows integration

- Start at logon uses the per-user Run key (`HKCU\...\Run`) via `reg.exe`, not `schtasks`. On a standard Windows 11 account, `schtasks /SC ONLOGON` returns "Access is denied" without admin, and HomeCast never asks for admin.
- Firewall: no installer rules. Windows shows its own prompt on first listen; the first-run notes say "Private only", and health reads the program's inbound rules and the network profile and warns about Public.
- Tray = PowerShell NotifyIcon, not Electron/Tauri: zero deps, survives server crash.
- The tray launches through `cmd /c start /min`: Windows PowerShell 5.1 exits immediately when spawned detached (no console), and a non-detached child dies with the server through libuv's job object.
- The tray polls every 4 s rather than 5 s, so a crash turns it red within 5 s with margin (measured 2.7 s).
- A second launch of the exe finds the port in use, opens the admin page and exits. The tray's named mutex guarantees one icon.

## TV UI

- Mouse = pointer events onto existing focus model, no second UI.
- Activation is always a native `click`; a focused `<button>` fires `click` on Enter, so remote and mouse share one code path.
- Hover focuses only on real pointer movement. Browsers fire hover events when content scrolls under a parked cursor (an LG Magic Remote), and those must not steal focus from the arrow keys.
- Left/right never leave the current row; up/down may drift to the nearest element above or below.
- Back is one path: the remote key, the on-screen ← Back button and browser back all go through `history.back()` → `popstate`.
- Tiles render in chunks of 60 with an IntersectionObserver sentinel, and thumbnails load lazily. That's enough "virtualisation" for TV CPUs without a windowing library.
- The brand (docs/brand) is two SVGs; the TV app draws the mark and its icons with createElementNS, so there are no image requests and no icon font. The client is 12 KB gzipped.
- Pixel sizes are rem-based with `html { font-size: 0.8333vw }`, so the 1920×1080 layout scales to 720p and 4K TVs.

## Packaging

- Node SEA: esbuild bundles the server into one CJS file, the client files are SEA assets, and `postject` injects the blob into a copy of `node.exe`. ffmpeg/ffprobe sit beside the exe.
- The exe is not code-signed, so SmartScreen shows "More info → Run anyway". The first-run notes say so.

## Known limits

- **Seek clock drift with copied video.** Seeking restarts ffmpeg with an input `-ss`. With `-c:v copy`, the stream starts at the keyframe before the target, so after a seek the clock, saved position and subtitles can be off by up to one GOP (usually 2 to 5 s). Transcoded streams are exact.
- **No in-app control of the Start server item.** The tray's "Start server" menu item is not covered by automated tests (it needs a UI click); restarting via the exe is.
- **Clean VM install time not measured.** The "unzip to playing in under 3 minutes on a clean Windows 11 VM" check has not been timed on a clean VM. On the development PC, the exe listens 3 s after launch.
- **Not code-signed.** SmartScreen asks once.

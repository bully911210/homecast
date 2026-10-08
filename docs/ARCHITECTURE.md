# HomeCast Architecture

One Node 24 process on a Windows PC serves chosen folders to TVs and phones on the home LAN. No cloud, no accounts.

## Contract
- **Item** `{ id, kind, title, parentId?, thumb?, meta? }`. `kind` is open-ended (`folder | video | image | audio | app | …`).
- **Provider** `{ id, list(parentId?), open(id, ctx) → Response, watch?(onChange), get?(ids) }`. `ctx.variant` is `main | thumb | sub`.
- Item IDs are `"<providerId>:<opaque>"`. The router (`server/registry.ts`) dispatches by prefix and never looks inside.
- `fs` provider: `<opaque>` is a random ID in SQLite mapping to `(rootId, relativePath)`. The client never sends or sees a path. Titles, year, `SxxEyy`, tracks and sidecar subtitles are `meta`.
- `home` provider: the Continue Watching row, built from playback state and resolved through the providers' `get()`. A folder Item with `meta.row` renders as a row on the home screen.
- **Item API (4 routes):** `GET /api/items?parent=` · `GET /api/open/:id` (file, HLS via `?hls=&t=&a=`, subtitles via `?track=`) · `GET /api/thumb/:id` · `POST /api/state/:id`.
- **Outside the item surface:** `POST /pair`, `GET /api/health`, `/admin` + `/admin/api/*` (loopback only). A new use case is one new provider file.
- **Client:** one focusable grid plus one player per kind (media, image). Vanilla TS, esbuild `chrome69`, 9 KB gzipped initial. Remote and pointer share one focus model.

## Playback: exactly two paths
At pairing (and every launch) the device reports `canPlayType`/MSE support for H.264, HEVC, VP9, AV1 and native HLS.
1. **Direct.** Trusted container (MP4/MOV, `.webm`, audio files) whose codecs the device decodes: `createReadStream(start, end)` with `Range`/`206`/`416`/`HEAD`/`ETag`/`If-Range`. A whole file is never buffered.
2. **HLS.** Pure `buildHlsArgs(probe, caps, opts)`. Video is copied when it is H.264 8-bit, or HEVC on HEVC devices (fMP4); otherwise encoded with `nvenc | qsv | amf | libx264`. Audio is copied when AAC/MP3, otherwise encoded to AAC.
   - **Job manager:** at most 2 jobs (LRU eviction), 60 s idle kill, seek = restart with `-ss`.
   - **Cleanup:** PID file with an ffmpeg-only orphan sweep at startup, and a 10 GB cache cap.
   - **Fallback:** if a device fails to decode what it promised, the client retries with `safe=1` and gets plain H.264/AAC.

## Pairing
- The PC shows a 6-digit PIN that rotates after a successful pair or after 10 minutes.
- The device POSTs the PIN plus caps and gets a 256-bit random token in an `HttpOnly; SameSite=Strict` cookie. The DB stores only `sha256(token)`; devices are revocable in admin.
- Attempts are capped at 5/min per IP and 20/min globally; going over the global cap rotates the PIN.

## Threat model
- **Internet attacker.** Non-loopback, non-private remote addresses get 403 before routing. Users allow the firewall for Private only; health warns about Public profiles and Public allow-rules.
- **DNS rebinding.** `Host` must be an IP literal, `localhost`, `homecast.local` or this PC's name. Every non-GET also needs a same-origin `Origin` when one is sent.
- **Admin CSRF.** Admin requires loopback; writes need `Content-Type: application/json` (forcing a preflight we never answer) and a same-origin `Origin`.
- **Path traversal / symlink escape.** Paths come only from ID lookups. `resolveInJail` rejects `..`, absolute and UNC paths, `:` (ADS), DOS device names and trailing dots/spaces, then `realpath`s and re-checks containment (case-insensitive on Windows). The scanner skips links. 29 + 12 attack cases are tested.
- **Unpaired LAN device.** Every `/api/*` route except the minimal health needs a valid token; PIN guessing is capped.
- **Malicious media.** ffmpeg runs without a shell (argument arrays) only on jailed files, and HLS file names must match a fixed pattern. The residual decoder risk is accepted.
- **Resource exhaustion.** Job cap, idle kill, cache cap, rate limits, chunked rendering on the client.
- **Integrity.** Library roots are never written. App data, cache and logs live in `%LOCALAPPDATA%\HomeCast\`.

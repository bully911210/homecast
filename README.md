# HomeCast

Play the movies, videos, music and photos on your Windows PC on any TV or phone on your home Wi-Fi. One small program, no cloud, no accounts.

Open a web address on the TV (or scan a QR code), type a 6-digit PIN once, and browse with the remote, a pointer remote or a mouse. Files the TV can't play are converted on the fly with ffmpeg, using the PC's GPU when it has one.

## Use it

1. Download `HomeCast-win-x64.zip` from [Releases](../../releases), unzip it, and run `homecast.exe`.
2. When Windows Firewall asks, tick **Private networks** only.
3. The admin page opens in your browser. Paste a folder path and click **Add folder**.
4. On the TV's browser, open the address shown on the admin page and enter the PIN.

`README-FIRST.txt` in the zip covers SmartScreen, the Public/Private network setting, the tray light and how to uninstall.

## How it works

Everything is an **Item**. **Providers** create Items, and the TV has one browse grid plus one player per kind. Adding a use case (IPTV, a webcam, music) means adding one provider file, never a new screen or endpoint. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/DECISIONS.md](docs/DECISIONS.md).

- **Direct play:** MP4 or WebM files the TV can decode stream as-is, with full HTTP Range support.
- **HLS:** everything else goes through one ffmpeg command builder. Video and audio are each copied or converted independently, with NVENC, Quick Sync, AMF or libx264. At most 2 conversions run at once, and the conversion cache is capped at 10 GB.
- **Safety:** LAN only, a Host allowlist against DNS rebinding, PIN pairing with only hashed tokens stored, a folder jail with realpath checks, and an admin page that only works on the PC itself. HomeCast never writes to your media folders.

## Develop

Requires Node 24+ on Windows or Linux. Google Chrome is needed for the e2e tests, because Chromium builds lack H.264.

```bash
npm ci
npm run dev          # builds the client, starts on :8096
npm run typecheck
npm test             # unit + integration (generates test media with ffmpeg on first run)
npm run e2e          # Playwright: remote-only and mouse-only flows at 1920x1080
npm run package      # Windows: dist/HomeCast-win-x64.zip
```

Config lives in `%LOCALAPPDATA%\HomeCast\config.json` (port, max jobs, cache size, adapter override, mDNS). Logs are written to `%LOCALAPPDATA%\HomeCast\logs`, one file per day, kept 7 days.

## License

MIT, see [LICENSE](LICENSE). The release zip includes ffmpeg/ffprobe binaries, which are licensed separately (GPL); see `FFMPEG-LICENSE` in the zip.

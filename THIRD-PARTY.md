# Third-party software in the release zip

HomeCast itself is MIT licensed. The Windows release zip also ships two separate programs that HomeCast runs as child processes. They are not linked into HomeCast.

| File | What | Licence | Source |
|---|---|---|---|
| `ffmpeg.exe` | FFmpeg 6.1.1, 64-bit static "essentials" build by gyan.dev (via the `ffmpeg-static` npm package) | GPL v3 (see `FFMPEG-LICENSE` in the zip) | [ffmpeg-6.1.1.tar.xz](https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.xz), build details at [gyan.dev/ffmpeg/builds](https://www.gyan.dev/ffmpeg/builds/) |
| `ffprobe.exe` | FFprobe 4.0.2 static build (via the `ffprobe-static` npm package) | GPL | [ffmpeg-4.0.2.tar.xz](https://ffmpeg.org/releases/ffmpeg-4.0.2.tar.xz) |
| `homecast.exe` | The Node.js 24 runtime with HomeCast embedded as a single executable application | Node.js: MIT ([licence](https://github.com/nodejs/node/blob/main/LICENSE)) | [nodejs.org](https://nodejs.org/) |

FFmpeg is a trademark of Fabrice Bellard. HomeCast is not affiliated with the FFmpeg project.

You can replace either binary with your own build: put it beside `homecast.exe`, or point `HOMECAST_FFMPEG` / `HOMECAST_FFPROBE` at it.

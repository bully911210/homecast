// Builds the README media: a demo library of Blender Foundation open movies (CC-BY, about 1.75 GB,
// downloaded once), then screenshots and a hero GIF captured from the real UI at 1920x1080.
// Usage: node tools/demo.ts        (needs Google Chrome; writes docs/media/*)
import { chromium, type Page } from '@playwright/test';
import { serve } from '@hono/node-server';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findBins } from '../server/bins.ts';
import { run } from '../server/run.ts';
import { wire } from '../server/wire.ts';
import { buildClient } from './build-client.ts';

const DEMO = resolve('.demo', 'Media');
const MEDIA = resolve('docs', 'media');
const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;

// Blender Foundation open movies, CC-BY (www.blender.org). Downloaded once into .demo-src/.
const SRC = resolve('.demo-src');
const FILMS: { url: string; file: string; dest: string }[] = [
  { url: 'https://download.blender.org/durian/movies/Sintel.2010.720p.mkv.zip', file: 'Sintel.2010.720p.mkv', dest: 'Movies/Sintel.2010.720p.BluRay.mkv' },
  { url: 'https://download.blender.org/peach/bigbuckbunny_movies/big_buck_bunny_720p_h264.mov.zip', file: 'big_buck_bunny_720p_h264.mov', dest: 'Movies/Big.Buck.Bunny.2008.720p.mov' },
  { url: 'https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov', file: 'tears_of_steel_720p.mov', dest: 'Movies/Tears.of.Steel.2012.720p.mov' },
  { url: 'https://download.blender.org/ED/elephantsdream-720-h264-st-aac.mov', file: 'elephantsdream-720-h264-st-aac.mov', dest: 'Movies/Elephants.Dream.2006.mov' },
  { url: 'https://download.blender.org/demo/movies/caminandes_gran_dillama.mp4.zip', file: 'caminandes_gran_dillama.mp4', dest: 'Shorts/Caminandes.Gran.Dillama.2013.1080p.mp4' },
];
const STILLS: [string, number][] = [
  ['Movies/Sintel.2010.720p.BluRay.mkv', 310], ['Movies/Sintel.2010.720p.BluRay.mkv', 540], ['Movies/Big.Buck.Bunny.2008.720p.mov', 95],
  ['Movies/Tears.of.Steel.2012.720p.mov', 420], ['Movies/Big.Buck.Bunny.2008.720p.mov', 300], ['Movies/Tears.of.Steel.2012.720p.mov', 155],
];

async function makeLibrary(): Promise<void> {
  const { ffmpeg } = findBins();
  if (!ffmpeg) throw new Error('ffmpeg not found');
  mkdirSync(SRC, { recursive: true });
  for (const f of FILMS) {
    const out = join(DEMO, ...f.dest.split('/'));
    if (existsSync(out)) continue;
    mkdirSync(join(out, '..'), { recursive: true });
    const name = f.url.slice(f.url.lastIndexOf('/') + 1);
    const dl = join(SRC, name);
    if (!existsSync(dl)) {
      process.stdout.write(`downloading ${name}\n`);
      const res = await fetch(f.url);
      if (!res.ok || !res.body) throw new Error(`download failed: ${f.url}`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dl));
    }
    if (name.endsWith('.zip')) {
      const r = await run('tar', ['-xf', dl, '-C', SRC], 600_000); // bsdtar ships with Windows 10+ and reads zips
      if (r.code !== 0) throw new Error(`unzip failed: ${r.stderr}`);
      renameSync(join(SRC, f.file), out);
    } else {
      renameSync(dl, out);
    }
  }
  for (const [i, [file, at]] of STILLS.entries()) {
    const out = join(DEMO, 'Photos', 'Film stills', `Still ${String(i + 1).padStart(2, '0')}.jpg`);
    if (existsSync(out)) continue;
    mkdirSync(join(out, '..'), { recursive: true });
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(at), '-i', join(DEMO, ...file.split('/')), '-frames:v', '1', '-q:v', '2', out], 60_000);
  }
}

const ready = (p: Page): Promise<void> => p.locator('.screen[data-ready]').waitFor();
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Seconds into the recording where the player is opening (cut from the GIF). */
let cut = { from: 0, to: 0 };

async function capture(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'homecast-demo-'));
  const w = wire({ dataDir, encoder: 'libx264', settleMs: 0 });
  w.config.update({ port: PORT, roots: [{ id: 'demo', path: DEMO }], mdns: false });
  await w.start();
  await w.scanner.idle();
  const server = serve({ fetch: w.app.fetch, port: PORT, hostname: '127.0.0.1' });
  mkdirSync(MEDIA, { recursive: true });
  const videoDir = mkdtempSync(join(tmpdir(), 'homecast-rec-'));
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await ctx.newPage();
    // Chrome's own screencast: a JPEG per visual change, with timestamps. No extra ffmpeg download.
    const cdp = await ctx.newCDPSession(page);
    const frames: { file: string; t: number }[] = [];
    const pending: { file: string; data: string }[] = [];
    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      // Ack first: Chrome sends the next frame only after the ack, so disk writes must not sit in between.
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
      const file = join(videoDir, `f${String(frames.length).padStart(5, '0')}.jpg`);
      frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 });
      pending.push({ file, data: f.data });
    });
    const pin = ((await (await page.request.get(`${BASE}/admin/api/status`)).json()) as { pin: string }).pin;
    await page.goto(BASE);
    await page.locator('.pin').waitFor();
    await page.screenshot({ path: join(MEDIA, 'pair.png') });
    for (const d of pin) {
      await page.keyboard.press(d);
      await pause(120);
    }
    await ready(page);
    // Two films part-watched, Sintel most recently, so it becomes the home screen's hero.
    await page.evaluate(async () => {
      const get = async (p?: string): Promise<{ id: string; title: string; kind: string; meta?: Record<string, unknown> }[]> =>
        (await (await fetch('/api/items' + (p ? '?parent=' + encodeURIComponent(p) : ''))).json()).items;
      const root = (await get()).find((i) => i.meta?.root)!;
      const movies = (await get((await get(root.id)).find((i) => i.title === 'Movies')!.id)).filter((i) => i.kind === 'video');
      const post = (id: string, position: number, duration: number): Promise<Response> =>
        fetch('/api/state/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position, duration }) });
      await post(movies.find((m) => m.title.startsWith('Tears'))!.id, 183, 734);
      await new Promise((r) => setTimeout(r, 50));
      await post(movies.find((m) => m.title.startsWith('Sintel'))!.id, 355, 888);
    });
    await page.reload();
    await ready(page);
    await pause(2500); // thumbnails and the hero backdrop fade in
    await page.screenshot({ path: join(MEDIA, 'home.png') });
    // Record only from here: the home screen is fully drawn, so the video never opens on a blank page.
    // 1280 wide keeps Chrome's screencast near its full frame rate; the GIF is 720 wide anyway.
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
    await pause(1200);
    const keys = async (list: string[], gap = 500): Promise<void> => {
      for (const k of list) {
        await page.keyboard.press(k);
        await pause(gap);
      }
    };
    // Remote only: hero -> Continue Watching -> Recently Added -> Library.
    await keys(['ArrowDown', 'ArrowRight', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowDown']);
    await page.keyboard.press('Enter'); // the shared folder
    await ready(page);
    await pause(900);
    await page.keyboard.press('Enter'); // Movies
    await ready(page);
    await pause(1500);
    await page.screenshot({ path: join(MEDIA, 'folder.png') });
    await keys(['ArrowRight', 'ArrowRight'], 600); // Sintel: MKV with AC3 audio, converted on the fly
    const pressedAt = Date.now() / 1000 + 0.15; // the GIF jumps from the pressed tile straight to playback
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => Number(document.querySelector('.player')?.getAttribute('data-time') ?? 0) > 357, null, { timeout: 30_000 });
    const playingAt = Date.now() / 1000;
    await pause(2500);
    await page.keyboard.press('ArrowRight'); // +10 s
    await pause(2500);
    await page.keyboard.press('ArrowUp'); // audio and subtitles menu
    await pause(1600);
    await page.keyboard.press('Escape');
    await pause(500);
    await page.keyboard.press('Enter'); // pause so the overlay stays for the still
    await pause(500);
    await page.screenshot({ path: join(MEDIA, 'player.png') });
    await page.keyboard.press('Enter');
    await pause(1500);
    await page.keyboard.press('Escape');
    await ready(page);
    await pause(1500);
    await cdp.send('Page.stopScreencast');
    for (const p of pending) writeFileSync(p.file, Buffer.from(p.data, 'base64'));
    // concat list: each frame shown until the next one arrived
    const lines: string[] = [];
    frames.forEach((f, i) => {
      const next = frames[i + 1]?.t ?? f.t + 1;
      lines.push(`file '${f.file.replace(/\\/g, '/')}'`, `duration ${Math.max(0.02, next - f.t).toFixed(3)}`);
    });
    lines.push(`file '${frames.at(-1)!.file.replace(/\\/g, '/')}'`);
    writeFileSync(join(videoDir, 'frames.txt'), lines.join('\n'));
    const span = frames.at(-1)!.t - frames[0]!.t;
    const gaps = frames.slice(1).map((f, i) => f.t - frames[i]!.t).sort((a, b) => a - b);
    const ms = (s: number): string => (s * 1000).toFixed(0);
    process.stdout.write(
      `captured ${frames.length} frames over ${span.toFixed(1)} s (${(frames.length / span).toFixed(1)} fps), ` +
        `median gap ${ms(gaps[gaps.length >> 1]!)} ms, 90th ${ms(gaps[Math.floor(gaps.length * 0.9)]!)} ms, longest ${ms(gaps.at(-1)!)} ms\n`,
    );
    await ctx.close();
    // The GIF skips the moment the stream is starting (black); the MP4 keeps everything.
    cut = { from: pressedAt - frames[0]!.t, to: playingAt - frames[0]!.t };

    const admin = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await admin.emulateMedia({ colorScheme: 'dark' });
    await admin.goto(`${BASE}/admin`);
    await admin.locator('#qr svg').waitFor();
    await pause(500);
    await admin.screenshot({ path: join(MEDIA, 'admin.png') });

    const { ffmpeg } = findBins();
    const r = await run(
      ffmpeg!,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(videoDir, 'frames.txt'), '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '20', join(MEDIA, 'demo.webm.mp4')],
      300_000,
    );
    if (r.code !== 0) throw new Error(`stitching frames failed: ${r.stderr}`);
    rmSync(videoDir, { recursive: true, force: true });
  } finally {
    await browser.close();
    server.close();
    w.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * Hero GIF: 640px wide, 20 fps, 2-pass palette, about 15 s (browse, play, seek). Film footage is
 * heavy as GIF, so the full run lives in demo.mp4 at 30 fps.
 */
async function makeGif(): Promise<void> {
  const { ffmpeg } = findBins();
  const src = join(MEDIA, 'demo.webm.mp4');
  const keep = `select='between(t,0,${cut.from.toFixed(2)})+between(t,${cut.to.toFixed(2)},${(cut.to + 6).toFixed(2)})',setpts=N/FRAME_RATE/TB`;
  const filters = `fps=30,${keep},fps=20,scale=640:-1:flags=lanczos`;
  const pal = join(MEDIA, 'palette.png');
  await run(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vf', `${filters},palettegen=max_colors=256:stats_mode=diff`, pal], 300_000);
  const r = await run(
    ffmpeg!,
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-i', pal, '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, join(MEDIA, 'demo.gif')],
    300_000,
  );
  if (r.code !== 0) throw new Error(r.stderr);
  rmSync(pal, { force: true });
  await run(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-c:v', 'libx264', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', join(MEDIA, 'demo.mp4')], 300_000);
  rmSync(src, { force: true });
  // Photo-like screenshots as 1280-wide JPEGs keep the README fast; UI-only shots stay PNG.
  for (const n of ['home', 'folder', 'player']) {
    await run(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(MEDIA, `${n}.png`), '-vf', 'scale=1280:-1:flags=lanczos', '-q:v', '3', join(MEDIA, `${n}.jpg`)], 60_000);
    rmSync(join(MEDIA, `${n}.png`), { force: true });
  }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  await buildClient();
  await makeLibrary();
  await capture();
  await makeGif();
  process.stdout.write(`README media written to ${MEDIA}\n`);
}

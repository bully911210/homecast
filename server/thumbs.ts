// Thumbnails: ffmpeg grabs a frame at 10% (video), scales images, or pulls cover art (audio). Cached on disk.
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './run.ts';

const WIDTH = 480;
const MAX_PARALLEL = 2;

let active = 0;
const waiting: (() => void)[] = [];
const inFlight = new Map<string, Promise<string | null>>();

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export function thumbArgs(kind: string, input: string, output: string, duration: number): string[] {
  const head = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  const scale = ['-vf', `scale='min(${WIDTH},iw)':-2`];
  const tail = ['-frames:v', '1', '-q:v', '5', '-f', 'image2', output];
  if (kind === 'video') {
    const at = duration > 0 ? duration * 0.1 : 5;
    return [...head, '-ss', at.toFixed(2), '-i', input, ...scale, ...tail];
  }
  if (kind === 'audio') return [...head, '-i', input, '-an', ...scale, ...tail];
  // Images: ffmpeg applies EXIF orientation when decoding JPEGs (autorotate is on by default).
  return [...head, '-i', input, ...scale, ...tail];
}

/** Returns the cached JPEG path, generating it on first request; null when no frame can be made. */
export function getThumb(ffmpeg: string, cacheDir: string, key: string, kind: string, input: string, duration: number): Promise<string | null> {
  const out = join(cacheDir, `${key}.jpg`);
  if (existsSync(out)) return Promise.resolve(out);
  const pending = inFlight.get(out);
  if (pending) return pending;
  const p = slot(async () => {
    await mkdir(cacheDir, { recursive: true });
    const tmp = `${out}.${process.pid}.tmp.jpg`;
    let r = await run(ffmpeg, thumbArgs(kind, input, tmp, duration), 60_000);
    // Very short videos: 10% may land past the last keyframe. Retry from the start.
    if ((r.code !== 0 || !existsSync(tmp)) && kind === 'video') r = await run(ffmpeg, thumbArgs(kind, input, tmp, 0.1), 60_000);
    if (r.code !== 0 || !existsSync(tmp)) {
      await rm(tmp, { force: true });
      return null;
    }
    await rename(tmp, out);
    return out;
  }).finally(() => inFlight.delete(out));
  inFlight.set(out, p);
  return p;
}

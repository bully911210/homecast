// Subtitles to WebVTT: sidecar .srt/.vtt converted in-process, embedded text tracks via ffmpeg.
import { readFile } from 'node:fs/promises';
import { run } from './run.ts';

/** Text subtitle codecs ffmpeg can turn into WebVTT. Bitmap subs (PGS, VobSub) are not offered. */
export const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

/** Decode as UTF-8, falling back to Windows-1252 for legacy .srt files. */
export function decodeText(buf: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .trim();
  return `WEBVTT\n\n${body}\n`;
}

export async function sidecarToVtt(path: string): Promise<string> {
  const text = decodeText(await readFile(path));
  return /^﻿?WEBVTT/.test(text) ? text.replace(/^﻿/, '') : srtToVtt(text);
}

export async function embeddedToVtt(ffmpeg: string, input: string, streamIndex: number): Promise<string> {
  const r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input, '-map', `0:${streamIndex}`, '-f', 'webvtt', '-'], 120_000);
  if (r.code !== 0) throw new Error(`subtitle extract failed: ${r.stderr.slice(0, 300)}`);
  return r.stdout.toString('utf8');
}

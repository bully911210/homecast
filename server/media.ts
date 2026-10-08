// Media facts: extension classes, MIME types, and the ffprobe summary every playback decision uses.
import { extname } from 'node:path';
import { run } from './run.ts';

export type MediaKind = 'video' | 'image' | 'audio';

const KINDS: Record<string, MediaKind> = {};
for (const e of ['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'ts', 'm2ts', 'mts', 'wmv', 'flv', 'mpg', 'mpeg', 'ogv', '3gp']) KINDS[e] = 'video';
for (const e of ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']) KINDS[e] = 'image';
for (const e of ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'wma']) KINDS[e] = 'audio';

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime',
  avi: 'video/x-msvideo', ts: 'video/mp2t', m2ts: 'video/mp2t', mts: 'video/mp2t', wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv', mpg: 'video/mpeg', mpeg: 'video/mpeg', ogv: 'video/ogg', '3gp': 'video/3gpp',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', wav: 'audio/wav', wma: 'audio/x-ms-wma',
  srt: 'application/x-subrip', vtt: 'text/vtt',
};

export function ext(name: string): string {
  return extname(name).slice(1).toLowerCase();
}

export function kindOf(name: string): MediaKind | null {
  return KINDS[ext(name)] ?? null;
}

export function mimeOf(name: string): string {
  return MIME[ext(name)] ?? 'application/octet-stream';
}

export interface VideoStream {
  index: number;
  codec: string;
  profile?: string;
  width: number;
  height: number;
  pixFmt?: string;
}

export interface AudioStream {
  index: number;
  codec: string;
  channels: number;
  lang?: string;
  title?: string;
  isDefault: boolean;
}

export interface SubStream {
  index: number;
  codec: string;
  lang?: string;
  title?: string;
  forced: boolean;
}

export interface Probe {
  container: string; // ffprobe format_name, e.g. "matroska,webm"
  duration: number;
  video?: VideoStream;
  audio: AudioStream[];
  subs: SubStream[];
}

interface RawStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  channels?: number;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
}

/** Turn raw ffprobe JSON into a Probe. Throws when there is nothing playable. */
export function summarizeProbe(json: unknown): Probe {
  const j = json as { format?: { format_name?: string; duration?: string }; streams?: RawStream[] };
  const streams = Array.isArray(j?.streams) ? j.streams : [];
  if (!j?.format?.format_name || streams.length === 0) throw new Error('no streams');
  const tag = (s: RawStream, k: string): string | undefined => s.tags?.[k] ?? s.tags?.[k.toUpperCase()];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams
    .filter((s) => s.codec_type === 'audio' && s.codec_name)
    .map((s) => ({ index: s.index, codec: s.codec_name!, channels: s.channels ?? 2, lang: tag(s, 'language'), title: tag(s, 'title'), isDefault: s.disposition?.default === 1 }));
  const subs = streams
    .filter((s) => s.codec_type === 'subtitle' && s.codec_name)
    .map((s) => ({ index: s.index, codec: s.codec_name!, lang: tag(s, 'language'), title: tag(s, 'title'), forced: s.disposition?.forced === 1 }));
  if (!v?.codec_name && audio.length === 0) throw new Error('no audio or video stream');
  const duration = Number(j.format.duration);
  return {
    container: j.format.format_name,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    video: v?.codec_name ? { index: v.index, codec: v.codec_name, profile: v.profile, width: v.width ?? 0, height: v.height ?? 0, pixFmt: v.pix_fmt } : undefined,
    audio,
    subs,
  };
}

export async function probeFile(ffprobe: string, path: string): Promise<Probe> {
  const r = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], 30_000);
  if (r.code !== 0) throw new Error(`ffprobe exit ${r.code}: ${r.stderr.slice(0, 300)}`);
  return summarizeProbe(JSON.parse(r.stdout.toString('utf8')));
}

// The two playback paths. Pure functions: probe + device caps in, decision / ffmpeg args out.
import type { Caps } from '../shared/types.ts';
import type { Probe } from './media.ts';

export type Encoder = 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264';
export type PlaybackMode = 'direct' | 'remux' | 'hls' | 'transcode' | 'unplayable';

export interface ServerCaps {
  ffmpeg: boolean;
  ffprobe: boolean;
  encoders: readonly Encoder[];
  hls: boolean;
}

interface CopyPlan {
  video: 'copy' | 'none';
  audio: 'copy' | 'encode' | 'none';
  segment: 'mpegts' | 'fmp4';
}

export type PlaybackPlan =
  | { mode: 'direct' }
  | ({ mode: 'remux' } & CopyPlan)
  | ({ mode: 'hls' } & CopyPlan)
  | ({ mode: 'transcode'; video: 'encode'; audio: 'copy' | 'encode' | 'none'; segment: 'mpegts'; encoder: Encoder; hardware: boolean })
  | { mode: 'unplayable'; reason: 'TRANSCODER_UNAVAILABLE' | 'NO_PLAYBACK_PATH' };

export interface PlaybackOpts {
  audioIndex?: number;
  start?: number;
  safe?: boolean;
  attempt?: number;
  forceHls?: boolean;
}

/** Audio codecs every browser engine we target decodes. */
const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
/** Audio codecs we can copy into an HLS segment without re-encoding. */
const HLS_COPY_AUDIO = new Set(['aac', 'mp3']);

function is10bit(pixFmt: string | undefined): boolean {
  return !!pixFmt && /(10|12)(le|be)$/.test(pixFmt);
}

/** H.264 is assumed universal: it is also what we transcode to, so a device without it can't play anything. */
function videoOk(codec: string, pixFmt: string | undefined, caps: Caps): boolean {
  switch (codec) {
    case 'h264':
      return !is10bit(pixFmt);
    case 'hevc':
      return caps.hevc;
    case 'vp9':
      return caps.vp9;
    case 'av1':
      return caps.av1;
    default:
      return false;
  }
}

function pickAudio(probe: Probe, audioIndex?: number): Probe['audio'][number] | undefined {
  return probe.audio.find((a) => a.index === audioIndex) ?? probe.audio.find((a) => a.isDefault) ?? probe.audio[0];
}

function copyableVideo(probe: Probe, caps: Caps, safe: boolean): boolean {
  const v = probe.video;
  if (!v) return true;
  if (v.codec === 'h264') return !is10bit(v.pixFmt);
  return !safe && v.codec === 'hevc' && caps.hevc;
}

function copyableAudio(probe: Probe, audioIndex: number | undefined, safe: boolean): boolean {
  const a = pickAudio(probe, audioIndex);
  return !a || HLS_COPY_AUDIO.has(a.codec) && (!safe || a.codec === 'aac');
}

/** A deterministic, I/O-free list of valid playback choices in preference order. */
export function planPlayback(probe: Probe, caps: Caps, fileExt: string, server: ServerCaps, opts: PlaybackOpts = {}): PlaybackPlan {
  const start = opts.start ?? 0;
  const safe = opts.safe ?? false;
  const attempt = opts.attempt ?? 0;
  if (!Number.isInteger(attempt) || attempt < 0) throw new Error('attempt must be a non-negative integer');

  const plans: PlaybackPlan[] = [];
  if (!safe && start === 0 && canDirectPlay(probe, caps, fileExt, opts.audioIndex)) plans.push({ mode: 'direct' });
  if (!server.ffmpeg || !server.hls) {
    const index = opts.forceHls && plans[attempt]?.mode === 'direct' ? attempt + 1 : attempt;
    if (plans[index]) return plans[index]!;
    return { mode: 'unplayable', reason: server.ffmpeg ? 'NO_PLAYBACK_PATH' : 'TRANSCODER_UNAVAILABLE' };
  }

  const v = probe.video;
  const a = pickAudio(probe, opts.audioIndex);
  const videoCopy = copyableVideo(probe, caps, safe);
  const audioCopy = copyableAudio(probe, opts.audioIndex, safe);
  const segment = videoCopy && v?.codec === 'hevc' ? 'fmp4' : 'mpegts';
  if (videoCopy && audioCopy) plans.push({ mode: 'remux', video: v ? 'copy' : 'none', audio: a ? 'copy' : 'none', segment });
  if (videoCopy && a && !audioCopy) plans.push({ mode: 'hls', video: v ? 'copy' : 'none', audio: 'encode', segment });

  if (v) {
    const audio: 'copy' | 'encode' | 'none' = !a ? 'none' : audioCopy ? 'copy' : 'encode';
    for (const encoder of (safe ? [] : server.encoders).filter((e) => e !== 'libx264')) {
      plans.push({ mode: 'transcode', video: 'encode', audio, segment: 'mpegts', encoder, hardware: true });
    }
    if (server.encoders.includes('libx264')) {
      plans.push({ mode: 'transcode', video: 'encode', audio, segment: 'mpegts', encoder: 'libx264', hardware: false });
    }
  }

  const index = opts.forceHls && plans[attempt]?.mode === 'direct' ? attempt + 1 : attempt;
  return plans[index] ?? { mode: 'unplayable', reason: 'NO_PLAYBACK_PATH' };
}

/**
 * Path 1 check: can the browser play the file exactly as it is?
 * Only MP4/MOV and WebM containers are trusted; MKV, AVI, TS and friends always go through HLS.
 */
export function canDirectPlay(probe: Probe, caps: Caps, fileExt: string, audioIndex?: number): boolean {
  const c = probe.container;
  const mp4 = /\b(mov|mp4)\b/.test(c);
  // ffprobe reports MKV and WebM identically ("matroska,webm"); only trust the .webm extension.
  const webm = c.includes('webm') && fileExt === 'webm';
  const isAudioOnly = !probe.video;
  const audioContainer = /^(mp3|flac|ogg|wav)$/.test(c) || /\b(aac|adts)\b/.test(c);
  if (!mp4 && !webm && !(isAudioOnly && audioContainer)) return false;
  if (probe.video && !videoOk(probe.video.codec, probe.video.pixFmt, caps)) return false;
  if (probe.video?.codec === 'hevc' && !mp4) return false;
  // A non-default audio choice needs track switching the <video> element can't do reliably: use HLS.
  const a = pickAudio(probe, audioIndex);
  if (audioIndex !== undefined && a && a !== pickAudio(probe)) return false;
  if (a && !BROWSER_AUDIO.has(a.codec) && !(a.codec.startsWith('pcm_') && isAudioOnly)) return false;
  return true;
}

export interface HlsPlan {
  args: string[];
  video: 'copy' | 'encode' | 'none';
  audio: 'copy' | 'encode' | 'none';
  segment: 'mpegts' | 'fmp4';
}

export interface HlsOpts {
  input: string;
  outDir: string; // segments + index.m3u8 are written here
  start: number; // seconds; seeking restarts ffmpeg with -ss
  audioIndex?: number;
  encoder: Encoder;
  segSeconds?: number;
}

type FfmpegPlan = Extract<PlaybackPlan, { mode: 'remux' | 'hls' | 'transcode' }>;

function encoderArgs(enc: Encoder, height: number): string[] {
  const scale = height > 1080 ? ['-vf', 'scale=-2:1080'] : [];
  const gop = ['-g', '48', '-keyint_min', '48'];
  switch (enc) {
    case 'h264_nvenc':
      return [...scale, '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '8M', '-maxrate', '12M', '-bufsize', '16M', '-pix_fmt', 'yuv420p', ...gop];
    case 'h264_qsv':
      return [...(height > 1080 ? ['-vf', 'scale=-2:1080,format=nv12'] : ['-vf', 'format=nv12']), '-c:v', 'h264_qsv', '-preset', 'faster', '-global_quality', '23', '-b:v', '8M', '-maxrate', '12M', ...gop];
    case 'h264_amf':
      return [...scale, '-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'vbr_peak', '-b:v', '8M', '-maxrate', '12M', '-pix_fmt', 'yuv420p', ...gop];
    case 'libx264':
      return [...scale, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-maxrate', '10M', '-bufsize', '20M', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1', ...gop];
  }
}

export function compileFfmpegArgs(plan: FfmpegPlan, probe: Probe, o: HlsOpts): string[] {
  const seg = o.segSeconds ?? 4;
  const v = probe.video;
  const a = pickAudio(probe, o.audioIndex);
  const video = plan.video;
  const audio = plan.audio;
  const segment = plan.segment;
  const encoder = plan.mode === 'transcode' ? plan.encoder : o.encoder;

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  if (o.start > 0) args.push('-ss', o.start.toFixed(3));
  args.push('-i', o.input);
  if (v) args.push('-map', `0:${v.index}`);
  if (a) args.push('-map', `0:${a.index}`);
  args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1');

  if (video === 'copy') {
    args.push('-c:v', 'copy');
    if (v?.codec === 'hevc') args.push('-tag:v', 'hvc1');
  } else if (video === 'encode') {
    if (!v) throw new Error('transcode plan requires video');
    args.push(...encoderArgs(encoder, v.height), '-force_key_frames', `expr:gte(t,n_forced*${seg})`);
  }
  if (audio === 'copy') args.push('-c:a', 'copy');
  else if (audio === 'encode') args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');

  args.push(
    '-max_muxing_queue_size', '2048',
    '-f', 'hls',
    '-hls_time', String(seg),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'temp_file+independent_segments',
    '-hls_segment_type', segment,
    '-start_number', '0',
  );
  const sep = o.outDir.endsWith('/') || o.outDir.endsWith('\\') ? '' : '/';
  if (segment === 'fmp4') args.push('-hls_fmp4_init_filename', 'init.mp4');
  args.push('-hls_segment_filename', `${o.outDir}${sep}seg_%05d.${segment === 'fmp4' ? 'm4s' : 'ts'}`, `${o.outDir}${sep}index.m3u8`);
  return args;
}

/**
 * Path 2: the one ffmpeg command builder. Video and audio decide independently:
 * copy when the device can decode the stream and HLS can carry it, otherwise encode H.264 / AAC.
 * Remux, audio-only transcode and full transcode all fall out of this function.
 */
export function buildHlsArgs(probe: Probe, caps: Caps, o: HlsOpts): HlsPlan {
  const hlsPlan: PlaybackPlan = planPlayback(probe, caps, '', {
    ffmpeg: true,
    ffprobe: true,
    hls: true,
    encoders: [o.encoder],
  }, { start: o.start, audioIndex: o.audioIndex });
  if (hlsPlan.mode === 'direct' || hlsPlan.mode === 'unplayable') throw new Error('expected an HLS playback plan');
  const video: HlsPlan['video'] = hlsPlan.video === 'encode' ? 'encode' : hlsPlan.video;
  const audio: HlsPlan['audio'] = hlsPlan.audio;
  const segment = hlsPlan.segment;
  return { args: compileFfmpegArgs(hlsPlan, probe, o), video, audio, segment };
}

/** ffmpeg args for a 1-second test encode used to pick a hardware encoder at startup. */
export function probeEncoderArgs(enc: Encoder): string[] {
  const fmt = enc === 'h264_qsv' ? ['-vf', 'format=nv12'] : ['-pix_fmt', 'yuv420p'];
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '1', ...fmt, '-c:v', enc, '-f', 'null', '-'];
}

export const HW_ORDER: readonly Encoder[] = ['h264_nvenc', 'h264_qsv', 'h264_amf'];

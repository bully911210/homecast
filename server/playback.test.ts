import { describe, expect, it } from 'vitest';
import { NO_CAPS, type Caps } from '../shared/types.ts';
import type { Probe } from './media.ts';
import { buildHlsArgs, canDirectPlay, planPlayback, probeEncoderArgs, type Encoder, type HlsPlan } from './playback.ts';

const MP4 = 'mov,mp4,m4a,3gp,3g2,mj2';
const MKV = 'matroska,webm';

function probe(container: string, video: string | null, audio: string | null, pixFmt = 'yuv420p', height = 1080): Probe {
  return {
    container,
    duration: 120,
    video: video ? { index: 0, codec: video, width: 1920, height, pixFmt } : undefined,
    audio: audio ? [{ index: 1, codec: audio, channels: 2, isDefault: true }] : [],
    subs: [],
  };
}

const TV: Caps = { ...NO_CAPS, h264: true, hls: true };
const HEVC_TV: Caps = { ...TV, hevc: true };
const MODERN: Caps = { h264: true, hevc: true, vp9: true, av1: true, hls: false };

describe('canDirectPlay (path 1)', () => {
  it.each<[string, Probe, Caps, string, boolean]>([
    ['H.264/AAC MP4', probe(MP4, 'h264', 'aac'), TV, 'mp4', true],
    ['H.264/AAC MKV (container not trusted)', probe(MKV, 'h264', 'aac'), TV, 'mkv', false],
    ['H.264/AC3 MP4 (browser cannot decode AC3)', probe(MP4, 'h264', 'ac3'), TV, 'mp4', false],
    ['10-bit H.264 MP4', probe(MP4, 'h264', 'aac', 'yuv420p10le'), TV, 'mp4', false],
    ['HEVC MP4 on HEVC TV', probe(MP4, 'hevc', 'aac'), HEVC_TV, 'mp4', true],
    ['HEVC MP4 on plain TV', probe(MP4, 'hevc', 'aac'), TV, 'mp4', false],
    ['VP9/Opus WebM on modern browser', probe(MKV, 'vp9', 'opus'), MODERN, 'webm', true],
    ['VP9 in .mkv', probe(MKV, 'vp9', 'opus'), MODERN, 'mkv', false],
    ['AV1 MP4 without AV1', probe(MP4, 'av1', 'aac'), TV, 'mp4', false],
    ['AV1 MP4 with AV1', probe(MP4, 'av1', 'aac'), MODERN, 'mp4', true],
    ['MP3 audio file', probe('mp3', null, 'mp3'), TV, 'mp3', true],
    ['FLAC audio file', probe('flac', null, 'flac'), TV, 'flac', true],
    ['WMA audio file', probe('asf', null, 'wmav2'), TV, 'wma', false],
    ['MPEG-4 Part 2 AVI', probe('avi', 'mpeg4', 'mp3'), MODERN, 'avi', false],
  ])('%s', (_name, p, caps, ext, want) => expect(canDirectPlay(p, caps, ext)).toBe(want));

  it('a non-default audio track forces HLS', () => {
    const p: Probe = { ...probe(MP4, 'h264', 'aac'), audio: [{ index: 1, codec: 'aac', channels: 2, isDefault: true }, { index: 2, codec: 'aac', channels: 2, isDefault: false }] };
    expect(canDirectPlay(p, TV, 'mp4', 1)).toBe(true);
    expect(canDirectPlay(p, TV, 'mp4', 2)).toBe(false);
  });

  describe('planPlayback', () => {
    const server = { ffmpeg: true, ffprobe: true, hls: true, encoders: ['h264_nvenc', 'libx264'] as const };

    it('orders direct, stream copy, hardware encode, then CPU encode without I/O', () => {
      const p = probe(MP4, 'h264', 'aac');
      expect(planPlayback(p, TV, 'mp4', server)).toEqual({ mode: 'direct' });
      expect(planPlayback(p, TV, 'mp4', server, { attempt: 1 })).toMatchObject({ mode: 'remux' });
      expect(planPlayback(p, TV, 'mp4', server, { attempt: 1, forceHls: true })).toMatchObject({ mode: 'remux' });
      expect(planPlayback(p, TV, 'mp4', server, { forceHls: true })).toMatchObject({ mode: 'remux' });
      expect(planPlayback(p, TV, 'mp4', server, { attempt: 2 })).toMatchObject({ mode: 'transcode', encoder: 'h264_nvenc', hardware: true });
      expect(planPlayback(p, TV, 'mp4', server, { attempt: 3 })).toMatchObject({ mode: 'transcode', encoder: 'libx264', hardware: false });
    });

    it('prefers copied video with audio-only conversion before video encoding', () => {
      const p = probe(MKV, 'h264', 'dts');
      expect(planPlayback(p, TV, 'mkv', server)).toMatchObject({ mode: 'hls', video: 'copy', audio: 'encode' });
      expect(planPlayback(p, TV, 'mkv', server, { attempt: 1 })).toMatchObject({ mode: 'transcode', encoder: 'h264_nvenc' });
    });

    it('uses only CPU encoding in safe mode and reports when no conversion path exists', () => {
      const p = probe(MKV, 'hevc', 'dts');
      expect(planPlayback(p, TV, 'mkv', server, { safe: true })).toMatchObject({ mode: 'transcode', encoder: 'libx264', hardware: false, audio: 'encode' });
      expect(planPlayback(p, TV, 'mkv', { ...server, ffmpeg: false, hls: false })).toEqual({ mode: 'unplayable', reason: 'TRANSCODER_UNAVAILABLE' });
    });

    it('keeps direct playback available without ffmpeg', () => {
      expect(planPlayback(probe(MP4, 'h264', 'aac'), TV, 'mp4', { ffmpeg: false, ffprobe: true, hls: false, encoders: [] })).toEqual({ mode: 'direct' });
    });
  });
});

const opts = { input: 'in.mkv', outDir: 'out', start: 0, encoder: 'libx264' as const };
const flag = (args: string[], f: string): string | undefined => {
  const i = args.indexOf(f);
  return i === -1 ? undefined : args[i + 1];
};

describe('buildHlsArgs (path 2): each stream decides independently', () => {
  it.each<[string, Probe, Caps, Pick<HlsPlan, 'video' | 'audio' | 'segment'>]>([
    ['H.264/AAC MKV -> remux', probe(MKV, 'h264', 'aac'), TV, { video: 'copy', audio: 'copy', segment: 'mpegts' }],
    ['H.264/DTS MKV -> audio-only transcode', probe(MKV, 'h264', 'dts'), TV, { video: 'copy', audio: 'encode', segment: 'mpegts' }],
    ['H.264/AC3 -> audio-only transcode', probe(MKV, 'h264', 'ac3'), TV, { video: 'copy', audio: 'encode', segment: 'mpegts' }],
    ['HEVC on plain TV -> full transcode', probe(MKV, 'hevc', 'aac'), TV, { video: 'encode', audio: 'copy', segment: 'mpegts' }],
    ['HEVC on HEVC TV -> copy in fMP4', probe(MKV, 'hevc', 'aac'), HEVC_TV, { video: 'copy', audio: 'copy', segment: 'fmp4' }],
    ['HEVC/DTS on HEVC TV -> copy video, encode audio', probe(MKV, 'hevc', 'dts'), HEVC_TV, { video: 'copy', audio: 'encode', segment: 'fmp4' }],
    ['AV1 -> encode', probe(MKV, 'av1', 'aac'), MODERN, { video: 'encode', audio: 'copy', segment: 'mpegts' }],
    ['VP9/Opus -> encode both', probe(MKV, 'vp9', 'opus'), TV, { video: 'encode', audio: 'encode', segment: 'mpegts' }],
    ['10-bit H.264 -> encode', probe(MKV, 'h264', 'aac', 'yuv420p10le'), TV, { video: 'encode', audio: 'copy', segment: 'mpegts' }],
    ['audio-only WMA -> encode', probe('asf', null, 'wmav2'), TV, { video: 'none', audio: 'encode', segment: 'mpegts' }],
    ['video without audio', probe(MKV, 'mpeg2video', null), TV, { video: 'encode', audio: 'none', segment: 'mpegts' }],
  ])('%s', (_n, p, caps, want) => {
    const plan = buildHlsArgs(p, caps, opts);
    expect({ video: plan.video, audio: plan.audio, segment: plan.segment }).toEqual(want);
    expect(flag(plan.args, '-c:v')).toBe(plan.video === 'copy' ? 'copy' : plan.video === 'encode' ? 'libx264' : undefined);
    expect(flag(plan.args, '-c:a')).toBe(plan.audio === 'copy' ? 'copy' : plan.audio === 'encode' ? 'aac' : undefined);
    expect(plan.args.at(-1)).toBe('out/index.m3u8');
    expect(flag(plan.args, '-f')).toBe('hls');
  });

  describe('planner capability matrix', () => {
    it('is deterministic and only selects verified hardware encoders across representative media', () => {
      const caps: Caps[] = [];
      for (let bits = 0; bits < 16; bits++) {
        caps.push({ h264: true, hevc: !!(bits & 1), vp9: !!(bits & 2), av1: !!(bits & 4), hls: !!(bits & 8) });
      }
      const audioCodecs = ['aac', 'ac3', 'dts', 'opus', null] as const;
      const encoderSets: readonly (readonly Encoder[])[] = [[], ['libx264'], ['h264_nvenc', 'libx264'], ['h264_qsv', 'libx264'], ['h264_amf', 'libx264']];
      const videos = ['h264', 'hevc', 'vp9', 'av1', 'mpeg4'];

      for (const container of [MP4, MKV]) {
        for (const codec of videos) {
          for (const pixFmt of ['yuv420p', 'yuv420p10le']) {
            for (const audio of audioCodecs) {
              const p = probe(container, codec, audio, pixFmt);
              for (const device of caps) {
                for (const encoders of encoderSets) {
                  const server = { ffmpeg: true, ffprobe: true, hls: true, encoders };
                  const first = planPlayback(p, device, container === MP4 ? 'mp4' : 'mkv', server);
                  expect(planPlayback(p, device, container === MP4 ? 'mp4' : 'mkv', server)).toEqual(first);
                  if (first.mode === 'direct') expect(canDirectPlay(p, device, container === MP4 ? 'mp4' : 'mkv')).toBe(true);
                  if (first.mode === 'transcode' && first.hardware) expect(encoders).toContain(first.encoder);

                  if (encoders.includes('libx264')) {
                    const plans = Array.from({ length: 8 }, (_, attempt) =>
                      planPlayback(p, device, container === MP4 ? 'mp4' : 'mkv', server, { attempt }),
                    );
                    expect(plans.some((plan) => plan.mode === 'transcode' && plan.encoder === 'libx264')).toBe(true);
                  }
                }
              }
            }
          }
        }
      }
    });
  });

  it('seeking restarts with -ss before -i', () => {
    const args = buildHlsArgs(probe(MKV, 'h264', 'aac'), TV, { ...opts, start: 754.5 }).args;
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(flag(args, '-ss')).toBe('754.500');
    expect(buildHlsArgs(probe(MKV, 'h264', 'aac'), TV, opts).args).not.toContain('-ss');
  });

  it('maps the chosen audio track', () => {
    const p: Probe = { ...probe(MKV, 'h264', 'aac'), audio: [{ index: 1, codec: 'aac', channels: 2, isDefault: true }, { index: 2, codec: 'dts', channels: 6, isDefault: false }] };
    const plan = buildHlsArgs(p, TV, { ...opts, audioIndex: 2 });
    expect(plan.args).toContain('0:2');
    expect(plan.audio).toBe('encode');
  });

  it.each(['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'] as const)('uses encoder %s and downscales 4K', (encoder) => {
    const args = buildHlsArgs(probe(MKV, 'hevc', 'aac', 'yuv420p10le', 2160), TV, { ...opts, encoder }).args;
    expect(flag(args, '-c:v')).toBe(encoder);
    expect(flag(args, '-vf')).toMatch(/scale=-2:1080/);
  });

  it('paths with spaces and unicode stay one argument', () => {
    const input = 'D:/Filme/Ünïcödé Fïlm (2017).mkv';
    expect(flag(buildHlsArgs(probe(MKV, 'h264', 'aac'), TV, { ...opts, input }).args, '-i')).toBe(input);
  });

  it('encoder probe is a 1 second test encode', () => {
    const a = probeEncoderArgs('h264_nvenc');
    expect(flag(a, '-t')).toBe('1');
    expect(flag(a, '-c:v')).toBe('h264_nvenc');
  });
});

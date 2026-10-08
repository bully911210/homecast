// Generates tiny test media with ffmpeg's testsrc/sine sources. The script is committed, the media is not.
// Usage: node tools/fixtures/generate.ts [outDir]   (default: .fixtures)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findBins } from '../../server/bins.ts';
import { run } from '../../server/run.ts';

export const FIXTURE_DIR = resolve(process.cwd(), '.fixtures');

const V = (size = '320x180', seconds = 6): string[] => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=24:duration=${seconds}`];
const A = (seconds = 6): string[] => ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`];
const H264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '24'];
const AAC = ['-c:a', 'aac', '-b:a', '96k', '-ac', '2'];

interface Spec {
  file: string;
  args: string[];
}

export const SPECS: readonly Spec[] = [
  { file: 'Direct.Movie.2019.1080p.mp4', args: [...V(), ...A(), ...H264, ...AAC, '-movflags', '+faststart'] },
  { file: 'Remux.Movie.2020.mkv', args: [...V(), ...A(), ...H264, ...AAC] },
  { file: 'Hevc.Movie.2021.x265.mkv', args: [...V(), ...A(), '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', ...AAC] },
  { file: 'Dts.Audio.2018.mkv', args: [...V(), ...A(), ...H264, '-c:a', 'dca', '-strict', '-2', '-ac', '2', '-b:a', '768k'] },
  { file: 'Av1.Movie.2022.mkv', args: [...V('160x90', 2), ...A(2), '-c:v', 'libaom-av1', '-cpu-used', '8', '-crf', '50', '-row-mt', '1', ...AAC] },
  { file: 'Long/Long.Feature.2015.mkv', args: [...V('640x360', 90), ...A(90), '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-b:a', '128k'] },
  { file: 'Vp9.Clip.webm', args: [...V(), ...A(), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k', '-c:a', 'libopus'] },
  { file: 'Ünïcödé Fïlm mit Leerzeichen (2017).mkv', args: [...V(), ...A(), ...H264, ...AAC] },
  { file: 'Show/Season 1/Show.Name.S01E02.720p.mkv', args: [...V(), ...A(), ...H264, '-c:a', 'ac3', '-b:a', '192k'] },
  { file: 'Music/tone.mp3', args: [...A(4), '-c:a', 'libmp3lame', '-b:a', '128k'] },
  { file: 'Music/tone.flac', args: [...A(4), '-c:a', 'flac'] },
  { file: 'Photos/landscape.jpg', args: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360', '-frames:v', '1', '-q:v', '4'] },
  { file: 'Photos/chart.png', args: ['-f', 'lavfi', '-i', 'testsrc2=size=400x300', '-frames:v', '1'] },
];

/** Insert an EXIF APP1 segment with Orientation=6 (rotate 90° CW) right after the JPEG SOI marker. */
export function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 offset
  tiff.writeUInt16LE(1, 8); // one entry
  tiff.writeUInt16LE(0x0112, 10); // Orientation
  tiff.writeUInt16LE(3, 12); // SHORT
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22); // no next IFD
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
}

export async function generateFixtures(outDir = FIXTURE_DIR): Promise<string> {
  const { ffmpeg } = findBins();
  if (!ffmpeg) throw new Error('ffmpeg not found; run npm install');
  for (const s of SPECS) {
    const out = join(outDir, ...s.file.split('/'));
    if (existsSync(out)) continue;
    mkdirSync(join(out, '..'), { recursive: true });
    const r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...s.args, out], 180_000);
    if (r.code !== 0) throw new Error(`fixture ${s.file} failed: ${r.stderr}`);
  }
  const direct = readFileSync(join(outDir, 'Direct.Movie.2019.1080p.mp4'));
  const extra: [string, Buffer | string][] = [
    ['Broken/corrupt.mkv', Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251))],
    ['Broken/truncated.mp4', direct.subarray(0, Math.floor(direct.length / 3))],
    ['Broken/empty.mp4', Buffer.alloc(0)],
    ['Photos/rotated.jpg', withExifOrientation(readFileSync(join(outDir, 'Photos', 'landscape.jpg')), 6)],
    ['Remux.Movie.2020.en.srt', '1\r\n00:00:01,000 --> 00:00:03,500\r\nHello from a sidecar\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,000\r\nSecond line\r\n'],
    ['notes.txt', 'not media'],
    ['.hidden/secret.mp4', direct],
  ];
  for (const [file, data] of extra) {
    const out = join(outDir, ...file.split('/'));
    if (existsSync(out)) continue;
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, data);
  }
  return outDir;
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const dir = await generateFixtures(process.argv[2] ? resolve(process.argv[2]) : FIXTURE_DIR);
  process.stdout.write(`fixtures ready in ${dir}\n`);
}

// Locate ffmpeg / ffprobe: env override, then beside the executable (shipped zip), then the npm packages.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { isSea } from 'node:sea';

export interface Bins {
  ffmpeg: string | null;
  ffprobe: string | null;
}

const EXE = process.platform === 'win32' ? '.exe' : '';

function fromPackages(): Bins {
  try {
    const req = createRequire(import.meta.url);
    const ffmpeg = req('ffmpeg-static') as string | null;
    const ffprobe = (req('ffprobe-static') as { path: string }).path;
    return { ffmpeg, ffprobe };
  } catch {
    return { ffmpeg: null, ffprobe: null };
  }
}

function exists(p: string | null | undefined): string | null {
  return p && existsSync(p) ? p : null;
}

export function findBins(): Bins {
  const besideExe = dirname(process.execPath);
  const pkg = isSea() ? { ffmpeg: null, ffprobe: null } : fromPackages();
  return {
    ffmpeg: exists(process.env.HOMECAST_FFMPEG) ?? exists(join(besideExe, `ffmpeg${EXE}`)) ?? exists(pkg.ffmpeg),
    ffprobe: exists(process.env.HOMECAST_FFPROBE) ?? exists(join(besideExe, `ffprobe${EXE}`)) ?? exists(pkg.ffprobe),
  };
}

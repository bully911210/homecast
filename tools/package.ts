// Build dist/HomeCast-win-x64.zip: a Node single executable (server + client embedded),
// ffmpeg/ffprobe beside it, the tray script and the first-run notes. Windows only.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { ASSET_NAMES } from '../server/assets.ts';
import { buildClient } from './build-client.ts';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const WORK = join(DIST, 'sea');
const APP = join(DIST, 'HomeCast');
const ZIP = join(DIST, 'HomeCast-win-x64.zip');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function sh(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
}

export async function packageApp(): Promise<string> {
  if (process.platform !== 'win32') throw new Error('packaging produces a Windows .exe; run it on Windows');
  rmSync(WORK, { recursive: true, force: true });
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  mkdirSync(APP, { recursive: true });

  const gz = await buildClient();
  process.stdout.write(`client: ${(gz / 1024).toFixed(1)} KB gzipped\n`);

  // 1. One CommonJS file for the server: SEA cannot load node_modules.
  await build({
    entryPoints: ['server/main.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: join(WORK, 'main.cjs'),
    external: ['ffmpeg-static', 'ffprobe-static'], // located beside the exe instead
    legalComments: 'none',
    logLevel: 'warning',
  });

  // 2. SEA blob with the client files as embedded assets.
  const assets = Object.fromEntries(ASSET_NAMES.map((n) => [n, join(DIST, 'client', n)]));
  const seaConfig = { main: join(WORK, 'main.cjs'), output: join(WORK, 'sea.blob'), disableExperimentalSEAWarning: true, useCodeCache: false, assets };
  writeFileSync(join(WORK, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
  sh(process.execPath, ['--experimental-sea-config', join(WORK, 'sea-config.json')]);

  // 3. Copy node.exe and inject the blob.
  const exe = join(APP, 'homecast.exe');
  copyFileSync(process.execPath, exe);
  const postject = join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
  sh(process.execPath, [postject, exe, 'NODE_SEA_BLOB', join(WORK, 'sea.blob'), '--sentinel-fuse', FUSE, '--overwrite']);

  // 4. ffmpeg + ffprobe (with their licences), tray, docs.
  const req = createRequire(import.meta.url);
  const ffmpeg = req('ffmpeg-static') as string;
  const ffprobe = (req('ffprobe-static') as { path: string }).path;
  copyFileSync(ffmpeg, join(APP, 'ffmpeg.exe'));
  copyFileSync(ffprobe, join(APP, 'ffprobe.exe'));
  for (const f of ['ffmpeg.exe.LICENSE', 'ffmpeg.exe.README']) {
    const p = join(ffmpeg, '..', f);
    if (existsSync(p)) copyFileSync(p, join(APP, f.replace('ffmpeg.exe.', 'FFMPEG-')));
  }
  copyFileSync(join(ROOT, 'tools', 'tray.ps1'), join(APP, 'tray.ps1'));
  copyFileSync(join(ROOT, 'LICENSE'), join(APP, 'LICENSE.txt'));
  copyFileSync(join(ROOT, 'docs', 'FIRST-RUN.txt'), join(APP, 'README-FIRST.txt'));
  copyFileSync(join(ROOT, 'THIRD-PARTY.md'), join(APP, 'THIRD-PARTY.txt'));

  // 5. Zip with the built-in PowerShell archiver.
  rmSync(ZIP, { force: true });
  sh('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${APP}\\*' -DestinationPath '${ZIP}'`]);
  return ZIP;
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const zip = await packageApp();
  process.stdout.write(`packaged: ${zip}\n`);
}

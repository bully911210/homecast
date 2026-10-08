// Bundle the TV client with esbuild for old TV Chromium (chrome69) and enforce the 50 KB gzip budget.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const OUT = join(process.cwd(), 'dist', 'client');
const BUDGET = 50 * 1024;

export async function buildClient(): Promise<number> {
  mkdirSync(OUT, { recursive: true });
  await build({
    entryPoints: ['client/main.ts'],
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'chrome69',
    outfile: join(OUT, 'app.js'),
    legalComments: 'none',
    logLevel: 'warning',
  });
  copyFileSync('client/index.html', join(OUT, 'index.html'));
  copyFileSync('client/admin.html', join(OUT, 'admin.html'));
  // The light build: no alt-audio/subtitle renditions, which we never use. Loaded only when needed.
  const hlsDir = join(createRequire(import.meta.url).resolve('hls.js/package.json'), '..', 'dist');
  copyFileSync(join(hlsDir, 'hls.light.min.js'), join(OUT, 'hls.min.js'));
  const initial = gzipSync(readFileSync(join(OUT, 'app.js'))).length + gzipSync(readFileSync(join(OUT, 'index.html'))).length;
  return initial;
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const size = await buildClient();
  process.stdout.write(`client built: initial JS+HTML ${(size / 1024).toFixed(1)} KB gzipped (budget 50 KB)\n`);
  if (size > BUDGET) {
    process.stderr.write('over the 50 KB budget\n');
    process.exit(1);
  }
}

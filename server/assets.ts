// Client files: embedded in the single executable, or read from dist/client during development.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAsset, isSea } from 'node:sea';
import type { Asset } from './app.ts';

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
};

/** The only names that may be served. Anything else is a 404, so there is no path handling at all. */
export const ASSET_NAMES = ['index.html', 'admin.html', 'app.js', 'hls.min.js'] as const;

export function assetLoader(devDir = join(process.cwd(), 'dist', 'client')): (name: string) => Promise<Asset | null> {
  const allowed = new Set<string>(ASSET_NAMES);
  return async (name) => {
    if (!allowed.has(name)) return null;
    const type = TYPES[name.slice(name.lastIndexOf('.') + 1)] ?? 'application/octet-stream';
    try {
      const body = isSea() ? new Uint8Array(getAsset(name)) : new Uint8Array(await readFile(join(devDir, name)));
      return { body, type };
    } catch {
      return null;
    }
  };
}

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('..', import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

const content = (path: string): string => readFileSync(path, 'utf8');

describe('architecture boundaries', () => {
  it('keeps client and shared modules independent of each other and the server', () => {
    const client = sources(join(ROOT, 'client'));
    const shared = sources(join(ROOT, 'shared'));
    for (const file of client) expect(content(file), file).not.toMatch(/from\s+['"][^'"]*server\//);
    for (const file of shared) {
      expect(content(file), file).not.toMatch(/from\s+['"][^'"]*(?:server|client)\//);
      expect(content(file), file).not.toMatch(/node:fs|node:path/);
    }
  });

  it('keeps routing and provider dispatch free of filesystem path APIs', () => {
    for (const file of ['server/app.ts', 'server/registry.ts']) {
      expect(content(join(ROOT, file)), file).not.toMatch(/node:(?:fs|path)/);
    }
  });

  it('does not use shell execution for media processes', () => {
    for (const file of sources(join(ROOT, 'server'))) {
      expect(content(file), file).not.toMatch(/shell\s*:\s*true|child_process\.exec/);
      expect(content(file), file).not.toMatch(/import\s*\{[^}]*\bexec(?:Sync)?\b[^}]*\}\s*from\s*['"]node:child_process/);
    }
    expect(content(join(ROOT, 'server/hls.ts'))).toMatch(/spawn\(this\.#o\.ffmpeg,\s*req\.args\(dir\)/);
    expect(content(join(ROOT, 'server/run.ts'))).toMatch(/spawn\(bin,\s*args/);
  });
});

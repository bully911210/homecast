// Test helper: a real server on an ephemeral port with its own data dir and media root.
import { serve, type ServerType } from '@hono/node-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wire, type Wired } from './wire.ts';
import type { Bins } from './bins.ts';

export interface TestServer {
  base: string;
  w: Wired;
  dataDir: string;
  /** Pair a fake TV and return its cookie header value. */
  pair(caps?: Record<string, boolean>): Promise<string>;
  get(path: string, cookie: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

export async function startTestServer(opts: { roots?: string[]; bins?: Bins } = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'homecast-test-'));
  const w = wire({ dataDir, bins: opts.bins, encoder: 'libx264' });
  w.config.update({ roots: (opts.roots ?? []).map((p, i) => ({ id: `r${i}`, path: p })) });
  await w.start();
  await w.scanner.idle();
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: w.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    w,
    dataDir,
    async pair(caps = {}) {
      const res = await fetch(`${base}/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: w.pairing.pin(), name: 'Test TV', caps }),
      });
      if (res.status !== 200) throw new Error(`pair failed: ${res.status}`);
      return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    },
    get(path, cookie, init = {}) {
      return fetch(base + path, { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: cookie } });
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      w.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

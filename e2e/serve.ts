// Starts a throwaway HomeCast on :8097 sharing the generated fixtures. Used by Playwright's webServer.
import { serve } from '@hono/node-server';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURE_DIR, generateFixtures } from '../tools/fixtures/generate.ts';
import { wire } from '../server/wire.ts';

await generateFixtures();
const dataDir = mkdtempSync(join(tmpdir(), 'homecast-e2e-'));
const w = wire({ dataDir, encoder: 'libx264', settleMs: 0 });
w.config.update({ port: 8097, roots: [{ id: 'fixtures', path: FIXTURE_DIR }], mdns: false });
await w.start();
await w.scanner.idle();
serve({ fetch: w.app.fetch, port: 8097, hostname: '127.0.0.1' }, () => process.stdout.write('e2e server ready on 8097\n'));
const stop = (): void => {
  w.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// Entry point: wire everything, listen, print the URL and PIN, clean up on exit.
import { serve } from '@hono/node-server';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { dataDir } from './config.ts';
import { initLog, log } from './log.ts';
import { lanAdapters } from './net.ts';
import { openBrowser, startTray } from './system.ts';
import { wire } from './wire.ts';

const background = process.argv.includes('--background');
const dir = dataDir();
initLog(join(dir, 'logs'));
const w = wire({ dataDir: dir });
const cfg = w.config.get();
const adminUrl = `http://localhost:${cfg.port}/admin`;

let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down');
  w.close();
  process.exit(code);
}
process.on('exit', () => w.hls?.killAll()); // never leave ffmpeg behind
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => shutdown(0));
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', err);
  shutdown(1);
});

const server = serve({ fetch: w.app.fetch, port: cfg.port, hostname: '0.0.0.0' }, async () => {
  const url = lanAdapters(cfg.adapter).map((a) => `http://${a.address}:${cfg.port}/`)[0] ?? `http://localhost:${cfg.port}/`;
  log.info(`HomeCast listening: ${url} (admin ${adminUrl})`);
  process.stdout.write(`\n  Open on your TV:  ${url}\n  PIN:              ${w.pairing.pin()}\n  Admin (this PC):  ${adminUrl}\n\n`);
  process.stdout.write((await QRCode.toString(url, { type: 'terminal', small: true })) + '\n');
  startTray(cfg.port);
  if (!background) openBrowser(adminUrl);
  await w.start();
  if (cfg.mdns) {
    try {
      const { Bonjour } = await import('bonjour-service');
      const bonjour = new Bonjour();
      bonjour.publish({ name: 'HomeCast', type: 'http', port: cfg.port, host: 'homecast.local' });
      process.on('exit', () => bonjour.destroy());
    } catch (err) {
      log.warn('mDNS disabled', err instanceof Error ? err.message : err);
    }
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    // Already running: a second launch just opens the admin page.
    log.warn(`port ${cfg.port} is in use; HomeCast is probably already running`);
    if (!background) openBrowser(adminUrl);
    shutdown(0);
    return;
  }
  log.error('server error', err);
  shutdown(1);
});

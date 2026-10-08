// Builds the whole server from a data dir. Used by main.ts and by the integration tests.
import { randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import QRCode from 'qrcode';
import type { Hono } from 'hono';
import { buildApp, type AdminApi } from './app.ts';
import { assetLoader } from './assets.ts';
import { findBins, type Bins } from './bins.ts';
import { ConfigFile } from './config.ts';
import { healthReport } from './health.ts';
import { HlsJobs, pickEncoder } from './hls.ts';
import { HttpError } from './http.ts';
import { lanAdapters } from './net.ts';
import { Pairing } from './pairing.ts';
import type { Encoder } from './playback.ts';
import { createFsProvider } from './providers/fs/index.ts';
import { Scanner } from './providers/fs/scan.ts';
import { createHomeProvider } from './providers/home.ts';
import { Registry } from './registry.ts';
import { openDb, type Database } from './store.ts';
import { autostartEnabled, setAutostart } from './system.ts';

export interface Wired {
  app: Hono<any>;
  config: ConfigFile;
  db: Database;
  bins: Bins;
  scanner: Scanner;
  pairing: Pairing;
  hls: HlsJobs | null;
  /** Kill ffmpeg jobs, find orphans, pick the encoder, scan the roots. */
  start(): Promise<void>;
  close(): void;
}

export interface WireOpts {
  dataDir: string;
  bins?: Bins;
  /** Skip the hardware encoder probe (tests). */
  encoder?: Encoder;
}

export function wire(o: WireOpts): Wired {
  const config = new ConfigFile(o.dataDir);
  const cfg = config.get();
  const db = openDb(join(o.dataDir, 'homecast.db'));
  const bins = o.bins ?? findBins();
  const hls = bins.ffmpeg
    ? new HlsJobs({ ffmpeg: bins.ffmpeg, dir: join(o.dataDir, 'cache', 'hls'), maxJobs: cfg.maxJobs, cacheBytes: cfg.cacheGb * 1024 ** 3 })
    : null;
  let encoder: Encoder | 'probing' = o.encoder ?? 'probing';
  const currentEncoder = (): Encoder => (encoder === 'probing' ? 'libx264' : encoder);

  const scanner = new Scanner(db, bins.ffprobe);
  const registry = new Registry();
  registry.add(createHomeProvider(db, registry));
  registry.add(createFsProvider({ db, scanner, ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe, hls, encoder: currentEncoder, cacheDir: join(o.dataDir, 'cache') }));
  const pairing = new Pairing(db);
  const adapters = () => lanAdapters(config.get().adapter);
  const health = healthReport({ db, bins, hls, scanner, encoder: () => encoder, adapters, port: () => config.get().port, startedAt: Date.now() });

  const admin: AdminApi = {
    async status() {
      const urls = adapters().map((a) => `http://${a.address}:${config.get().port}/`);
      const url = urls[0] ?? `http://localhost:${config.get().port}/`;
      return {
        url,
        urls,
        qr: await QRCode.toString(url, { type: 'svg', margin: 1 }),
        pin: pairing.pin(),
        pinExpiresAt: pairing.pinExpiresAt(),
        roots: config.get().roots,
        devices: pairing.devices(),
        autostart: await autostartEnabled(),
        health: await health(true),
      };
    },
    async addRoot(path) {
      if (!isAbsolute(path)) throw new HttpError(400, 'use a full folder path, like D:\\Movies');
      let real: string;
      try {
        real = await realpath(path);
        if (!(await stat(real)).isDirectory()) throw new Error('not a folder');
      } catch {
        throw new HttpError(400, 'that folder does not exist or cannot be read');
      }
      const roots = config.get().roots;
      const same = (a: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === real.toLowerCase() : a === real);
      if (roots.some((r) => same(r.path))) throw new HttpError(409, 'that folder is already shared');
      const next = config.update({ roots: [...roots, { id: randomBytes(6).toString('base64url'), path: real }] });
      await scanner.setRoots(next.roots);
    },
    async removeRoot(id) {
      const next = config.update({ roots: config.get().roots.filter((r) => r.id !== id) });
      await scanner.setRoots(next.roots);
    },
    async rescan() {
      await scanner.scanAll();
    },
    async setAutostart(on) {
      await setAutostart(on);
    },
  };

  const app = buildApp({ db, registry, pairing, health, admin, asset: assetLoader() });

  return {
    app,
    config,
    db,
    bins,
    scanner,
    pairing,
    hls,
    async start() {
      await hls?.sweepOrphans();
      if (encoder === 'probing') void pickEncoder(bins.ffmpeg).then((e) => (encoder = e));
      await scanner.setRoots(config.get().roots);
    },
    close() {
      hls?.killAll();
      scanner.close();
      try {
        db.close();
      } catch {
        // already closed
      }
    },
  };
}

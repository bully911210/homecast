import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Item } from '../shared/types.ts';
import { FIXTURE_DIR } from '../tools/fixtures/generate.ts';
import { findBins } from './bins.ts';
import { HlsJobs } from './hls.ts';
import { startTestServer, type TestServer } from './testkit.ts';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pids: Iterable<number>): Promise<number[]> {
  const list = [...pids];
  for (let i = 0; i < 50 && list.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
  return list.filter(alive);
}

describe('HLS job manager', () => {
  let s: TestServer;
  let cookie: string;
  let videos: Item[];

  beforeAll(async () => {
    s = await startTestServer({ roots: [FIXTURE_DIR] });
    cookie = await s.pair({ h264: true, hls: true });
    const root = (await (await s.get('/api/items', cookie)).json()) as { items: Item[] };
    const rootFolder = root.items.find((i) => i.meta?.root)!;
    const top = (await (await s.get(`/api/items?parent=${rootFolder.id}`, cookie)).json()) as { items: Item[] };
    const longFolder = top.items.find((i) => i.title === 'Long')!;
    const long = (await (await s.get(`/api/items?parent=${longFolder.id}`, cookie)).json()) as { items: Item[] };
    videos = [...top.items.filter((i) => i.kind === 'video' && !i.title.startsWith('Direct')), ...long.items, ...long.items, ...long.items];
    expect(videos.length).toBeGreaterThanOrEqual(4);
  });
  afterAll(() => s.close());

  it('50 random start/seek/abort cycles leave zero orphan ffmpeg processes', async () => {
    const seen = new Set<number>();
    let rnd = 42;
    const rand = (n: number): number => {
      rnd = (rnd * 1103515245 + 12345) % 2 ** 31;
      return rnd % n;
    };
    for (let i = 0; i < 50; i++) {
      const v = videos[rand(videos.length)]!;
      const t = rand(80);
      const ac = new AbortController();
      const req = s.get(`/api/open/${v.id}?hls=index.m3u8&t=${t}`, cookie, { signal: ac.signal }).then((r) => r.text()).catch(() => '');
      const action = rand(3);
      if (action === 0) ac.abort(); // abort immediately
      else if (action === 1) setTimeout(() => ac.abort(), rand(200)); // abort mid-wait
      await new Promise((r) => setTimeout(r, 30));
      for (const p of s.w.hls!.pids()) seen.add(p);
      await req; // action 2: let it finish
      for (const p of s.w.hls!.pids()) seen.add(p);
      expect(s.w.hls!.activeJobs()).toBeLessThanOrEqual(2);
    }
    expect(seen.size).toBeGreaterThan(5);
    s.w.hls!.killAll();
    expect(await waitDead(seen)).toEqual([]);
  });
});

describe('HLS job start is atomic', () => {
  it('five simultaneous requests for one stream start exactly one ffmpeg', async () => {
    const s = await startTestServer({ roots: [FIXTURE_DIR] });
    const cookie = await s.pair({ h264: true });
    const root = ((await (await s.get('/api/items', cookie)).json()) as { items: Item[] }).items.find((i) => i.meta?.root)!;
    const top = ((await (await s.get(`/api/items?parent=${root.id}`, cookie)).json()) as { items: Item[] }).items;
    const long = top.find((i) => i.title === 'Long')!;
    const movie = ((await (await s.get(`/api/items?parent=${long.id}`, cookie)).json()) as { items: Item[] }).items[0]!;
    const pids = new Set<number>();
    const reqs = Array.from({ length: 5 }, () => s.get(`/api/open/${movie.id}?hls=index.m3u8&t=7`, cookie).then((r) => r.text()));
    const poll = setInterval(() => s.w.hls!.pids().forEach((p) => pids.add(p)), 10);
    const bodies = await Promise.all(reqs);
    clearInterval(poll);
    s.w.hls!.pids().forEach((p) => pids.add(p));
    expect(bodies.every((b) => b.includes('#EXTINF'))).toBe(true);
    expect(pids.size).toBe(1);
    await s.close();
  });

  it('error responses never contain server paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'homecast-err-'));
    const jobs = new HlsJobs({ ffmpeg: findBins().ffmpeg!, dir, maxJobs: 2, cacheBytes: 1e9 });
    const res = await jobs.serve({
      key: 'bad',
      group: 'bad',
      file: 'index.m3u8',
      playbackMode: 'transcode',
      uri: (f) => f,
      args: () => ['-hide_banner', '-i', join(dir, 'does-not-exist.mkv'), '-f', 'hls', join(dir, 'x.m3u8')],
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(dir);
    jobs.killAll();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('orphan sweep after a crash', () => {
  it('kills ffmpeg processes recorded by a previous run', async () => {
    const { ffmpeg } = findBins();
    const dir = mkdtempSync(join(tmpdir(), 'homecast-orphan-'));
    // A long-running ffmpeg that "survived" a crashed server.
    const orphan = spawn(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=5', '-f', 'null', '-'], { stdio: 'ignore', detached: true });
    orphan.unref();
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(orphan.pid!)).toBe(true);
    writeFileSync(join(dir, 'pids.json'), JSON.stringify([orphan.pid, 999_999_999]));
    const jobs = new HlsJobs({ ffmpeg: ffmpeg!, dir, maxJobs: 2, cacheBytes: 1e9 });
    expect(await jobs.sweepOrphans()).toBe(1);
    expect(await waitDead([orphan.pid!])).toEqual([]);
    jobs.killAll();
    rmSync(dir, { recursive: true, force: true });
  });
});

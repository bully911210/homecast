// End-to-end over HTTP against the generated fixtures: pairing, guards, browsing, playback paths, state.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Item } from '../shared/types.ts';
import { FIXTURE_DIR } from '../tools/fixtures/generate.ts';
import { startTestServer, type TestServer } from './testkit.ts';

let s: TestServer;
let cookie: string;
let all: Map<string, Item>;

async function items(parent?: string): Promise<Item[]> {
  const res = await s.get(`/api/items${parent ? `?parent=${encodeURIComponent(parent)}` : ''}`, cookie);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Item[] }).items;
}

async function walk(parent: string, out: Map<string, Item>): Promise<void> {
  for (const it of await items(parent)) {
    out.set(it.title, it);
    if (it.kind === 'folder') await walk(it.id, out);
  }
}

const byTitle = (t: string): Item => {
  const it = all.get(t);
  if (!it) throw new Error(`no item titled ${t}; have ${[...all.keys()].join(', ')}`);
  return it;
};

beforeAll(async () => {
  s = await startTestServer({ roots: [FIXTURE_DIR] });
  cookie = await s.pair({ h264: true, hls: true });
  all = new Map();
  const root = (await items()).find((i) => i.meta?.root)!;
  await walk(root.id, all);
});
afterAll(() => s.close());

describe('guards', () => {
  it('item API needs pairing', async () => {
    const res = await fetch(`${s.base}/api/items`);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('PAIRING_REQUIRED');
  });

  it('health is public but minimal; full for loopback', async () => {
    const h = (await (await fetch(`${s.base}/api/health`)).json()) as Record<string, unknown>;
    expect(h.ok).toBe(true);
    expect(h.ffmpeg).toBe(true); // loopback gets the full report
  });

  it('rejects non-LAN remote addresses', async () => {
    const env = { incoming: { socket: { remoteAddress: '8.8.8.8' } } };
    const res = await s.w.app.fetch(new Request('http://192.168.1.5:8096/api/health', { headers: { host: '192.168.1.5:8096' } }), env);
    expect(res.status).toBe(403);
  });

  it('rejects rebinding hostnames', async () => {
    const env = { incoming: { socket: { remoteAddress: '192.168.1.40' } } };
    const res = await s.w.app.fetch(new Request('http://evil.example/api/health', { headers: { host: 'evil.example:8096' } }), env);
    expect(res.status).toBe(403);
  });

  it('rejects cross-origin writes', async () => {
    const res = await fetch(`${s.base}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ pin: '000000' }),
    });
    expect(res.status).toBe(403);
  });

  it('admin is loopback only', async () => {
    const env = { incoming: { socket: { remoteAddress: '192.168.1.40' } } };
    const res = await s.w.app.fetch(new Request('http://192.168.1.5:8096/admin/api/status', { headers: { host: '192.168.1.5:8096' } }), env);
    expect(res.status).toBe(403);
    expect((await fetch(`${s.base}/admin/api/status`)).status).toBe(200);
  });

  it('admin writes need JSON (forces a CORS preflight for cross-site pages)', async () => {
    const res = await fetch(`${s.base}/admin/api/roots`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"path":"C:/"}' });
    expect(res.status).toBe(415);
  });

  it('wrong PIN is refused', async () => {
    const res = await fetch(`${s.base}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: 'abc' }) });
    expect(res.status).toBe(400);
  });
});

describe('library', () => {
  it('indexes media with pretty titles, skips hidden files and non-media', () => {
    expect(all.has('Direct Movie (2019)')).toBe(true);
    expect(all.has('Show Name S01E02')).toBe(true);
    expect(all.has('Ünïcödé Fïlm mit Leerzeichen (2017)')).toBe(true);
    expect([...all.keys()].some((k) => k.includes('secret') || k.includes('notes'))).toBe(false);
  });

  it('marks broken files instead of crashing', () => {
    expect(byTitle('corrupt').meta?.broken).toBe(true);
    expect(byTitle('empty').meta?.broken).toBe(true);
    expect(byTitle('Direct Movie (2019)').meta?.broken).toBe(false);
  });

  it('exposes audio tracks and sidecar subtitles', () => {
    const m = byTitle('Remux Movie (2020)').meta!;
    expect(m.duration).toBeGreaterThan(5);
    expect((m.subs as { id: string; lang?: string }[]).some((x) => x.id === 'f0' && x.lang === 'en')).toBe(true);
  });

  it('home shows Recently Added as a row', async () => {
    const root = await items();
    expect(root.find((i) => i.id === 'fs:recent')?.meta?.row).toBe(true);
    expect((await items('fs:recent')).length).toBeGreaterThan(3);
  });
});

describe('playback', () => {
  it('direct path: H.264/AAC MP4 streams with Range', async () => {
    const res = await s.get(`/api/open/${byTitle('Direct Movie (2019)').id}`, cookie, { headers: { Range: 'bytes=0-1023' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('X-HomeCast-Playback')).toBe('direct');
    expect((await res.arrayBuffer()).byteLength).toBe(1024);
  });

  it('HEAD exposes the server plan and the next attempt advances the ladder', async () => {
    const id = byTitle('Direct Movie (2019)').id;
    const first = await s.get(`/api/open/${id}`, cookie, { method: 'HEAD' });
    expect(first.status).toBe(200);
    expect(first.headers.get('X-HomeCast-Playback')).toBe('direct');
    const fallback = await s.get(`/api/open/${id}?attempt=1`, cookie, { method: 'HEAD' });
    expect(fallback.status).toBe(204);
    expect(fallback.headers.get('X-HomeCast-Playback')).toBe('remux');
    expect(fallback.headers.get('location')).toContain('attempt=1');
  });

  it.each(['Remux Movie (2020)', 'Hevc Movie (2021)', 'Dts Audio (2018)', 'Av1 Movie (2022)', 'Ünïcödé Fïlm mit Leerzeichen (2017)', 'Show Name S01E02'])(
    'HLS path for %s: redirect, playlist, decodable first segment',
    async (title) => {
      const id = byTitle(title).id;
      const first = await s.get(`/api/open/${id}`, cookie, { redirect: 'manual' });
      expect(first.status).toBe(302);
      expect(first.headers.get('X-HomeCast-Playback')).toMatch(/^(remux|hls|transcode)$/);
      const playlistUrl = first.headers.get('location')!;
      expect(playlistUrl).toContain('hls=index.m3u8');
      const pl = await s.get(playlistUrl, cookie);
      expect(pl.status).toBe(200);
      expect(pl.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
      expect(pl.headers.get('X-HomeCast-Playback')).toBe(first.headers.get('X-HomeCast-Playback'));
      const text = await pl.text();
      expect(text).toContain('#EXTINF');
      const seg = text.split('\n').find((l) => l.startsWith('/api/open/'))!;
      expect(seg).toContain(`/api/open/${id}?hls=seg_00000`);
      const segRes = await s.get(seg, cookie);
      expect(segRes.status).toBe(200);
      expect(segRes.headers.get('X-HomeCast-Playback')).toBe(first.headers.get('X-HomeCast-Playback'));
      expect((await segRes.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    },
  );

  it('broken file: 422, not a crash', async () => {
    const res = await s.get(`/api/open/${byTitle('corrupt').id}`, cookie);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('MEDIA_UNREADABLE');
  });

  it('thumbnails for video and image, cached', async () => {
    for (const t of ['Direct Movie (2019)', 'landscape.jpg', 'rotated.jpg']) {
      const res = await s.get(byTitle(t).thumb!, cookie);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      await res.arrayBuffer();
    }
  });

  it('sidecar SRT becomes WebVTT', async () => {
    const res = await s.get(`/api/open/${byTitle('Remux Movie (2020)').id}?track=f0`, cookie);
    expect(res.status).toBe(200);
    const vtt = await res.text();
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:01.000 --> 00:00:03.500');
  });
});

describe('state', () => {
  it('saves position and feeds Continue Watching', async () => {
    const id = byTitle('Remux Movie (2020)').id;
    const res = await s.get(`/api/state/${id}`, cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 40, duration: 600 }),
    });
    expect(res.status).toBe(200);
    const root = await items();
    expect(root[0]?.id).toBe('home:continue');
    const row = await items('home:continue');
    expect(row[0]?.id).toBe(id);
    expect(row[0]?.meta?.position).toBe(40);
    await s.get(`/api/state/${id}`, cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 552, duration: 600 }),
    });
    expect((await items('home:continue')).some((it) => it.id === id)).toBe(false);
    await s.get(`/api/state/${id}`, cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 553, duration: 600 }),
    });
    expect((await items()).some((it) => it.id === 'home:continue')).toBe(false);
  });

  it('rejects bad bodies and unknown providers', async () => {
    const post = (id: string, body: string) =>
      s.get(`/api/state/${id}`, cookie, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect((await post(byTitle('Remux Movie (2020)').id, '{"position":-1}')).status).toBe(400);
    expect((await post('nope:abc', '{"position":1}')).status).toBe(404);
  });

  it('clamps progress to duration and does not mark very short media watched', async () => {
    const id = byTitle('Remux Movie (2020)').id;
    const clamped = await s.get(`/api/state/${id}`, cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 1000, duration: 100 }),
    });
    expect((await clamped.json()).state.position).toBe(100);
    const short = await s.get(`/api/state/${id}`, cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 4, duration: 4, watched: true }),
    });
    expect((await short.json()).state.watched).toBe(false);
  });
});

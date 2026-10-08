import { mkdirSync, mkdtempSync, openSync, closeSync, ftruncateSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStreamCount, parseRange } from './stream.ts';
import { startTestServer, type TestServer } from './testkit.ts';

describe('parseRange', () => {
  const cases: [string | null, number, ReturnType<typeof parseRange>][] = [
    [null, 100, null],
    ['bytes=0-9', 100, { start: 0, end: 9 }],
    ['bytes=90-', 100, { start: 90, end: 99 }],
    ['bytes=-10', 100, { start: 90, end: 99 }],
    ['bytes=-500', 100, { start: 0, end: 99 }],
    ['bytes=50-5000', 100, { start: 50, end: 99 }],
    ['bytes=100-', 100, 'unsatisfiable'],
    ['bytes=-0', 100, 'unsatisfiable'],
    ['bytes=0-', 0, 'unsatisfiable'],
    ['bytes=9-3', 100, null],
    ['bytes=0-1,5-6', 100, null],
    ['items=0-5', 100, null],
    ['bytes=abc', 100, null],
    ['bytes=-', 100, null],
  ];
  it.each(cases)('%j of %d', (h, size, want) => expect(parseRange(h, size)).toEqual(want));
});

describe('direct streaming over HTTP', () => {
  let dir: string;
  let s: TestServer;
  let cookie: string;
  const small = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  const ids: Record<string, string> = {};

  const waitForStreams = async (n: number): Promise<number> => {
    for (let i = 0; i < 100 && openStreamCount() !== n; i++) await new Promise((r) => setTimeout(r, 20));
    return openStreamCount();
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'homecast-range-'));
    mkdirSync(join(dir, 'pics'));
    writeFileSync(join(dir, 'pics', 'small.jpg'), small);
    writeFileSync(join(dir, 'pics', 'empty.jpg'), Buffer.alloc(0));
    const fd = openSync(join(dir, 'pics', 'big.jpg'), 'w');
    ftruncateSync(fd, 64 * 1024 * 1024); // sparse 64 MB: big enough that an abort happens mid-stream
    closeSync(fd);
    s = await startTestServer({ roots: [dir] });
    cookie = await s.pair();
    const root = (await (await s.get('/api/items', cookie)).json()) as { items: { id: string; title: string }[] };
    const pics = root.items.find((i) => i.title === 'media' || i.title.startsWith('homecast-range'))!;
    const folder = (await (await s.get(`/api/items?parent=${pics.id}`, cookie)).json()) as { items: { id: string; title: string }[] };
    const sub = (await (await s.get(`/api/items?parent=${folder.items[0]!.id}`, cookie)).json()) as { items: { id: string; title: string }[] };
    for (const it of sub.items) ids[it.title] = it.id;
  });

  afterAll(async () => {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const open = (name: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Response> =>
    s.get(`/api/open/${ids[name]}`, cookie, { headers, method });

  it('no range: 200 with full body and validators', async () => {
    const res = await open('small.jpg');
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('1000');
    expect(res.headers.get('etag')).toMatch(/^W\/"/);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(small);
  });

  it('closed range: 206 with exact bytes', async () => {
    const res = await open('small.jpg', { Range: 'bytes=10-19' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(small.subarray(10, 20));
  });

  it('open-ended range', async () => {
    const res = await open('small.jpg', { Range: 'bytes=990-' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(small.subarray(990));
  });

  it('suffix range', async () => {
    const res = await open('small.jpg', { Range: 'bytes=-5' });
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(small.subarray(995));
  });

  it('end past EOF is clamped', async () => {
    const res = await open('small.jpg', { Range: 'bytes=500-999999' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-length')).toBe('500');
    await res.arrayBuffer();
  });

  it('out of bounds: 416 with */size', async () => {
    const res = await open('small.jpg', { Range: 'bytes=1000-' });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */1000');
  });

  it('malformed and multi ranges fall back to 200', async () => {
    for (const r of ['bytes=x-y', 'bytes=0-1,5-6']) {
      const res = await open('small.jpg', { Range: r });
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }
  });

  it('HEAD returns headers without a body or an open file', async () => {
    const res = await open('big.jpg', {}, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(64 * 1024 * 1024));
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    expect(await waitForStreams(0)).toBe(0);
  });

  it('If-None-Match returns 304; If-Range mismatch returns the full body', async () => {
    const etag = (await open('small.jpg', {}, 'HEAD')).headers.get('etag')!;
    expect((await open('small.jpg', { 'If-None-Match': etag })).status).toBe(304);
    const stale = await open('small.jpg', { Range: 'bytes=0-9', 'If-Range': 'W/"stale"' });
    expect(stale.status).toBe(200);
    await stale.arrayBuffer();
    const fresh = await open('small.jpg', { Range: 'bytes=0-9', 'If-Range': etag });
    expect(fresh.status).toBe(206);
    await fresh.arrayBuffer();
  });

  it('zero-byte file: 200 empty, any range 416', async () => {
    const res = await open('empty.jpg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('0');
    expect((await open('empty.jpg', { Range: 'bytes=0-' })).status).toBe(416);
  });

  it('mid-stream abort leaks no file handles', async () => {
    const ac = new AbortController();
    const res = await s.get(`/api/open/${ids['big.jpg']}`, cookie, { signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // first chunk arrives, the file stream is open
    expect(openStreamCount()).toBe(1);
    ac.abort();
    await reader.cancel().catch(() => {});
    expect(await waitForStreams(0)).toBe(0);
    // On Windows an open handle would make this throw EBUSY.
    unlinkSync(join(dir, 'pics', 'big.jpg'));
    expect(readFileSync(join(dir, 'pics', 'small.jpg')).length).toBe(1000);
  });
});

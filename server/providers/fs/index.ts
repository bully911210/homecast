// The fs provider: approved folders on this PC become Items. The only module that knows about paths.
import { basename } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Item, OpenCtx, ProviderWithGet } from '../../../shared/types.ts';
import { HttpError, notFound } from '../../http.ts';
import type { HlsJobs } from '../../hls.ts';
import { resolveInJail } from '../../jail.ts';
import { ext, mimeOf, probeFile, type Probe } from '../../media.ts';
import { buildHlsArgs, canDirectPlay, type Encoder } from '../../playback.ts';
import type { Database } from '../../store.ts';
import { serveFile } from '../../stream.ts';
import { embeddedToVtt, sidecarToVtt, TEXT_SUB_CODECS } from '../../subs.ts';
import { getThumb } from '../../thumbs.ts';
import * as repo from './repo.ts';
import type { FsRow, Sidecar } from './repo.ts';
import type { Scanner } from './scan.ts';
import { parseTitle } from './titles.ts';

export interface FsDeps {
  db: Database;
  scanner: Scanner;
  ffmpeg: string | null;
  ffprobe: string | null;
  hls: HlsJobs | null;
  encoder: () => Encoder;
  cacheDir: string; // thumbs/ and subs/ live here
}

const RECENT = 'recent';
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function opaque(id: string): string {
  if (!id.startsWith('fs:')) throw notFound();
  return id.slice(3);
}

function parseProbe(row: FsRow): Probe | null {
  return row.probe ? (JSON.parse(row.probe) as Probe) : null;
}

function sidecarsOf(row: FsRow): Sidecar[] {
  return row.sidecars ? (JSON.parse(row.sidecars) as Sidecar[]) : [];
}

function toItem(row: FsRow): Item {
  const id = `fs:${row.id}`;
  const parentId = row.parent_id ? `fs:${row.parent_id}` : undefined;
  if (row.kind === 'folder') return { id, kind: 'folder', title: row.title, parentId };
  const probe = parseProbe(row);
  const name = basename(row.rel);
  const t = row.kind === 'video' ? parseTitle(name) : { title: row.title };
  const meta: Record<string, unknown> = { size: row.size, addedAt: row.added_at, broken: row.broken === 1 };
  if ('year' in t && t.year) meta.year = t.year;
  if ('season' in t && t.season !== undefined) Object.assign(meta, { season: t.season, episode: t.episode });
  if (probe) {
    meta.duration = probe.duration;
    if (probe.video) Object.assign(meta, { width: probe.video.width, height: probe.video.height, videoCodec: probe.video.codec });
    meta.audio = probe.audio.map((a) => ({ index: a.index, codec: a.codec, channels: a.channels, lang: a.lang, title: a.title }));
    const embedded = probe.subs.filter((s) => TEXT_SUB_CODECS.has(s.codec)).map((s) => ({ id: `s${s.index}`, lang: s.lang, title: s.title, forced: s.forced }));
    const side = sidecarsOf(row).map((s, i) => ({ id: `f${i}`, lang: s.lang, title: s.file, forced: s.forced }));
    meta.subs = [...embedded, ...side];
  }
  return { id, kind: row.kind, title: row.title, parentId, thumb: `/api/thumb/${id}?v=${Math.floor(row.mtime_ms).toString(36)}`, meta };
}

function sortItems(items: Item[]): Item[] {
  return [...items].sort((a, b) => {
    if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1;
    return collator.compare(a.title, b.title);
  });
}

function intParam(q: URLSearchParams, name: string, max: number): number | undefined {
  const v = q.get(name);
  if (v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, `bad ${name}`);
  return n;
}

export function createFsProvider(d: FsDeps): ProviderWithGet {
  async function locate(row: FsRow): Promise<string> {
    const real = d.scanner.rootReal(row.root_id);
    const path = real ? await resolveInJail(real, row.rel) : null;
    if (!path) throw notFound('file is unavailable');
    return path;
  }

  async function ensureProbe(row: FsRow, path: string): Promise<Probe> {
    const existing = parseProbe(row);
    if (existing) return existing;
    if (row.broken === 1 || !d.ffprobe) throw new HttpError(422, 'this file cannot be played');
    try {
      const p = await probeFile(d.ffprobe, path);
      repo.setProbe(d.db, row.id, p);
      return p;
    } catch {
      repo.setProbe(d.db, row.id, null);
      throw new HttpError(422, 'this file cannot be played');
    }
  }

  async function openMain(row: FsRow, ctx: OpenCtx): Promise<Response> {
    if (row.kind === 'folder') throw new HttpError(400, 'folders cannot be opened');
    const path = await locate(row);
    if (row.kind === 'image') return serveFile(ctx.req, path, { contentType: mimeOf(path), cacheControl: 'private, max-age=86400' });

    const probe = await ensureProbe(row, path);
    const q = ctx.query;
    const audioIndex = intParam(q, 'a', 999);
    if (audioIndex !== undefined && !probe.audio.some((a) => a.index === audioIndex)) throw new HttpError(400, 'unknown audio track');
    const start = intParam(q, 't', 1e7) ?? 0;
    const hlsFile = q.get('hls');
    // safe=1: the client failed to play what its caps promised (common with HEVC). Use H.264/AAC only.
    const safe = q.get('safe') === '1';
    const caps = safe ? { ...ctx.device.caps, hevc: false, vp9: false, av1: false } : ctx.device.caps;

    if (hlsFile === null) {
      if (start === 0 && !safe && canDirectPlay(probe, caps, ext(path), audioIndex)) {
        return serveFile(ctx.req, path, { contentType: mimeOf(path) });
      }
      const qs = new URLSearchParams({ hls: 'index.m3u8', t: String(Math.floor(start)) });
      if (audioIndex !== undefined) qs.set('a', String(audioIndex));
      if (safe) qs.set('safe', '1');
      return new Response(null, { status: 302, headers: { Location: `/api/open/fs:${row.id}?${qs}`, 'Cache-Control': 'no-store' } });
    }
    if (!d.hls || !d.ffmpeg) throw new HttpError(503, 'ffmpeg is not available, so this file cannot be converted');
    const t = Math.floor(start);
    const suffix = `${audioIndex !== undefined ? `&a=${audioIndex}` : ''}${safe ? '&safe=1' : ''}`;
    return d.hls.serve({
      key: `${row.id}-${ctx.device.id}-${t}-${audioIndex ?? 'd'}${safe ? '-s' : ''}`,
      group: `${row.id}-${ctx.device.id}`,
      file: hlsFile,
      uri: (f) => `/api/open/fs:${row.id}?hls=${f}&t=${t}${suffix}`,
      args: (outDir) => buildHlsArgs(probe, caps, { input: path, outDir, start: t, audioIndex, encoder: d.encoder() }).args,
    });
  }

  async function openThumb(row: FsRow, ctx: OpenCtx): Promise<Response> {
    if (row.kind === 'folder' || !d.ffmpeg) throw notFound('no thumbnail');
    const path = await locate(row);
    const duration = parseProbe(row)?.duration ?? 0;
    const out = await getThumb(d.ffmpeg, join(d.cacheDir, 'thumbs'), `${row.id}-${Math.floor(row.mtime_ms)}`, row.kind, path, duration);
    if (!out) throw notFound('no thumbnail');
    return serveFile(ctx.req, out, { contentType: 'image/jpeg', cacheControl: 'private, max-age=604800' });
  }

  async function openSub(row: FsRow, ctx: OpenCtx): Promise<Response> {
    const track = ctx.query.get('track') ?? '';
    const cacheFile = join(d.cacheDir, 'subs', `${row.id}-${Math.floor(row.mtime_ms)}-${track.replace(/[^a-z0-9]/g, '')}.vtt`);
    const vtt = (text: string): Response => new Response(text, { headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, max-age=3600' } });
    if (existsSync(cacheFile)) return vtt(await readFile(cacheFile, 'utf8'));
    const path = await locate(row);
    let text: string;
    const emb = track.match(/^s(\d{1,4})$/);
    const side = track.match(/^f(\d{1,3})$/);
    if (emb) {
      const idx = Number(emb[1]);
      const s = parseProbe(row)?.subs.find((x) => x.index === idx && TEXT_SUB_CODECS.has(x.codec));
      if (!s || !d.ffmpeg) throw notFound('unknown subtitle track');
      text = await embeddedToVtt(d.ffmpeg, path, idx);
    } else if (side) {
      const sc = sidecarsOf(row)[Number(side[1])];
      const real = d.scanner.rootReal(row.root_id);
      const dirRel = row.rel.includes('/') ? row.rel.slice(0, row.rel.lastIndexOf('/') + 1) : '';
      const subPath = sc && real ? await resolveInJail(real, dirRel + sc.file) : null;
      if (!subPath) throw notFound('unknown subtitle track');
      text = await sidecarToVtt(subPath);
    } else {
      throw new HttpError(400, 'bad track');
    }
    await mkdir(join(d.cacheDir, 'subs'), { recursive: true });
    await writeFile(cacheFile, text);
    return vtt(text);
  }

  return {
    id: 'fs',

    async list(parentId?: string): Promise<Item[]> {
      if (parentId === undefined) {
        const roots = repo
          .rootRows(d.db, d.scanner.rootIds())
          .map((r) => ({ ...toItem(r), meta: { root: true, offline: d.scanner.rootReal(r.root_id) === null } }));
        const hasRecent = repo.recentlyAdded(d.db, 1).length > 0;
        const recent: Item[] = hasRecent ? [{ id: `fs:${RECENT}`, kind: 'folder', title: 'Recently Added', meta: { row: true } }] : [];
        return [...recent, ...sortItems(roots)];
      }
      const key = opaque(parentId);
      if (key === RECENT) return repo.recentlyAdded(d.db, 30).map(toItem);
      const row = repo.getRow(d.db, key);
      if (!row || row.kind !== 'folder') throw notFound();
      return sortItems(repo.children(d.db, row.id).map(toItem));
    },

    async get(ids: readonly string[]): Promise<Item[]> {
      const keys = ids.filter((i) => i.startsWith('fs:')).map((i) => i.slice(3));
      const byId = new Map(repo.byIds(d.db, keys).map((r) => [r.id, toItem(r)]));
      return keys.map((k) => byId.get(k)).filter((x): x is Item => x !== undefined);
    },

    async open(id: string, ctx: OpenCtx): Promise<Response> {
      const row = repo.getRow(d.db, opaque(id));
      if (!row) throw notFound();
      if (ctx.variant === 'thumb') return openThumb(row, ctx);
      if (ctx.variant === 'sub') return openSub(row, ctx);
      return openMain(row, ctx);
    },

    watch(onChange: () => void): () => void {
      d.scanner.onChange(onChange);
      return () => d.scanner.onChange(() => {});
    },
  };
}

// Walk roots, index media, probe with a 4-worker ffprobe queue, watch for changes.
import { watch, type FSWatcher } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Root } from '../../config.ts';
import { log } from '../../log.ts';
import { ext, kindOf, probeFile } from '../../media.ts';
import { tx, type Database } from '../../store.ts';
import * as repo from './repo.ts';
import type { Sidecar } from './repo.ts';
import { parseTitle } from './titles.ts';

const PROBE_WORKERS = 4;
const DEBOUNCE_MS = 2000;
const POLL_MS = 5 * 60_000;
const IGNORE_RE = /^(\.|\$recycle\.bin$|system volume information$|@eadir$|#recycle$|desktop\.ini$|thumbs\.db$)/i;
const SUB_EXT = new Set(['srt', 'vtt']);

/** "Movie.en.forced.srt" next to "Movie.mkv" -> { lang: "en", forced: true }. */
export function matchSidecar(videoName: string, subName: string): Sidecar | null {
  const stem = videoName.slice(0, videoName.length - ext(videoName).length - 1);
  if (!SUB_EXT.has(ext(subName)) || !subName.toLowerCase().startsWith(stem.toLowerCase() + '.')) return null;
  const tags = subName
    .slice(stem.length + 1, subName.length - ext(subName).length - 1)
    .toLowerCase()
    .split('.')
    .filter(Boolean);
  const forced = tags.includes('forced');
  const lang = tags.find((t) => /^[a-z]{2,3}(-[a-z]{2})?$/.test(t) && t !== 'sdh');
  return { file: subName, lang, forced };
}

export interface ScanStatus {
  scanning: boolean;
  lastScanAt: number | null;
  offlineRoots: string[];
}

type Watcher = { kind: 'watch'; w: FSWatcher } | { kind: 'poll'; t: NodeJS.Timeout };

export class Scanner {
  readonly #db: Database;
  readonly #ffprobe: string | null;
  readonly #roots = new Map<string, { root: Root; real: string | null }>();
  readonly #watchers = new Map<string, Watcher>();
  readonly #running = new Map<string, Promise<void>>();
  readonly #queued = new Set<string>();
  readonly #debounce = new Map<string, NodeJS.Timeout>();
  #lastScanAt: number | null = null;
  #onChange: () => void = () => {};

  constructor(db: Database, ffprobe: string | null) {
    this.#db = db;
    this.#ffprobe = ffprobe;
  }

  onChange(fn: () => void): void {
    this.#onChange = fn;
  }

  /** Replace the root set: stop watching removed roots, drop their rows, scan new ones. */
  async setRoots(roots: readonly Root[]): Promise<void> {
    const keep = new Set(roots.map((r) => r.id));
    for (const id of [...this.#roots.keys()]) {
      if (!keep.has(id)) {
        this.#unwatch(id);
        this.#roots.delete(id);
      }
    }
    repo.dropRootsExcept(this.#db, [...keep]);
    const fresh = roots.filter((r) => this.#roots.get(r.id)?.root.path !== r.path);
    for (const r of fresh) {
      this.#unwatch(r.id);
      this.#roots.set(r.id, { root: r, real: null });
    }
    await Promise.all(fresh.map((r) => this.scan(r.id)));
  }

  rootReal(rootId: string): string | null {
    return this.#roots.get(rootId)?.real ?? null;
  }

  rootIds(): string[] {
    return [...this.#roots.keys()];
  }

  status(): ScanStatus {
    return {
      scanning: this.#running.size > 0,
      lastScanAt: this.#lastScanAt,
      offlineRoots: [...this.#roots.values()].filter((r) => r.real === null).map((r) => r.root.path),
    };
  }

  /** Scan one root; concurrent requests collapse into one follow-up scan. */
  scan(rootId: string): Promise<void> {
    const running = this.#running.get(rootId);
    if (running) {
      this.#queued.add(rootId);
      return running;
    }
    const p = this.#scanRoot(rootId)
      .catch((err: unknown) => log.error(`scan failed for root ${rootId}`, err))
      .finally(() => {
        this.#running.delete(rootId);
        this.#lastScanAt = Date.now();
        this.#onChange();
        if (this.#queued.delete(rootId)) void this.scan(rootId);
      });
    this.#running.set(rootId, p);
    return p;
  }

  async scanAll(): Promise<void> {
    await Promise.all(this.rootIds().map((id) => this.scan(id)));
  }

  /** Wait until no scan is running (used by tests and shutdown). */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.all([...this.#running.values()]);
  }

  close(): void {
    for (const id of [...this.#watchers.keys()]) this.#unwatch(id);
    for (const t of this.#debounce.values()) clearTimeout(t);
    this.#debounce.clear();
  }

  async #scanRoot(rootId: string): Promise<void> {
    const entry = this.#roots.get(rootId);
    if (!entry) return;
    let real: string;
    try {
      real = await realpath(entry.root.path);
      if (!(await stat(real)).isDirectory()) throw new Error('not a directory');
    } catch (err) {
      // Offline drive or deleted folder: keep the index, show it as offline, retry by polling.
      log.warn(`root offline: ${entry.root.path}`, err instanceof Error ? err.message : err);
      entry.real = null;
      if (this.#roots.get(rootId) === entry) this.#watch(rootId, null);
      return;
    }
    entry.real = real;
    const scanId = Date.now();
    const toProbe: { id: string; path: string }[] = [];
    const rootRow = { rel: '', parentId: null, kind: 'folder', title: basename(real) || real, size: 0, mtimeMs: 0 };
    const rootRowId = tx(this.#db, () => repo.upsert(this.#db, rootId, scanId, rootRow).id);
    await this.#walk(rootId, scanId, real, '', rootRowId, toProbe);
    if (this.#roots.get(rootId) !== entry) return; // root removed or replaced while we walked
    const moved = tx(this.#db, () => repo.reuseMovedIds(this.#db, rootId, scanId));
    const probeTargets = toProbe.flatMap((item) => {
      const replacement = moved.get(item.id);
      if (!replacement) return [item];
      return replacement.needsProbe ? [{ ...item, id: replacement.id }] : [];
    });
    const removed = repo.sweep(this.#db, rootId, scanId);
    log.info(`scanned ${entry.root.path}: ${probeTargets.length} to probe, ${removed} removed`);
    this.#watch(rootId, real);
    await this.#probeAll(probeTargets);
  }

  /** Index one folder. Returns true when it (recursively) contains media. */
  async #walk(
    rootId: string,
    scanId: number,
    abs: string,
    rel: string,
    parentId: string,
    toProbe: { id: string; path: string }[],
  ): Promise<boolean> {
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      // Unreadable right now (drive hiccup, antivirus lock): keep what we knew instead of sweeping it.
      if (rel === '') throw new Error(`root unreadable, scan aborted without changes: ${String(err)}`);
      log.warn(`cannot read ${abs}, keeping its previous index`, err instanceof Error ? err.message : err);
      return repo.keepSubtree(this.#db, rootId, rel, scanId);
    }
    const names = dirents.map((d) => d.name);
    const files: { entry: repo.Entry; abs: string }[] = [];
    const dirs: { name: string; rel: string }[] = [];
    let kept = false;
    for (const d of dirents) {
      // Symlinks and junctions are skipped: the jail would refuse anything they point outside of anyway.
      if (IGNORE_RE.test(d.name) || d.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        dirs.push({ name: d.name, rel: childRel });
        continue;
      }
      const kind = d.isFile() ? kindOf(d.name) : null;
      if (!kind) continue;
      const fileAbs = join(abs, d.name);
      let st;
      try {
        st = await stat(fileAbs);
      } catch {
        if (repo.keepSubtree(this.#db, rootId, childRel, scanId)) kept = true;
        continue;
      }
      const sidecars =
        kind === 'video' ? names.map((n) => matchSidecar(d.name, n)).filter((s): s is Sidecar => s !== null) : undefined;
      const title = kind === 'image' ? d.name : parseTitle(d.name).title;
      files.push({ entry: { rel: childRel, parentId, kind, title, size: st.size, mtimeMs: st.mtimeMs, sidecars }, abs: fileAbs });
    }
    tx(this.#db, () => {
      for (const f of files) {
        const r = repo.upsert(this.#db, rootId, scanId, f.entry);
        if (r.needsProbe) toProbe.push({ id: r.id, path: f.abs });
      }
    });
    let hasMedia = files.length > 0 || kept;
    for (const d of dirs) {
      const folder = { rel: d.rel, parentId, kind: 'folder', title: d.name, size: 0, mtimeMs: 0 };
      const id = tx(this.#db, () => repo.upsert(this.#db, rootId, scanId, folder).id);
      if (await this.#walk(rootId, scanId, join(abs, d.name), d.rel, id, toProbe)) hasMedia = true;
      else repo.unmark(this.#db, id);
    }
    return hasMedia;
  }

  async #probeAll(items: { id: string; path: string }[]): Promise<void> {
    if (!this.#ffprobe || items.length === 0) return;
    const ffprobe = this.#ffprobe;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < items.length) {
        const it = items[next++]!;
        try {
          repo.setProbe(this.#db, it.id, await probeFile(ffprobe, it.path));
        } catch (err) {
          log.warn(`probe failed, marking broken: ${it.path}`, err instanceof Error ? err.message : err);
          repo.setProbe(this.#db, it.id, null);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PROBE_WORKERS, items.length) }, worker));
  }

  #schedule(rootId: string): void {
    clearTimeout(this.#debounce.get(rootId));
    const t = setTimeout(() => {
      this.#debounce.delete(rootId);
      void this.scan(rootId);
    }, DEBOUNCE_MS);
    this.#debounce.set(rootId, t);
  }

  #watch(rootId: string, real: string | null): void {
    const isUnc = real?.startsWith('\\\\') ?? false;
    const existing = this.#watchers.get(rootId);
    // A root that was offline is being polled; once it is back on a local drive, switch to a real watch.
    if (existing?.kind === 'watch') return;
    if (existing && (!real || isUnc)) return;
    if (existing) this.#unwatch(rootId);
    if (real && !isUnc) {
      try {
        const w = watch(real, { recursive: true, persistent: false }, () => this.#schedule(rootId));
        w.on('error', (err) => {
          log.warn(`watch error on ${real}, falling back to polling`, err.message);
          this.#unwatch(rootId);
          this.#poll(rootId);
        });
        this.#watchers.set(rootId, { kind: 'watch', w });
        return;
      } catch (err) {
        log.warn(`fs.watch unavailable for ${real}, polling`, err instanceof Error ? err.message : err);
      }
    }
    this.#poll(rootId);
  }

  #poll(rootId: string): void {
    const t = setInterval(() => void this.scan(rootId), POLL_MS);
    t.unref();
    this.#watchers.set(rootId, { kind: 'poll', t });
  }

  #unwatch(rootId: string): void {
    const w = this.#watchers.get(rootId);
    if (!w) return;
    if (w.kind === 'watch') w.w.close();
    else clearInterval(w.t);
    this.#watchers.delete(rootId);
  }
}

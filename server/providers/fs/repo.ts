// fs provider's slice of the database. Rows map opaque IDs to (root, relative path).
import { randomBytes } from 'node:crypto';
import type { Database } from '../../store.ts';
import type { Probe } from '../../media.ts';

export interface Sidecar {
  file: string; // file name in the same folder
  lang?: string;
  forced: boolean;
}

export interface FsRow {
  id: string;
  root_id: string;
  rel: string;
  parent_id: string | null;
  kind: string;
  title: string;
  size: number;
  mtime_ms: number;
  probe: string | null;
  broken: number;
  added_at: number;
  sidecars: string | null;
}

export interface Entry {
  rel: string;
  parentId: string | null;
  kind: string;
  title: string;
  size: number;
  mtimeMs: number;
  sidecars?: Sidecar[];
}

function newId(): string {
  return randomBytes(9).toString('base64url');
}

export function getRow(db: Database, id: string): FsRow | undefined {
  return db.prepare('SELECT * FROM fs_items WHERE id = ?').get(id) as FsRow | undefined;
}

export function getByRel(db: Database, rootId: string, rel: string): FsRow | undefined {
  return db.prepare('SELECT * FROM fs_items WHERE root_id = ? AND rel = ?').get(rootId, rel) as FsRow | undefined;
}

export function children(db: Database, parentId: string): FsRow[] {
  return db.prepare('SELECT * FROM fs_items WHERE parent_id = ?').all(parentId) as unknown as FsRow[];
}

export function rootRows(db: Database, rootIds: readonly string[]): FsRow[] {
  if (rootIds.length === 0) return [];
  return db
    .prepare(`SELECT * FROM fs_items WHERE rel = '' AND root_id IN (${rootIds.map(() => '?').join(',')})`)
    .all(...rootIds) as unknown as FsRow[];
}

export function byIds(db: Database, ids: readonly string[]): FsRow[] {
  if (ids.length === 0) return [];
  return db.prepare(`SELECT * FROM fs_items WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as unknown as FsRow[];
}

export function recentlyAdded(db: Database, limit: number): FsRow[] {
  return db
    .prepare(`SELECT * FROM fs_items WHERE kind = 'video' AND broken = 0 ORDER BY added_at DESC, title LIMIT ?`)
    .all(limit) as unknown as FsRow[];
}

/**
 * Insert or refresh one entry for this scan. Keeps the ID forever for the same (root, rel).
 * Returns the ID and whether the file needs (re)probing.
 */
export function upsert(db: Database, rootId: string, scanId: number, e: Entry): { id: string; needsProbe: boolean } {
  const probeable = e.kind === 'video' || e.kind === 'audio';
  const sidecars = e.sidecars && e.sidecars.length ? JSON.stringify(e.sidecars) : null;
  const cur = getByRel(db, rootId, e.rel);
  if (!cur) {
    const id = newId();
    db.prepare(
      `INSERT INTO fs_items(id, root_id, rel, parent_id, kind, title, size, mtime_ms, added_at, sidecars, scan_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, rootId, e.rel, e.parentId, e.kind, e.title, e.size, e.mtimeMs, Date.now(), sidecars, scanId);
    return { id, needsProbe: probeable };
  }
  const changed = cur.size !== e.size || cur.mtime_ms !== e.mtimeMs || cur.kind !== e.kind;
  db.prepare(
    `UPDATE fs_items SET parent_id = ?, kind = ?, title = ?, size = ?, mtime_ms = ?, sidecars = ?, scan_id = ?,
       probe = CASE WHEN ? THEN NULL ELSE probe END, broken = CASE WHEN ? THEN 0 ELSE broken END
     WHERE id = ?`,
  ).run(e.parentId, e.kind, e.title, e.size, e.mtimeMs, sidecars, scanId, changed ? 1 : 0, changed ? 1 : 0, cur.id);
  return { id: cur.id, needsProbe: probeable && (changed || (cur.probe === null && cur.broken === 0)) };
}

/** Un-mark a folder that turned out to hold no media, so the sweep removes it. */
export function unmark(db: Database, id: string): void {
  db.prepare('UPDATE fs_items SET scan_id = 0 WHERE id = ?').run(id);
}

export function sweep(db: Database, rootId: string, scanId: number): number {
  return Number(db.prepare('DELETE FROM fs_items WHERE root_id = ? AND scan_id != ?').run(rootId, scanId).changes);
}

export function dropRootsExcept(db: Database, keep: readonly string[]): void {
  if (keep.length === 0) {
    db.prepare('DELETE FROM fs_items').run();
    return;
  }
  db.prepare(`DELETE FROM fs_items WHERE root_id NOT IN (${keep.map(() => '?').join(',')})`).run(...keep);
}

export function setProbe(db: Database, id: string, probe: Probe | null): void {
  db.prepare('UPDATE fs_items SET probe = ?, broken = ? WHERE id = ?').run(probe ? JSON.stringify(probe) : null, probe ? 0 : 1, id);
}

export function countItems(db: Database): { files: number; broken: number; pending: number } {
  const r = db
    .prepare(
      `SELECT SUM(kind != 'folder') AS files, SUM(broken) AS broken,
         SUM(kind IN ('video','audio') AND probe IS NULL AND broken = 0) AS pending FROM fs_items`,
    )
    .get() as { files: number | null; broken: number | null; pending: number | null };
  return { files: r.files ?? 0, broken: r.broken ?? 0, pending: r.pending ?? 0 };
}

/**
 * A folder (or file) could not be read this scan: keep its existing rows alive instead of letting
 * the sweep delete them, so a disk hiccup never re-mints IDs and loses watch history.
 * Returns true when anything was kept.
 */
export function keepSubtree(db: Database, rootId: string, rel: string, scanId: number): boolean {
  const res = db
    .prepare(`UPDATE fs_items SET scan_id = ? WHERE root_id = ? AND (rel = ? OR substr(rel, 1, length(?) + 1) = ? || '/')`)
    .run(scanId, rootId, rel, rel, rel);
  return Number(res.changes) > 0;
}

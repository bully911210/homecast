// node:sqlite store. One schema, migrated by PRAGMA user_version.
import type { DatabaseSync as DB } from 'node:sqlite';
import type { ItemState } from '../shared/types.ts';
import { CONTINUE_MIN_SECONDS, MIN_WATCH_DURATION_SECONDS, WATCHED_RATIO } from '../shared/watch.ts';
import { SCHEMA } from './schema.ts';

export type Database = DB;

// node:sqlite still prints an ExperimentalWarning on Node 24. Drop exactly that one warning.
const originalEmit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (/SQLite is an experimental feature/.test(text)) return;
  (originalEmit as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
// Loaded after the filter above (a static import would warn first) and without require(), so it also works bundled.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

export function openDb(file: string): Database {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = version; v < SCHEMA.length; v++) {
    tx(db, () => {
      db.exec(SCHEMA[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return db;
}

export function tx<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---- playback state (core, provider-agnostic) ----

interface StateRow {
  item_id: string;
  position: number;
  duration: number;
  watched: number;
  updated_at: number;
}

export function saveState(db: Database, itemId: string, s: { position: number; duration: number; watched?: boolean }): ItemState {
  const watched = s.duration >= MIN_WATCH_DURATION_SECONDS && (s.watched ?? (s.position / s.duration > WATCHED_RATIO));
  const updatedAt = Date.now();
  db.prepare(
    `INSERT INTO state(item_id, position, duration, watched, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET position = excluded.position, duration = excluded.duration,
       watched = excluded.watched, updated_at = excluded.updated_at`,
  ).run(itemId, s.position, s.duration, watched ? 1 : 0, updatedAt);
  return { position: s.position, duration: s.duration, watched, updatedAt };
}

function toState(r: StateRow): ItemState {
  return { position: r.position, duration: r.duration, watched: r.watched === 1, updatedAt: r.updated_at };
}

export function getStates(db: Database, ids: readonly string[]): Map<string, ItemState> {
  const out = new Map<string, ItemState>();
  // Chunk to stay well under SQLite's variable limit.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db.prepare(`SELECT * FROM state WHERE item_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as unknown as StateRow[];
    for (const r of rows) out.set(r.item_id, toState(r));
  }
  return out;
}

/** Most recently touched, partially watched items. */
export function inProgress(db: Database, limit: number): string[] {
  const rows = db
    .prepare('SELECT item_id FROM state WHERE watched = 0 AND position > ? AND (duration <= 0 OR position / duration < ?) ORDER BY updated_at DESC LIMIT ?')
    .all(CONTINUE_MIN_SECONDS, WATCHED_RATIO, limit) as unknown as { item_id: string }[];
  return rows.map((r) => r.item_id);
}

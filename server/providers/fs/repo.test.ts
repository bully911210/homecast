import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Database } from '../../store.ts';
import * as repo from './repo.ts';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'homecast-repo-'));
  db = openDb(join(dir, 'db.sqlite'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const entry = (rel: string, kind = 'video'): repo.Entry => ({ rel, parentId: null, kind, title: rel, size: 1, mtimeMs: 1 });

describe('fs index', () => {
  it('keeps IDs stable across scans', () => {
    const a = repo.upsert(db, 'r', 1, entry('Movies/a.mkv'));
    const b = repo.upsert(db, 'r', 2, entry('Movies/a.mkv'));
    expect(b.id).toBe(a.id);
    expect(b.needsProbe).toBe(true); // never probed yet
  });

  it('reuses an ID for one unambiguous moved file with matching size and mtime', () => {
    const old = repo.upsert(db, 'r', 1, entry('old.mkv'));
    const fresh = repo.upsert(db, 'r', 2, entry('new.mkv'));
    const moved = repo.reuseMovedIds(db, 'r', 2);
    expect(moved.get(fresh.id)).toEqual({ id: old.id, needsProbe: true });
    expect(repo.getByRel(db, 'r', 'old.mkv')).toBeUndefined();
    expect(repo.getByRel(db, 'r', 'new.mkv')?.id).toBe(old.id);
  });

  it('does not guess when multiple moved files have the same signature', () => {
    repo.upsert(db, 'r', 1, entry('old-a.mkv'));
    repo.upsert(db, 'r', 1, entry('old-b.mkv'));
    const a = repo.upsert(db, 'r', 2, entry('new-a.mkv'));
    const b = repo.upsert(db, 'r', 2, entry('new-b.mkv'));
    expect(repo.reuseMovedIds(db, 'r', 2).size).toBe(0);
    expect(repo.getByRel(db, 'r', 'new-a.mkv')?.id).toBe(a.id);
    expect(repo.getByRel(db, 'r', 'new-b.mkv')?.id).toBe(b.id);
  });

  it('retries a failed probe at most three times for unchanged media', () => {
    const first = repo.upsert(db, 'r', 1, entry('broken.mkv'));
    repo.setProbe(db, first.id, null);
    const second = repo.upsert(db, 'r', 2, entry('broken.mkv'));
    expect(second.needsProbe).toBe(true);
    repo.setProbe(db, first.id, null);
    const third = repo.upsert(db, 'r', 3, entry('broken.mkv'));
    expect(third.needsProbe).toBe(true);
    repo.setProbe(db, first.id, null);
    expect(repo.upsert(db, 'r', 4, entry('broken.mkv')).needsProbe).toBe(false);
  });

  it('an unreadable folder keeps its subtree (no sweep, no lost history)', () => {
    const kept = repo.upsert(db, 'r', 1, entry('Movies/a.mkv')).id;
    repo.upsert(db, 'r', 1, entry('Movies/Sub/b.mkv'));
    repo.upsert(db, 'r', 1, entry('Movies2/c.mkv')); // shares the prefix "Movies" but is a different folder
    // Scan 2 cannot read "Movies".
    expect(repo.keepSubtree(db, 'r', 'Movies', 2)).toBe(true);
    expect(repo.sweep(db, 'r', 2)).toBe(1); // only Movies2/c.mkv (not seen, not kept)
    expect(repo.getByRel(db, 'r', 'Movies/Sub/b.mkv')).toBeDefined();
    expect(repo.getRow(db, kept)).toBeDefined();
  });

  it('keepSubtree does not match sibling folders sharing a prefix', () => {
    repo.upsert(db, 'r', 1, entry('Show'));
    repo.upsert(db, 'r', 1, entry('Show/e1.mkv'));
    repo.upsert(db, 'r', 1, entry('Shows/e2.mkv'));
    repo.keepSubtree(db, 'r', 'Show', 2);
    expect(repo.sweep(db, 'r', 2)).toBe(1);
    expect(repo.getByRel(db, 'r', 'Shows/e2.mkv')).toBeUndefined();
  });
});

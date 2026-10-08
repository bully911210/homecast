import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Scanner } from './providers/fs/scan.ts';
import * as repo from './providers/fs/repo.ts';
import { openDb, saveState, type Database } from './store.ts';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'homecast-state-'));
  db = openDb(join(dir, 'db.sqlite'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('watch position saves', () => {
  it('ignores a stale save from the same device (late beacon after a newer save)', () => {
    saveState(db, 'fs:a', { position: 120, duration: 600, at: 2000 }, 'tv');
    const s = saveState(db, 'fs:a', { position: 60, duration: 600, at: 1000 }, 'tv');
    expect(s.position).toBe(120);
  });

  it('accepts newer saves from the same device and any save from another device', () => {
    saveState(db, 'fs:a', { position: 120, duration: 600, at: 2000 }, 'tv');
    expect(saveState(db, 'fs:a', { position: 130, duration: 600, at: 3000 }, 'tv').position).toBe(130);
    // The phone's clock may be behind the TV's: different devices are never compared.
    expect(saveState(db, 'fs:a', { position: 10, duration: 600, at: 5 }, 'phone').position).toBe(10);
  });

  it('saves without a timestamp always apply', () => {
    saveState(db, 'fs:a', { position: 120, duration: 600, at: 2000 }, 'tv');
    expect(saveState(db, 'fs:a', { position: 50, duration: 600 }, 'tv').position).toBe(50);
  });
});

describe('partial downloads', () => {
  it('indexes a file only after it has stopped changing', async () => {
    const media = join(dir, 'media');
    mkdirSync(media);
    writeFileSync(join(media, 'Copying.Now.2024.mkv'), 'x'); // mtime: just now
    const scanner = new Scanner(db, null, 400);
    await scanner.setRoots([{ id: 'r', path: media }]);
    expect(repo.getByRel(db, 'r', 'Copying.Now.2024.mkv')).toBeUndefined();
    await new Promise((r) => setTimeout(r, 900)); // the follow-up scan fires once the file settles
    await scanner.idle();
    expect(repo.getByRel(db, 'r', 'Copying.Now.2024.mkv')).toBeDefined();
    scanner.close();
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPS } from '../shared/types.ts';
import { hashToken, Pairing } from './pairing.ts';
import { openDb, type Database } from './store.ts';

let dir: string;
let db: Database;
let now: number;
let p: Pairing;
const body = (pin: string) => ({ pin, name: 'TV', caps: NO_CAPS });
const wrong = (pin: string): string => String((Number(pin) + 1) % 1_000_000).padStart(6, '0');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'homecast-pair-'));
  db = openDb(join(dir, 'db.sqlite'));
  now = 1_000_000;
  p = new Pairing(db, () => now);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('pairing', () => {
  it('pairs with the right PIN, stores only the hash, rotates the PIN', () => {
    const pin = p.pin();
    const r = p.pair('192.168.1.9', body(pin));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits
    const stored = db.prepare('SELECT token_hash FROM devices').get() as { token_hash: string };
    expect(stored.token_hash).toBe(hashToken(r.token));
    expect(JSON.stringify(db.prepare('SELECT * FROM devices').all())).not.toContain(r.token);
    expect(p.pin()).not.toBe(pin);
    expect(p.authenticate(r.token)?.name).toBe('TV');
  });

  it('rejects a wrong PIN', () => {
    expect(p.pair('192.168.1.9', body(wrong(p.pin())))).toEqual({ ok: false, status: 401 });
  });

  it('limits 5 attempts per minute per IP', () => {
    const pin = p.pin();
    for (let i = 0; i < 5; i++) expect(p.pair('192.168.1.9', body(wrong(pin))).ok).toBe(false);
    expect(p.pair('192.168.1.9', body(pin))).toEqual({ ok: false, status: 429 });
    now += 61_000;
    expect(p.pair('192.168.1.9', body(p.pin())).ok).toBe(true);
  });

  it('rotates the PIN when the global limit is hit (distributed guessing)', () => {
    const pin = p.pin();
    for (let i = 0; i < 20; i++) p.pair(`192.168.1.${i}`, body(wrong(pin)));
    expect(p.pair('192.168.1.200', body(pin))).toEqual({ ok: false, status: 429 });
    expect(p.pin()).not.toBe(pin);
  });

  it('PIN expires after 10 minutes', () => {
    const pin = p.pin();
    now += 10 * 60_000 + 1;
    expect(p.pin()).not.toBe(pin);
  });

  it('revoked tokens stop working', () => {
    const r = p.pair('192.168.1.9', body(p.pin()));
    if (!r.ok) throw new Error('pair failed');
    expect(p.revoke(r.device.id)).toBe(true);
    expect(p.authenticate(r.token)).toBeNull();
  });

  it('rejects junk tokens', () => {
    expect(p.authenticate(undefined)).toBeNull();
    expect(p.authenticate('x'.repeat(500))).toBeNull();
    expect(p.authenticate('nope')).toBeNull();
  });
});

// PIN pairing: a 6-digit PIN on the PC buys a long-lived random token. Only token hashes are stored.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { PairBody } from '../shared/guards.ts';
import { parseCaps } from '../shared/guards.ts';
import type { Device } from '../shared/types.ts';
import type { Database } from './store.ts';

export const COOKIE = 'hc_token';
const PIN_TTL_MS = 10 * 60_000;
const WINDOW_MS = 60_000;
const PER_IP = 5;
const GLOBAL = 20;

export interface DeviceInfo extends Device {
  createdAt: number;
  lastSeen: number;
}

interface DeviceRow {
  id: string;
  name: string;
  caps: string;
  created_at: number;
  last_seen: number;
}

export type PairResult = { ok: true; token: string; device: Device } | { ok: false; status: 401 | 429 };

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function rowToDevice(r: DeviceRow): DeviceInfo {
  return { id: r.id, name: r.name, caps: parseCaps(JSON.parse(r.caps)), createdAt: r.created_at, lastSeen: r.last_seen };
}

export class Pairing {
  readonly #db: Database;
  readonly #now: () => number;
  #pin = '';
  #issuedAt = 0;
  readonly #perIp = new Map<string, { n: number; start: number }>();
  #global = { n: 0, start: 0 };
  readonly #seen = new Map<string, number>();

  constructor(db: Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    this.rotate();
  }

  pin(): string {
    if (this.#now() - this.#issuedAt > PIN_TTL_MS) this.rotate();
    return this.#pin;
  }

  pinExpiresAt(): number {
    return this.#issuedAt + PIN_TTL_MS;
  }

  rotate(): void {
    this.#pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.#issuedAt = this.#now();
  }

  #limited(ip: string): boolean {
    const now = this.#now();
    if (now - this.#global.start > WINDOW_MS) this.#global = { n: 0, start: now };
    const mine = this.#perIp.get(ip);
    const cur = !mine || now - mine.start > WINDOW_MS ? { n: 0, start: now } : mine;
    cur.n++;
    this.#perIp.set(ip, cur);
    this.#global.n++;
    if (this.#perIp.size > 1000) this.#perIp.clear(); // bound memory on a hostile LAN
    if (this.#global.n > GLOBAL) {
      this.rotate(); // someone is guessing: the PIN they were guessing no longer exists
      return true;
    }
    return cur.n > PER_IP;
  }

  pair(ip: string, body: PairBody): PairResult {
    if (this.#limited(ip)) return { ok: false, status: 429 };
    const expected = Buffer.from(this.pin());
    const given = Buffer.from(body.pin);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, status: 401 };
    this.rotate();
    const token = randomBytes(32).toString('base64url');
    const id = randomBytes(8).toString('hex');
    const now = this.#now();
    this.#db
      .prepare('INSERT INTO devices(id, name, token_hash, caps, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, body.name, hashToken(token), JSON.stringify(body.caps), now, now);
    return { ok: true, token, device: { id, name: body.name, caps: body.caps } };
  }

  authenticate(token: string | undefined): Device | null {
    if (!token || token.length > 128) return null;
    const row = this.#db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(hashToken(token)) as DeviceRow | undefined;
    if (!row) return null;
    const now = this.#now();
    if (now - (this.#seen.get(row.id) ?? 0) > 60_000) {
      this.#seen.set(row.id, now);
      this.#db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(now, row.id);
    }
    const d = rowToDevice(row);
    return { id: d.id, name: d.name, caps: d.caps };
  }

  /** Paired devices re-report caps on every launch (browsers update). */
  updateCaps(id: string, caps: Device['caps']): void {
    this.#db.prepare('UPDATE devices SET caps = ? WHERE id = ?').run(JSON.stringify(caps), id);
  }

  devices(): DeviceInfo[] {
    return (this.#db.prepare('SELECT * FROM devices ORDER BY last_seen DESC').all() as unknown as DeviceRow[]).map(rowToDevice);
  }

  revoke(id: string): boolean {
    return Number(this.#db.prepare('DELETE FROM devices WHERE id = ?').run(id).changes) > 0;
  }
}

// Hand-written input guards. Only a handful of request bodies exist, so no schema library.
import type { Caps } from './types.ts';

export const ITEM_ID_RE = /^[a-z][a-z0-9]{0,15}:[A-Za-z0-9_-]{1,64}$/;

export function isItemId(v: unknown): v is string {
  return typeof v === 'string' && ITEM_ID_RE.test(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNonNeg(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e7;
}

export interface StateBody {
  position: number;
  duration: number;
  watched?: boolean;
}

export function parseStateBody(v: unknown): StateBody | null {
  if (!isObject(v) || !isFiniteNonNeg(v.position)) return null;
  const duration = v.duration === undefined ? 0 : v.duration;
  if (!isFiniteNonNeg(duration)) return null;
  if (v.watched !== undefined && typeof v.watched !== 'boolean') return null;
  return { position: duration > 0 ? Math.min(v.position, duration) : v.position, duration, watched: v.watched };
}

const CAP_KEYS = ['h264', 'hevc', 'vp9', 'av1', 'hls'] as const;

export function parseCaps(v: unknown): Caps {
  const src = isObject(v) ? v : {};
  const out = {} as Caps;
  for (const k of CAP_KEYS) out[k] = src[k] === true;
  return out;
}

export interface PairBody {
  pin: string;
  name: string;
  caps: Caps;
}

export function parsePairBody(v: unknown): PairBody | null {
  if (!isObject(v) || typeof v.pin !== 'string' || !/^\d{6}$/.test(v.pin)) return null;
  const rawName = typeof v.name === 'string' ? v.name : '';
  // Strip control characters; device names show up in the admin page.
  const name = rawName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || 'TV';
  return { pin: v.pin, name, caps: parseCaps(v.caps) };
}

export function parseRootBody(v: unknown): { path: string } | null {
  if (!isObject(v) || typeof v.path !== 'string') return null;
  const path = v.path.trim();
  if (path.length === 0 || path.length > 1024 || path.includes('\0')) return null;
  return { path };
}

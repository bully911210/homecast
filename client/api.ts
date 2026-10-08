// The four item routes plus pairing. Same-origin fetches; the httpOnly cookie rides along.
import type { Caps, Item } from '../shared/types.ts';
import type { ErrorCode } from '../shared/errors.ts';

export class NotPaired extends Error {}

const ERROR_MESSAGES: Partial<Record<ErrorCode, string>> = {
  MEDIA_NOT_FOUND: 'This item is no longer available.',
  MEDIA_UNREADABLE: 'This file is damaged or cannot be read.',
  UNSUPPORTED_MEDIA: 'This media format is not supported.',
  NO_PLAYBACK_PATH: 'This TV and PC have no compatible playback option.',
  TRANSCODER_UNAVAILABLE: 'This file needs conversion, but ffmpeg is unavailable.',
  TRANSCODER_FAILED: 'The PC could not convert this file.',
  DEVICE_UNSUPPORTED: 'This TV cannot play this file.',
  AUTH_REQUIRED: 'This TV is no longer paired. Go back and pair again.',
  PAIRING_REQUIRED: 'This TV is no longer paired. Go back and pair again.',
  NETWORK_ERROR: 'Cannot reach the PC.',
};

export function messageForError(code?: ErrorCode): string | undefined {
  return code ? ERROR_MESSAGES[code] : undefined;
}

async function json<T>(res: Response): Promise<T> {
  if (res.status === 401) throw new NotPaired('not paired');
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; code?: ErrorCode };
  if (!res.ok) throw new Error(messageForError(body.code) ?? body.error ?? `HTTP ${res.status}`);
  return body;
}

export async function listItems(parent?: string): Promise<Item[]> {
  const q = parent ? `?parent=${encodeURIComponent(parent)}` : '';
  return (await json<{ items: Item[] }>(await fetch(`/api/items${q}`, { credentials: 'same-origin' }))).items;
}

export async function saveState(id: string, position: number, duration: number): Promise<void> {
  await fetch(`/api/state/${encodeURIComponent(id)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position: Math.max(0, position), duration: Math.max(0, duration), at: Date.now() }),
    keepalive: true,
  }).catch(() => undefined); // best effort: playback must not stop because a save failed
}

export function beaconState(id: string, position: number, duration: number): void {
  const body = JSON.stringify({ position: Math.max(0, position), duration: Math.max(0, duration), at: Date.now() });
  const blob = new Blob([body], { type: 'application/json' });
  if (!navigator.sendBeacon(`/api/state/${encodeURIComponent(id)}`, blob)) {
    void fetch(`/api/state/${encodeURIComponent(id)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  }
}

export async function pair(pin: string, caps: Caps): Promise<void> {
  const res = await fetch('/pair', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin, caps, name: deviceName() }),
  });
  await json<{ ok: boolean }>(res);
}

/** Paired devices re-report their codec support on every launch. */
export function reportCaps(caps: Caps): void {
  fetch('/pair', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caps }),
  }).catch(() => undefined);
}

export function openUrl(id: string, params: Record<string, string | number | undefined> = {}): string {
  const q = Object.keys(params)
    .filter((k) => params[k] !== undefined)
    .map((k) => `${k}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
  return `/api/open/${encodeURIComponent(id)}${q ? `?${q}` : ''}`;
}

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/Tizen/i.test(ua)) return 'Samsung TV';
  if (/Web0S|webOS/i.test(ua)) return 'LG TV';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android TV';
  if (/iPhone|iPad/i.test(ua)) return 'iPhone/iPad';
  if (/CrKey/i.test(ua)) return 'Chromecast';
  return 'Browser';
}

export function detectCaps(): Caps {
  const v = document.createElement('video');
  const can = (t: string): boolean => v.canPlayType(t) !== '';
  // Converted video goes through MSE (hls.js) where it exists, so MSE has to agree as well.
  const ms = (window as { MediaSource?: { isTypeSupported(t: string): boolean } }).MediaSource;
  const mse = (t: string): boolean => !ms || ms.isTypeSupported(t);
  const hevc = 'video/mp4; codecs="hvc1.1.6.L120.90"';
  return {
    h264: can('video/mp4; codecs="avc1.640028"'),
    hevc: (can(hevc) || can('video/mp4; codecs="hev1.1.6.L120.90"')) && mse(hevc),
    vp9: can('video/webm; codecs="vp9"'),
    av1: can('video/mp4; codecs="av01.0.08M.08"'),
    hls: can('application/vnd.apple.mpegurl'),
  };
}

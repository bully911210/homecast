// Spatial navigation + pointer layer. One focus ring, one source of truth:
// arrows move focus to the nearest [data-nav] element in that direction, hover calls the same focus(),
// and activation is always a native click (Enter on a focused <button> fires click too).

export type Dir = 'left' | 'right' | 'up' | 'down';

const KEY_DIR: Record<string, Dir> = {
  ArrowLeft: 'left', Left: 'left', ArrowRight: 'right', Right: 'right',
  ArrowUp: 'up', Up: 'up', ArrowDown: 'down', Down: 'down',
};
const KEYCODE_DIR: Record<number, Dir> = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };
// Backspace, Escape, XF86Back / BrowserBack, Tizen 10009, webOS 461.
const BACK_KEYS = new Set(['Backspace', 'Escape', 'Esc', 'XF86Back', 'BrowserBack', 'GoBack']);
const BACK_CODES = new Set([8, 27, 10009, 461, 166]);

export function keyDir(e: KeyboardEvent): Dir | null {
  return KEY_DIR[e.key] ?? KEYCODE_DIR[e.keyCode] ?? null;
}

export function isBackKey(e: KeyboardEvent): boolean {
  return BACK_KEYS.has(e.key) || BACK_CODES.has(e.keyCode);
}

export function isEnterKey(e: KeyboardEvent): boolean {
  return e.key === 'Enter' || e.keyCode === 13;
}

let current: HTMLElement | null = null;

export function focused(): HTMLElement | null {
  return current && current.isConnected ? current : null;
}

export function focus(el: HTMLElement | null, scroll = true): void {
  if (!el) return;
  if (current && current !== el) current.classList.remove('focused');
  current = el;
  el.classList.add('focused');
  el.focus({ preventScroll: true });
  if (scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Candidates inside the topmost active layer only (a modal or the player shadows the grid). */
function candidates(): HTMLElement[] {
  const layers = document.querySelectorAll<HTMLElement>('[data-layer]:not([hidden])');
  const scope = layers.length ? layers[layers.length - 1]! : document.body;
  return Array.from(scope.querySelectorAll<HTMLElement>('[data-nav]')).filter((el) => {
    if ((el as HTMLButtonElement).disabled) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

interface Pt {
  x: number;
  y: number;
}

function center(r: DOMRect): Pt {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * Nearest element in direction `dir` from rect `from`. Distance along the axis counts once,
 * drift across it counts three times, so moving "down" prefers the tile straight below.
 */
export function nearest(from: DOMRect, dir: Dir, all: { el: HTMLElement; r: DOMRect }[]): HTMLElement | null {
  // Prefer targets that overlap on the cross axis (same row for left/right, same column for up/down).
  const horizontal = dir === 'left' || dir === 'right';
  const overlapping = all.filter(({ r }) => (horizontal ? r.bottom > from.top && r.top < from.bottom : r.right > from.left && r.left < from.right));
  // Left/right never leave the row; up/down may drift to the nearest thing above/below.
  return horizontal ? pick(from, dir, overlapping) : (pick(from, dir, overlapping) ?? pick(from, dir, all));
}

function pick(from: DOMRect, dir: Dir, rects: { el: HTMLElement; r: DOMRect }[]): HTMLElement | null {
  const a = center(from);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const { el, r } of rects) {
    const b = center(r);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let main: number;
    let cross: number;
    switch (dir) {
      case 'left':
        if (r.right > from.left + 1 || dx >= 0) continue;
        main = -dx;
        cross = Math.abs(dy);
        break;
      case 'right':
        if (r.left < from.right - 1 || dx <= 0) continue;
        main = dx;
        cross = Math.abs(dy);
        break;
      case 'up':
        if (r.bottom > from.top + 1 || dy >= 0) continue;
        main = -dy;
        cross = Math.abs(dx);
        break;
      case 'down':
        if (r.top < from.bottom - 1 || dy <= 0) continue;
        main = dy;
        cross = Math.abs(dx);
        break;
    }
    const score = main + cross * 3;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/** Move focus. Returns false when nothing lies in that direction (callers may use the key otherwise). */
export function move(dir: Dir): boolean {
  const els = candidates();
  const cur = focused();
  if (!cur || els.indexOf(cur) === -1) {
    focus(els[0] ?? null);
    return els.length > 0;
  }
  const next = nearest(
    cur.getBoundingClientRect(),
    dir,
    els.filter((e) => e !== cur).map((el) => ({ el, r: el.getBoundingClientRect() })),
  );
  if (next) focus(next);
  return next !== null;
}

/** Focus the first candidate in the active layer (or a preferred element if it is still there). */
export function focusFirst(prefer?: HTMLElement | null): void {
  if (prefer && prefer.isConnected) return focus(prefer);
  focus(candidates()[0] ?? null);
}

/**
 * Hover = focus, but only when the pointer really moves. Browsers also fire hover events when
 * content scrolls under a parked cursor (arrow keys scroll the grid), which must not steal focus
 * from the remote. Delegated, so new tiles need no wiring.
 */
export function installPointer(): void {
  let lastX = -1;
  let lastY = -1;
  document.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'touch' || (e.clientX === lastX && e.clientY === lastY)) return;
      lastX = e.clientX;
      lastY = e.clientY;
      const el = (e.target as Element | null)?.closest?.('[data-nav]') as HTMLElement | null;
      if (el && el !== current) focus(el, false);
    },
    true,
  );
}

/** Hide the cursor after 3 s without movement; show it again on move. */
export function installIdleCursor(ms = 3000): void {
  let t = 0;
  const wake = (): void => {
    document.body.classList.remove('idle');
    clearTimeout(t);
    t = window.setTimeout(() => document.body.classList.add('idle'), ms);
  };
  document.addEventListener('pointermove', wake, true);
  document.addEventListener('pointerdown', wake, true);
  wake();
}

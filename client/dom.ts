// A tiny element helper. No framework: the UI is one grid and a few players.

type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return hh > 0 ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
}

/** Auto-hide helper: show() now, hide after `ms` idle unless `keep()` says otherwise. */
export function idleHider(el: HTMLElement, ms: number, keep: () => boolean): { poke: () => void; stop: () => void } {
  let t = 0;
  const hide = (): void => {
    if (keep()) return poke();
    el.classList.add('hide');
  };
  const poke = (): void => {
    el.classList.remove('hide');
    clearTimeout(t);
    t = window.setTimeout(hide, ms);
  };
  return { poke, stop: () => clearTimeout(t) };
}

// Inline SVG icons and the HomeCast mark. Built with createElementNS, so no markup strings.
const NS = 'http://www.w3.org/2000/svg';

function svg(viewBox: string, cls: string, children: SVGElement[]): SVGSVGElement {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  for (const c of children) s.appendChild(c);
  return s;
}

function el(tag: string, attrs: Record<string, string>): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]!);
  return e;
}

const PATHS: Record<string, string[]> = {
  folder: ['M3 6.5A2.5 2.5 0 0 1 5.5 4h4.2l2.3 2.5h6.5A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z'],
  video: ['M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5z', 'M10 8.5v7l5.5-3.5z'],
  audio: ['M9 17.5V6l11-2v11.5', 'M9 17.5a3 3 0 1 1-3-3 3 3 0 0 1 3 3z', 'M20 15.5a3 3 0 1 1-3-3 3 3 0 0 1 3 3z'],
  image: ['M3.5 5.5A2.5 2.5 0 0 1 6 3h12a2.5 2.5 0 0 1 2.5 2.5v13A2.5 2.5 0 0 1 18 21H6a2.5 2.5 0 0 1-2.5-2.5z', 'M3.5 16l5-5 4 4 2.5-2.5 5 5', 'M15.5 8.5a1.5 1.5 0 1 1-1.5-1.5 1.5 1.5 0 0 1 1.5 1.5z'],
  play: ['M7 4.5v15l12.5-7.5z'],
  pause: ['M6.5 4.5h4v15h-4z', 'M13.5 4.5h4v15h-4z'],
  subtitles: ['M3.5 6.5A2.5 2.5 0 0 1 6 4h12a2.5 2.5 0 0 1 2.5 2.5v11A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5z', 'M7 15h4', 'M13 15h4', 'M7 11.5h10'],
  prev: ['M11 7l-5 5 5 5', 'M18 7l-5 5 5 5'],
  next: ['M13 7l5 5-5 5', 'M6 7l5 5-5 5'],
  back: ['M15 5l-7 7 7 7'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
};

/** A line icon by name (folder, video, audio, image, play, pause, subtitles, prev, next, back, refresh). */
export function icon(name: string, cls = 'ico'): SVGSVGElement {
  const filled = name === 'play' || name === 'pause';
  const paths = (PATHS[name] ?? PATHS.video!).map((d) =>
    el('path', filled ? { d, fill: 'currentColor' } : { d, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
  );
  return svg('0 0 24 24', cls, paths);
}

let gradientId = 0;
/** The HomeCast mark: an amber tile with a house whose door is a play button. */
export function mark(cls = 'mark'): SVGSVGElement {
  const id = `hc-g${gradientId++}`;
  const grad = el('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '1' });
  grad.appendChild(el('stop', { offset: '0', 'stop-color': '#FFC83D' }));
  grad.appendChild(el('stop', { offset: '1', 'stop-color': '#FF7A1A' }));
  const defs = el('defs', {});
  defs.appendChild(grad);
  return svg('0 0 64 64', cls, [
    defs,
    el('rect', { width: '64', height: '64', rx: '15', fill: `url(#${id})` }),
    el('path', { d: 'M13 31.5 32 15l19 16.5V47a4 4 0 0 1-4 4H17a4 4 0 0 1-4-4z', fill: '#0E1116' }),
    el('path', { d: 'M28.5 28.5 40 36l-11.5 7.5z', fill: '#FFC83D' }),
  ]);
}

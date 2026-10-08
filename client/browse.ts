// The one browse screen: a top bar, optional rows (Continue Watching, Recently Added), and a grid of tiles.
import type { Item } from '../shared/types.ts';
import { listItems } from './api.ts';
import { clear, fmtTime, h } from './dom.ts';
import { focus, focusFirst } from './nav.ts';

export interface BrowseHandlers {
  open: (item: Item, siblings: Item[]) => void;
  back: () => void;
  refresh: () => void;
}

const CHUNK = 60;
const ICON: Record<string, string> = { folder: '📁', video: '🎬', audio: '🎵', image: '🖼️', app: '▶' };

let thumbObserver: IntersectionObserver | null = null;
function lazyThumb(img: HTMLImageElement): void {
  if (!('IntersectionObserver' in window)) {
    img.src = img.getAttribute('data-src')!;
    return;
  }
  thumbObserver =
    thumbObserver ??
    new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLImageElement;
          el.src = el.getAttribute('data-src')!;
          thumbObserver!.unobserve(el);
        }
      },
      { rootMargin: '400px' },
    );
  thumbObserver.observe(img);
}

function subtitle(it: Item): string {
  const m = it.meta ?? {};
  if (m.broken) return 'Cannot be played';
  if (m.offline) return 'Offline';
  if (it.kind === 'video' && typeof m.duration === 'number' && m.duration > 0) return fmtTime(m.duration);
  return '';
}

export function tile(it: Item, onClick: () => void): HTMLButtonElement {
  const m = it.meta ?? {};
  const thumb = h('div', { class: 'thumb' }, h('span', { class: 'icon', text: ICON[it.kind] ?? '•' }));
  if (it.thumb) {
    const img = h('img', { 'data-src': it.thumb, alt: '' });
    img.addEventListener('load', () => thumb.classList.add('has-img'));
    img.addEventListener('error', () => img.remove());
    thumb.appendChild(img);
    lazyThumb(img);
  }
  const pos = typeof m.position === 'number' ? m.position : 0;
  const dur = typeof m.duration === 'number' ? m.duration : 0;
  if (m.watched) thumb.appendChild(h('span', { class: 'badge', text: '✓' }));
  else if (pos > 0 && dur > 0) thumb.appendChild(h('div', { class: 'bar' }, h('i', { style: `width:${Math.min(100, (pos / dur) * 100).toFixed(1)}%` })));
  const btn = h(
    'button',
    { class: `tile kind-${it.kind}${m.broken ? ' broken' : ''}`, 'data-nav': true, 'data-id': it.id, type: 'button' },
    thumb,
    h('div', { class: 'title', text: it.title }),
    h('div', { class: 'sub', text: subtitle(it) }),
  );
  btn.addEventListener('click', onClick);
  return btn;
}

/** Render tiles in chunks: the first CHUNK now, more as the sentinel scrolls into view. */
function fillGrid(grid: HTMLElement, items: Item[], h_: BrowseHandlers): void {
  let shown = 0;
  const more = (): void => {
    const end = Math.min(items.length, shown + CHUNK);
    for (; shown < end; shown++) {
      const it = items[shown]!;
      grid.appendChild(tile(it, () => h_.open(it, items)));
    }
    if (shown < items.length) {
      const sentinel = h('div', { class: 'sentinel' });
      grid.appendChild(sentinel);
      const io = new IntersectionObserver((es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        io.disconnect();
        sentinel.remove();
        more();
      });
      io.observe(sentinel);
    }
  };
  more();
}

export interface Crumb {
  parentId?: string;
  title: string;
}

/** Render a browse screen into `root`. Restores focus to `focusId` when given. */
export async function renderBrowse(root: HTMLElement, path: Crumb[], handlers: BrowseHandlers, focusId?: string): Promise<void> {
  const here = path[path.length - 1]!;
  const items = await listItems(here.parentId);
  const atRoot = path.length === 1;

  clear(root);
  const bar = h(
    'header',
    { class: 'topbar' },
    atRoot ? null : h('button', { class: 'btn back', 'data-nav': true, type: 'button', 'aria-label': 'Back', onclick: () => handlers.back() }, '← Back'),
    h('div', { class: 'crumbs', text: path.map((c) => c.title).join(' › ') }),
    h('button', { class: 'btn icon-btn', 'data-nav': true, type: 'button', 'aria-label': 'Refresh', onclick: () => handlers.refresh() }, '⟳'),
  );
  const main = h('main', { class: 'scroll' });
  root.appendChild(bar);
  root.appendChild(main);

  const rows = atRoot ? items.filter((i) => i.meta?.row) : [];
  const rest = items.filter((i) => rows.indexOf(i) === -1);
  for (const r of rows) {
    const children = await listItems(r.id).catch(() => [] as Item[]);
    if (children.length === 0) continue;
    const row = h('div', { class: 'row' });
    for (const c of children) row.appendChild(tile(c, () => handlers.open(c, children)));
    main.appendChild(h('section', {}, h('h2', { text: r.title }), row));
  }
  if (rest.length) {
    const grid = h('div', { class: 'grid' });
    main.appendChild(h('section', {}, atRoot && rows.length ? h('h2', { text: 'Folders' }) : null, grid));
    fillGrid(grid, rest, handlers);
  }
  if (!items.length) {
    main.appendChild(
      h('p', { class: 'empty', text: atRoot ? 'Nothing shared yet. On the PC, open the HomeCast admin page and add a folder.' : 'This folder is empty.' }),
    );
  }
  const prefer = focusId ? (root.querySelector(`[data-id="${CSS.escape(focusId)}"]`) as HTMLElement | null) : null;
  if (prefer) focus(prefer);
  else focusFirst(root.querySelector<HTMLElement>('main [data-nav]'));
}

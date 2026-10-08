// The one browse screen: a top bar, a hero on the home screen, rows (Continue Watching,
// Recently Added) and a grid of tiles.
import { mediaMeta, type Item } from '../shared/types.ts';
import { PLAY_AGAIN_RATIO } from '../shared/watch.ts';
import { listItems } from './api.ts';
import { clear, fmtTime, h } from './dom.ts';
import { icon, mark } from './icons.ts';
import { focus, focusFirst } from './nav.ts';

export interface BrowseHandlers {
  open: (item: Item, siblings: Item[]) => void;
  back: () => void;
  refresh: () => void;
}

const CHUNK = 60;

let thumbObserver: IntersectionObserver | null = null;
function lazyImg(img: HTMLImageElement): void {
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

/** "Big Buck Bunny (2008)" -> "Big Buck Bunny" when the year is shown separately. */
export function displayTitle(it: Item): string {
  const year = mediaMeta(it)?.year;
  return year !== undefined ? it.title.replace(new RegExp(`\\s*\\(${year}\\)$`), '') : it.title;
}

/** "2008 · 9:56" for films, "Offline" or "Can't be played" when that matters more. */
export function subtitle(it: Item): string {
  const m = it.meta ?? {};
  const media = mediaMeta(it);
  if (m.broken) return "Can't be played";
  if (m.offline) return 'Offline';
  const parts: string[] = [];
  if (media?.season !== undefined && media.episode !== undefined) parts.push(`S${String(media.season).padStart(2, '0')}E${String(media.episode).padStart(2, '0')}`);
  if (media?.year !== undefined) parts.push(String(media.year));
  if (media && media.duration !== undefined && media.duration > 0) parts.push(fmtTime(media.duration));
  if (it.kind === 'folder') parts.push('Folder');
  return parts.join(' · ');
}

function progressOf(it: Item): number {
  const m = mediaMeta(it);
  const pos = m?.position ?? 0;
  const dur = m?.duration ?? 0;
  return pos > 0 && dur > 0 ? Math.min(1, pos / dur) : 0;
}

export function primaryActionLabel(it: Item): 'Play' | 'Resume' | 'Play again' {
  const p = progressOf(it);
  return mediaMeta(it)?.watched === true || p >= PLAY_AGAIN_RATIO ? 'Play again' : p > 0 ? 'Resume' : 'Play';
}

function primaryActionItem(it: Item): Item {
  return primaryActionLabel(it) === 'Play again' ? { ...it, meta: { ...it.meta, position: 0, watched: true } } : it;
}

export function tile(it: Item, onClick: () => void): HTMLButtonElement {
  const m = it.meta ?? {};
  const thumb = h('div', { class: 'thumb' }, icon(it.kind === 'folder' && m.root ? 'folder' : it.kind, 'ico kind'));
  if (it.thumb) {
    const img = h('img', { 'data-src': it.thumb, alt: '' });
    img.addEventListener('load', () => thumb.classList.add('has-img'));
    img.addEventListener('error', () => img.remove());
    thumb.appendChild(img);
    lazyImg(img);
  }
  const p = progressOf(it);
  if (m.watched) thumb.appendChild(h('span', { class: 'badge', text: '✓' }));
  else if (p > 0) thumb.appendChild(h('div', { class: 'bar' }, h('i', { style: `width:${(p * 100).toFixed(1)}%` })));
  const btn = h(
    'button',
    { class: `tile kind-${it.kind}${m.broken ? ' broken' : ''}`, 'data-nav': true, 'data-id': it.id, type: 'button' },
    thumb,
    h('div', { class: 'title', text: displayTitle(it) }),
    h('div', { class: 'sub', text: subtitle(it) }),
  );
  btn.addEventListener('click', onClick);
  return btn;
}

/** Big backdrop for the first title on the home screen, with one Play or Resume button. */
function hero(it: Item, eyebrow: string, onPlay: () => void): HTMLElement {
  const p = progressOf(it);
  const backdrop = h('div', { class: 'backdrop' });
  if (it.thumb) {
    const img = h('img', { src: `${it.thumb}&size=l`, alt: '' });
    img.addEventListener('load', () => backdrop.classList.add('has-img'));
    backdrop.appendChild(img);
  }
  const label = primaryActionLabel(it);
  const play = h('button', { class: 'btn primary', 'data-nav': true, 'data-id': `hero:${it.id}`, type: 'button' }, icon('play', 'ico'), ` ${label}`);
  play.addEventListener('click', onPlay);
  return h(
    'section',
    { class: 'hero' },
    backdrop,
    h(
      'div',
      { class: 'hero-text' },
      h('div', { class: 'eyebrow', text: eyebrow }),
      h('h1', { text: displayTitle(it) }),
      h('div', { class: 'meta', text: subtitle(it) }),
      p > 0 ? h('div', { class: 'hero-bar' }, h('i', { style: `width:${(p * 100).toFixed(1)}%` })) : null,
      h('div', { class: 'actions' }, play),
    ),
  );
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

let clockTimer = 0;
function clock(): HTMLElement {
  const el = h('div', { class: 'clock-top' });
  const tick = (): void => {
    const d = new Date();
    el.textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  tick();
  clearInterval(clockTimer);
  clockTimer = window.setInterval(tick, 20_000);
  return el;
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
  const rows = atRoot ? items.filter((i) => i.meta?.row) : [];
  const rest = items.filter((i) => rows.indexOf(i) === -1);
  const rowItems: { row: Item; children: Item[] }[] = [];
  const rowChildren = await Promise.all(rows.map((r) => listItems(r.id).catch(() => [] as Item[])));
  for (const [index, r] of rows.entries()) {
    const children = rowChildren[index]!;
    if (children.length) rowItems.push({ row: r, children });
  }

  clear(root);
  const brand = h('div', { class: 'brand' }, mark('mark'), h('span', { class: 'word' }, 'Home', h('b', { text: 'Cast' })));
  const trail: HTMLElement[] = [];
  path.slice(1).forEach((c, i, a) => {
    if (i > 0) trail.push(h('i', { text: ' › ' }));
    trail.push(h('span', { class: i === a.length - 1 ? 'here' : '', text: c.title }));
  });
  const crumbs = atRoot ? brand : h('div', { class: 'crumbs' }, ...trail);
  const bar = h(
    'header',
    { class: atRoot && rowItems.length ? 'topbar over-hero' : 'topbar' },
    atRoot ? null : h('button', { class: 'btn back', 'data-nav': true, type: 'button', 'aria-label': 'Back', onclick: () => handlers.back() }, icon('back', 'ico'), ' Back'),
    crumbs,
    clock(),
    h('button', { class: 'btn icon-btn', 'data-nav': true, type: 'button', 'aria-label': 'Refresh', onclick: () => handlers.refresh() }, icon('refresh', 'ico')),
  );
  const main = h('main', { class: 'scroll' });
  root.appendChild(bar);
  root.appendChild(main);

  const first = rowItems[0];
  if (first) {
    const it = first.children[0]!;
    main.appendChild(hero(it, first.row.title, () => handlers.open(primaryActionItem(it), first.children)));
  }
  for (const { row: r, children } of rowItems) {
    const row = h('div', { class: 'row' });
    for (const c of children) row.appendChild(tile(c, () => handlers.open(c, children)));
    main.appendChild(h('section', { class: 'shelf' }, h('h2', { text: r.title }), row));
  }
  if (rest.length) {
    const grid = h('div', { class: 'grid' });
    main.appendChild(h('section', { class: 'shelf' }, atRoot && rowItems.length ? h('h2', { text: 'Library' }) : null, grid));
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

// Image player: full screen, ←/→ for previous/next photo in the folder, Back to return.
import type { Item } from '../shared/types.ts';
import { openUrl } from './api.ts';
import { h, idleHider } from './dom.ts';
import { icon } from './icons.ts';
import { focus, isBackKey, isEnterKey, keyDir, move } from './nav.ts';

export function viewImage(start: Item, siblings: Item[], host: HTMLElement, onClose: (last: Item) => void): () => void {
  const photos = siblings.filter((s) => s.kind === 'image');
  let i = Math.max(0, photos.findIndex((p) => p.id === start.id));
  const img = h('img', { class: 'photo', alt: '' });
  const title = h('div', { class: 'otitle' });
  const prev = h('button', { class: 'btn ctl', 'data-nav': true, type: 'button', 'aria-label': 'Previous' }, icon('prev'), ' Previous');
  const next = h('button', { class: 'btn ctl', 'data-nav': true, type: 'button', 'aria-label': 'Next' }, 'Next ', icon('next'));
  const closeBtn = h('button', { class: 'btn ctl', 'data-nav': true, type: 'button', 'aria-label': 'Back' }, icon('back'), ' Back');
  const overlay = h('div', { class: 'overlay' }, h('div', { class: 'otop' }, closeBtn, title), h('div', { class: 'obottom' }, h('div', { class: 'ctls' }, prev, next)));
  const layer = h('div', { class: 'player kind-image', 'data-layer': true }, img, overlay);
  host.appendChild(layer);
  const ui = idleHider(overlay, 3000, () => false);

  const show = (): void => {
    const p = photos[i]!;
    img.src = openUrl(p.id);
    title.textContent = `${p.title}  (${i + 1}/${photos.length})`;
    ui.poke();
  };
  const step = (d: number): void => {
    i = (i + d + photos.length) % photos.length;
    show();
  };

  function onKey(e: KeyboardEvent): void {
    ui.poke();
    const d = keyDir(e);
    if (isBackKey(e)) {
      e.preventDefault();
      close();
    } else if (d === 'left' || d === 'right') {
      e.preventDefault();
      if (overlay.contains(document.activeElement) && document.activeElement !== prev && document.activeElement !== next) move(d);
      else step(d === 'left' ? -1 : 1);
    } else if (d) {
      e.preventDefault();
      move(d);
    } else if (isEnterKey(e) && !overlay.contains(document.activeElement)) {
      e.preventDefault();
      step(1);
    }
  }

  function close(): void {
    document.removeEventListener('keydown', onKey, true);
    ui.stop();
    layer.remove();
    onClose(photos[i]!);
  }

  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  closeBtn.addEventListener('click', close);
  img.addEventListener('click', () => step(1));
  layer.addEventListener('pointermove', ui.poke);
  document.addEventListener('keydown', onKey, true);
  show();
  focus(next, false);
  return close;
}

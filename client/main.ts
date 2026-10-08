// Boot: pair if needed, then the browse screen. One back() for the remote key, the on-screen button
// and the browser's own back (history), so every input reaches the same code path.
import type { Item } from '../shared/types.ts';
import { detectCaps, NotPaired, reportCaps } from './api.ts';
import { renderBrowse, type Crumb } from './browse.ts';
import { h } from './dom.ts';
import { installIdleCursor, installPointer, isBackKey, keyDir, move } from './nav.ts';
import { renderPair } from './pairscreen.ts';
import { playMedia } from './player.ts';
import { viewImage } from './viewer.ts';

const app = document.getElementById('app')!;
const screen = h('div', { class: 'screen' });
app.appendChild(screen);

const path: Crumb[] = [{ title: 'HomeCast' }];
const focusStack: (string | undefined)[] = [];
let closePlayer: (() => void) | null = null;
let busy = false;
let selfClosed = false; // the player closed itself and is popping its own history entry

function showError(err: unknown): void {
  if (err instanceof NotPaired) return renderPair(screen, () => void show());
  screen.appendChild(h('p', { class: 'empty', text: `Cannot reach the PC: ${err instanceof Error ? err.message : String(err)}` }));
}

async function show(focusId?: string): Promise<void> {
  busy = true;
  screen.removeAttribute('data-ready');
  try {
    await renderBrowse(screen, path, { open, back: () => history.back(), refresh: () => void show() }, focusId);
  } catch (err) {
    showError(err);
  } finally {
    busy = false;
    screen.setAttribute('data-ready', '');
  }
}

function open(item: Item, siblings: Item[]): void {
  if (item.meta?.broken) return;
  focusStack.push(item.id);
  history.pushState({ depth: path.length + (item.kind === 'folder' ? 1 : 0), player: item.kind !== 'folder' }, '');
  if (item.kind === 'folder') {
    path.push({ parentId: item.id, title: item.title });
    void show();
    return;
  }
  const done = (): void => {
    closePlayer = null;
    // Closed from inside the player (Back button, end of file): drop our history entry too.
    if ((history.state as { player?: boolean } | null)?.player) {
      selfClosed = true;
      history.back();
    }
  };
  if (item.kind === 'image') closePlayer = viewImage(item, siblings, app, () => done());
  else closePlayer = playMedia(item, app, () => done());
}

// The single back path. Remote key, on-screen button and browser back all end up here.
window.addEventListener('popstate', () => {
  if (selfClosed) {
    selfClosed = false;
    void show(focusStack.pop());
    return;
  }
  if (closePlayer) {
    const c = closePlayer;
    closePlayer = null;
    c();
    void show(focusStack.pop());
    return;
  }
  if (path.length > 1) {
    path.pop();
    void show(focusStack.pop());
  }
});

document.addEventListener('keydown', (e) => {
  if (closePlayer || e.defaultPrevented) return; // players own the keyboard while open
  if (isBackKey(e)) {
    const typing = (e.target as HTMLElement | null)?.tagName === 'INPUT';
    if (typing && e.key === 'Backspace') return;
    e.preventDefault();
    if (path.length > 1 && !busy) history.back();
    return;
  }
  const d = keyDir(e);
  if (d) {
    e.preventDefault();
    if (!busy) move(d); // presses during a render would land on tiles that are about to vanish
  }
});

installPointer();
installIdleCursor();
history.replaceState({ depth: 1 }, '');
void show().then(() => {
  if (path.length === 1 && screen.querySelector('.topbar')) reportCaps(detectCaps());
});

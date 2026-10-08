// First-run pairing: type the 6-digit PIN shown on the PC, with the remote's number keys or the keypad.
import { detectCaps, pair } from './api.ts';
import { clear, h } from './dom.ts';
import { mark } from './icons.ts';
import { focus } from './nav.ts';

export function renderPair(root: HTMLElement, onPaired: () => void): void {
  clear(root);
  let pin = '';
  const boxes = [0, 1, 2, 3, 4, 5].map(() => h('span'));
  const display = h('div', { class: 'pin' }, ...boxes);
  const msg = h('p', { class: 'msg', text: '' });
  const update = (): void => {
    boxes.forEach((b, i) => {
      b.textContent = pin[i] ?? '';
      b.className = i === pin.length ? 'next' : '';
    });
  };
  const submit = async (): Promise<void> => {
    if (pin.length !== 6) return;
    msg.textContent = 'Pairing…';
    try {
      await pair(pin, detectCaps());
      document.removeEventListener('keydown', onKey, true);
      onPaired();
    } catch (err) {
      msg.textContent = err instanceof Error ? err.message : 'Pairing failed';
      pin = '';
      update();
    }
  };
  const press = (k: string): void => {
    if (k === '⌫') pin = pin.slice(0, -1);
    else if (k === 'OK') return void submit();
    else if (pin.length < 6) pin += k;
    update();
    if (pin.length === 6) void submit();
  };
  const pad = h('div', { class: 'keypad' });
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK']) {
    const b = h('button', { class: 'btn key', 'data-nav': true, type: 'button', text: k });
    b.addEventListener('click', () => press(k));
    pad.appendChild(b);
  }
  function onKey(e: KeyboardEvent): void {
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      press(e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      press('⌫');
    }
  }
  document.addEventListener('keydown', onKey, true);
  root.appendChild(
    h(
      'div',
      { class: 'pair' },
      mark('mark'),
      h('h1', {}, 'Home', h('b', { text: 'Cast' })),
      h('p', { text: 'Enter the 6-digit PIN shown on the HomeCast admin page on your PC.' }),
      display,
      pad,
      msg,
    ),
  );
  update();
  focus(pad.querySelector<HTMLElement>('[data-nav]'));
}

// Video/audio player. Direct files play as-is; anything else is HLS from the server, with seeking
// beyond what has been produced restarting the stream at an offset (?t=). One clock: offset + currentTime.
import type { Item } from '../shared/types.ts';
import { openUrl, saveState } from './api.ts';
import { clear, fmtTime, h, idleHider } from './dom.ts';
import { focus, isBackKey, isEnterKey, keyDir, move } from './nav.ts';

interface HlsLike {
  loadSource(u: string): void;
  attachMedia(v: HTMLMediaElement): void;
  destroy(): void;
  on(event: string, fn: (event: string, data: { fatal?: boolean }) => void): void;
}
interface HlsCtor {
  new (cfg?: object): HlsLike;
}
declare global {
  interface Window {
    Hls?: HlsCtor;
  }
}

let hlsLoading: Promise<HlsCtor> | null = null;
/** hls.js only for browsers without native HLS, loaded on first use so the initial bundle stays tiny. */
function loadHls(): Promise<HlsCtor> {
  hlsLoading =
    hlsLoading ??
    new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/assets/hls.min.js';
      s.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('hls.js failed to load')));
      s.onerror = () => reject(new Error('hls.js failed to load'));
      document.head.appendChild(s);
    });
  return hlsLoading;
}

interface SubTrack {
  id: string;
  lang?: string;
  title?: string;
  forced?: boolean;
}
interface AudioTrack {
  index: number;
  codec: string;
  channels: number;
  lang?: string;
  title?: string;
}
interface Cue {
  start: number;
  end: number;
  text: string;
}

const SEEK_STEP = 10;

type MSE = { isTypeSupported(t: string): boolean };

/**
 * Prefer hls.js wherever Media Source Extensions work: desktop Chrome's native HLS treats growing
 * playlists as live. Native HLS is the fallback for browsers without MSE (iOS Safari, some TVs).
 */
function useHlsJs(): boolean {
  const ms = (window as { MediaSource?: MSE }).MediaSource;
  return !!ms && ms.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
}
const SAVE_EVERY_MS = 10_000;

export function parseVtt(text: string): Cue[] {
  const t = (s: string): number => {
    const p = s.trim().split(':').map(Number);
    return p.length === 3 ? p[0]! * 3600 + p[1]! * 60 + p[2]! : p[0]! * 60 + p[1]!;
  };
  const cues: Cue[] = [];
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.indexOf('-->') !== -1);
    if (i === -1) continue;
    const [a, b] = lines[i]!.split('-->');
    cues.push({ start: t(a!), end: t(b!.trim().split(/\s+/)[0]!), text: lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '') });
  }
  return cues;
}

const btn = (label: string, aria: string): HTMLButtonElement =>
  h('button', { class: 'btn ctl', 'data-nav': true, type: 'button', 'aria-label': aria, text: label });

export function playMedia(item: Item, host: HTMLElement, onClose: () => void): () => void {
  const meta = item.meta ?? {};
  const duration = typeof meta.duration === 'number' ? meta.duration : 0;
  const audioTracks = (Array.isArray(meta.audio) ? meta.audio : []) as AudioTrack[];
  const subTracks = (Array.isArray(meta.subs) ? meta.subs : []) as SubTrack[];
  const resume = typeof meta.position === 'number' && !meta.watched && meta.position > 5 ? meta.position : 0;

  const video = h('video', { class: 'media', playsinline: true, autoplay: true });
  const textTrack = video.addTextTrack('subtitles', 'Subtitles');
  textTrack.mode = 'hidden';
  const fill = h('i');
  const progress = h('div', { class: 'progress', 'data-nav': true, tabindex: 0, role: 'slider', 'aria-label': 'Seek' }, h('div', { class: 'track' }, fill));
  const clock = h('div', { class: 'clock', text: '0:00' });
  const closeBtn = btn('← Back', 'Back');
  const back10 = btn('⏮ -10s', 'Back 10 seconds');
  const playBtn = btn('⏯', 'Play or pause');
  const fwd10 = btn('+10s ⏭', 'Forward 10 seconds');
  const tracksBtn = btn('💬 Audio & subtitles', 'Audio and subtitles');
  const status = h('div', { class: 'status' });
  const overlay = h(
    'div',
    { class: 'overlay' },
    h('div', { class: 'otop' }, closeBtn, h('div', { class: 'otitle', text: item.title })),
    h('div', { class: 'obottom' }, progress, h('div', { class: 'ctls' }, back10, playBtn, fwd10, tracksBtn, clock)),
  );
  const menu = h('div', { class: 'menu', 'data-layer': true, hidden: true });
  const layer = h('div', { class: `player kind-${item.kind}`, 'data-layer': true }, video, status, overlay, menu);
  if (item.kind === 'audio') layer.insertBefore(h('div', { class: 'audio-art', text: `🎵 ${item.title}` }), status);
  host.appendChild(layer);

  let offset = 0; // seconds into the file where the current stream starts (HLS restarts)
  let hlsMode = false;
  let hls: HlsLike | null = null;
  let audioIndex: number | undefined;
  let cues: Cue[] = [];
  let closed = false;
  let safe = false; // after a decode failure: ask the server for plain H.264/AAC
  // While a restart is pending, the clock reads the target so repeated presses add up (+10, +10, ...).
  let pending: number | null = null;
  let restartTimer = 0;
  const now = (): number => (pending !== null ? pending : offset + (video.currentTime || 0));
  const total = (): number => duration || (isFinite(video.duration) ? video.duration + offset : 0);
  const ui = idleHider(overlay, 3000, () => video.paused || !menu.hidden);

  function showError(msg: string): void {
    status.textContent = msg;
    status.classList.add('show');
  }

  function applyCues(): void {
    for (const c of textTrack.cues ? Array.from(textTrack.cues) : []) textTrack.removeCue(c);
    for (const c of cues) {
      if (c.end - offset > 0) textTrack.addCue(new VTTCue(Math.max(0, c.start - offset), c.end - offset, c.text));
    }
  }

  async function load(at: number): Promise<void> {
    status.classList.remove('show');
    hls?.destroy();
    hls = null;
    // HEAD tells us which path the server picked: the file itself, or a redirect to an HLS playlist.
    let finalUrl: string;
    try {
      const res = await fetch(openUrl(item.id, { a: audioIndex, safe: safe ? 1 : undefined }), { method: 'HEAD', credentials: 'same-origin' });
      if (res.status === 401) return showError('This TV is no longer paired. Go back and pair again.');
      if (!res.ok) return showError('This file cannot be played.');
      finalUrl = res.url;
    } catch {
      return showError('Cannot reach the PC.');
    }
    if (closed) return;
    hlsMode = finalUrl.indexOf('hls=') !== -1;
    if (hlsMode) {
      offset = Math.floor(at);
      const url = openUrl(item.id, { hls: 'index.m3u8', t: offset, a: audioIndex, safe: safe ? 1 : undefined });
      if (!useHlsJs()) video.src = url;
      else {
        try {
          const Hls = await loadHls();
          if (closed) return;
          hls = new Hls({ maxBufferLength: 30, startPosition: 0 });
          hls.on('hlsError', (_e, data) => {
            if (data.fatal) fallback();
          });
          hls.loadSource(url);
          hls.attachMedia(video);
        } catch {
          return showError('This browser cannot play converted video.');
        }
      }
    } else {
      offset = 0;
      video.src = finalUrl;
      if (at > 0) video.addEventListener('loadedmetadata', () => (video.currentTime = at), { once: true });
    }
    applyCues();
    video.play().catch(() => undefined);
  }

  /** The device could not decode what it said it could: retry once as H.264/AAC, then give up. */
  function fallback(): void {
    if (closed) return;
    if (safe) return showError('Playback failed. This TV cannot play this file.');
    safe = true;
    void load(now());
  }

  function seekTo(target: number): void {
    const end = total();
    const t = Math.max(0, end > 0 ? Math.min(end - 1, target) : target);
    if (!hlsMode) {
      video.currentTime = t;
      return;
    }
    const rel = t - offset;
    const s = video.seekable;
    if (rel >= 0 && s.length && rel <= s.end(s.length - 1)) video.currentTime = rel;
    else {
      // Outside what ffmpeg has produced so far: restart the stream there, once the presses stop.
      pending = t;
      clearTimeout(restartTimer);
      restartTimer = window.setTimeout(() => void load(t), 400);
      render();
    }
  }

  function toggle(): void {
    if (video.paused) video.play().catch(() => undefined);
    else video.pause();
  }

  let lastSave = 0;
  function save(force = false): void {
    if (!force && Date.now() - lastSave < SAVE_EVERY_MS) return;
    lastSave = Date.now();
    if (now() > 1) void saveState(item.id, now(), total());
  }

  function render(): void {
    const t = total();
    fill.style.width = t > 0 ? `${Math.min(100, (now() / t) * 100)}%` : '0%';
    clock.textContent = `${fmtTime(now())} / ${fmtTime(t)}`;
    playBtn.textContent = video.paused ? '▶' : '⏸';
    layer.setAttribute('data-time', now().toFixed(1)); // read by the e2e tests
  }

  // ---- audio & subtitle menu (↑ on the progress bar, or the button) ----
  function pick(label: string, active: boolean, fn: () => void): HTMLButtonElement {
    const b = h('button', { class: `btn item${active ? ' active' : ''}`, 'data-nav': true, type: 'button', text: label });
    b.addEventListener('click', () => {
      fn();
      closeMenu();
    });
    return b;
  }

  function loadSubs(s: SubTrack): void {
    fetch(openUrl(item.id, { track: s.id }), { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('subtitle failed'))))
      .then((text) => {
        cues = parseVtt(text);
        applyCues();
        textTrack.mode = 'showing';
      })
      .catch(() => showError('Subtitles could not be loaded.'));
  }

  function openMenu(): void {
    clear(menu);
    const audioCol = h('div', { class: 'col' }, h('h3', { text: 'Audio' }));
    if (audioTracks.length === 0) audioCol.appendChild(h('p', { text: 'Default' }));
    audioTracks.forEach((a, i) => {
      const label = `${a.lang ? a.lang.toUpperCase() + ' ' : ''}${a.title ?? ''} ${a.codec} ${a.channels}ch`.trim();
      const active = audioIndex === undefined ? i === 0 : audioIndex === a.index;
      audioCol.appendChild(
        pick(label, active, () => {
          audioIndex = i === 0 ? undefined : a.index;
          void load(now());
        }),
      );
    });
    const subCol = h('div', { class: 'col' }, h('h3', { text: 'Subtitles' }));
    subCol.appendChild(pick('Off', textTrack.mode !== 'showing', () => (textTrack.mode = 'hidden')));
    for (const s of subTracks) {
      const label = `${s.lang ? s.lang.toUpperCase() : 'Track'}${s.forced ? ' (forced)' : ''}${s.title ? ` · ${s.title}` : ''}`;
      subCol.appendChild(pick(label, false, () => loadSubs(s)));
    }
    menu.appendChild(h('div', { class: 'menu-box' }, audioCol, subCol));
    menu.hidden = false;
    focus(menu.querySelector<HTMLElement>('.active') ?? menu.querySelector<HTMLElement>('[data-nav]'));
  }

  function closeMenu(): void {
    menu.hidden = true;
    focus(progress, false);
    ui.poke();
  }

  // ---- keys: the progress bar is home base; pointer events reuse the same functions ----
  function onKey(e: KeyboardEvent): void {
    ui.poke();
    const d = keyDir(e);
    if (isBackKey(e)) {
      e.preventDefault();
      if (!menu.hidden) closeMenu();
      else close();
      return;
    }
    if (!menu.hidden) {
      if (d) {
        e.preventDefault();
        move(d);
      }
      return;
    }
    const active = document.activeElement;
    const onBar = active === progress || !overlay.contains(active);
    if (onBar) {
      // ←/→ seek 10 s, Enter play/pause, ↑ audio & subtitles, ↓ to the buttons.
      if (d === 'left' || d === 'right') seekTo(now() + (d === 'left' ? -SEEK_STEP : SEEK_STEP));
      else if (d === 'up') openMenu();
      else if (d === 'down') focus(playBtn, false);
      else if (isEnterKey(e)) toggle();
      else return;
      e.preventDefault();
      if (d !== 'up' && d !== 'down') focus(progress, false);
      return;
    }
    if (d) {
      e.preventDefault();
      if (d === 'up' && active !== closeBtn && (active as HTMLElement | null)?.classList.contains('ctl')) focus(progress, false);
      else move(d);
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    save(true);
    ui.stop();
    clearInterval(tick);
    clearTimeout(restartTimer);
    document.removeEventListener('keydown', onKey, true);
    hls?.destroy();
    video.pause();
    video.removeAttribute('src');
    video.load();
    layer.remove();
    onClose();
  }

  progress.addEventListener('click', (e) => {
    const r = progress.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    if (total() > 0) seekTo(frac * total());
  });
  video.addEventListener('click', toggle);
  playBtn.addEventListener('click', toggle);
  back10.addEventListener('click', () => seekTo(now() - SEEK_STEP));
  fwd10.addEventListener('click', () => seekTo(now() + SEEK_STEP));
  tracksBtn.addEventListener('click', openMenu);
  closeBtn.addEventListener('click', close);
  layer.addEventListener('pointermove', ui.poke);
  menu.addEventListener('click', (e) => {
    if (e.target === menu) closeMenu();
  });
  video.addEventListener('timeupdate', () => {
    render();
    save();
  });
  video.addEventListener('play', render);
  video.addEventListener('playing', () => {
    pending = null;
  });
  video.addEventListener('pause', () => {
    render();
    ui.poke();
    save(true);
  });
  video.addEventListener('ended', () => {
    void saveState(item.id, total(), total());
    close();
  });
  video.addEventListener('error', () => {
    if (video.getAttribute('src') || hls) fallback();
  });
  document.addEventListener('keydown', onKey, true);
  const tick = window.setInterval(render, 1000);

  focus(progress, false);
  ui.poke();
  void load(resume);
  return close;
}

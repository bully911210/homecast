// Video/audio player. Direct files play as-is; anything else is HLS from the server, with seeking
// beyond what has been produced restarting the stream at an offset (?t=). One clock: offset + currentTime.
import { mediaMeta, type AudioTrackMeta, type Item, type SubtitleTrackMeta } from '../shared/types.ts';
import { RESUME_MIN_SECONDS } from '../shared/watch.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { beaconState, messageForError, openUrl, saveState } from './api.ts';
import { clear, fmtTime, h, idleHider } from './dom.ts';
import { icon } from './icons.ts';
import { focus, isBackKey, isEnterKey, keyDir, move } from './nav.ts';

interface HlsLike {
  loadSource(u: string): void;
  attachMedia(v: HTMLMediaElement): void;
  destroy(): void;
  on(event: string, fn: (event: string, data: { fatal?: boolean; type?: string }) => void): void;
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
      const fail = (): void => {
        hlsLoading = null; // let the next play try again instead of caching the failure
        reject(new Error('hls.js failed to load'));
      };
      s.onload = () => (window.Hls ? resolve(window.Hls) : fail());
      s.onerror = fail;
      document.head.appendChild(s);
    });
  return hlsLoading;
}

interface Cue {
  start: number;
  end: number;
  text: string;
}

const SEEK_STEP = 10;
const MAX_PLAYBACK_FALLBACKS = 6;

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

const btn = (aria: string, ...content: (Node | string)[]): HTMLButtonElement =>
  h('button', { class: 'btn ctl', 'data-nav': true, type: 'button', 'aria-label': aria }, ...content);

export function playMedia(item: Item, host: HTMLElement, onClose: () => void): () => void {
  const meta = mediaMeta(item) ?? {};
  const duration = meta.duration ?? 0;
  const audioTracks: AudioTrackMeta[] = meta.audio ?? [];
  const subTracks: SubtitleTrackMeta[] = meta.subs ?? [];
  const resume = meta.position !== undefined && !meta.watched && meta.position > RESUME_MIN_SECONDS ? meta.position : 0;

  const video = h('video', { class: 'media', playsinline: true, autoplay: true });
  const textTrack = video.addTextTrack('subtitles', 'Subtitles');
  textTrack.mode = 'hidden';
  const fill = h('i');
  const progress = h('div', { class: 'progress', 'data-nav': true, tabindex: 0, role: 'slider', 'aria-label': 'Seek' }, h('div', { class: 'track' }, fill));
  const clock = h('div', { class: 'clock', text: '0:00' });
  const closeBtn = btn('Back', icon('back'), ' Back');
  const back10 = btn('Back 10 seconds', icon('prev'), ' 10s');
  const playBtn = btn('Play or pause', icon('pause'));
  const fwd10 = btn('Forward 10 seconds', '10s ', icon('next'));
  const tracksBtn = btn('Audio and subtitles', icon('subtitles'), ' Audio & subtitles');
  const status = h('div', { class: 'status' });
  const overlay = h(
    'div',
    { class: 'overlay' },
    h('div', { class: 'otop' }, closeBtn, h('div', { class: 'otitle', text: item.title })),
    h('div', { class: 'obottom' }, progress, h('div', { class: 'ctls' }, back10, playBtn, fwd10, tracksBtn, clock)),
  );
  const menu = h('div', { class: 'menu', 'data-layer': true, hidden: true });
  const layer = h('div', { class: `player kind-${item.kind}`, 'data-layer': true }, video, status, overlay, menu);
  if (item.kind === 'audio') layer.insertBefore(h('div', { class: 'audio-art' }, icon('audio'), item.title), status);
  host.appendChild(layer);

  let offset = 0; // seconds into the file where the current stream starts (HLS restarts)
  let hlsMode = false;
  let hls: HlsLike | null = null;
  let audioIndex: number | undefined;
  let cues: Cue[] = [];
  let closed = false;
  let attempt = 0;
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

  // Every load() gets a generation; anything that finishes for an older one is dropped,
  // so overlapping loads (seek, then audio switch) never leave a second stream attached.
  let gen = 0;
  let failedGen = -1;
  let netRetries = 0;

  async function load(at: number): Promise<void> {
    const my = ++gen;
    status.classList.remove('show');
    hls?.destroy();
    hls = null;
    const stale = (): boolean => my !== gen || closed;
    // HEAD tells us which path the server picked. redirect: 'manual' because a 302 already means
    // HLS; following it would start a throwaway conversion at t=0.
    let direct = false;
    try {
      const res = await fetch(openUrl(item.id, { a: audioIndex, attempt: attempt || undefined }), {
        method: 'HEAD',
        credentials: 'same-origin',
        redirect: 'manual',
      });
      if (stale()) return;
      if (res.type !== 'opaqueredirect' && res.status === 401) return showError('This TV is no longer paired. Go back and pair again.');
      const mode = res.headers.get('X-HomeCast-Playback');
      if (res.type !== 'opaqueredirect' && !res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: ErrorCode };
        return showError(messageForError(body.code) ?? 'This file cannot be played.');
      }
      direct = mode === 'direct' || (mode === null && res.type !== 'opaqueredirect' && res.ok && res.status !== 204);
    } catch {
      return showError('Cannot reach the PC.');
    }
    hlsMode = !direct;
    if (hlsMode) {
      offset = Math.floor(at);
      const url = openUrl(item.id, { hls: 'index.m3u8', t: offset, a: audioIndex, attempt: attempt || undefined });
      if (!useHlsJs()) video.src = url;
      else {
        let Hls: HlsCtor;
        try {
          Hls = await loadHls();
        } catch {
          return showError('This browser cannot play converted video.');
        }
        if (stale()) return;
        const h = new Hls({ maxBufferLength: 30, startPosition: 0 });
        hls = h;
        h.on('hlsError', (_e, data) => {
          if (!data.fatal || my !== gen) return;
          if (data.type === 'mediaError') fallback(my); // could not decode: try plain H.264/AAC
          else if (netRetries++ < 2) void load(now()); // network/job hiccup: same settings again
          else showError('Lost the connection to the PC.');
        });
        h.loadSource(url);
        h.attachMedia(video);
      }
    } else {
      offset = 0;
      video.src = openUrl(item.id, { a: audioIndex });
      if (at > 0) video.addEventListener('loadedmetadata', () => (video.currentTime = at), { once: true });
    }
    pending = null; // offset is valid again
    applyCues();
    video.play().catch(() => undefined);
  }

  /** Move to the next server-planned playback rung; each attempt is used at most once. */
  function fallback(g = gen): void {
    if (closed || g !== gen || failedGen === g) return; // one decision per load, however many error events
    failedGen = g;
    if (attempt >= MAX_PLAYBACK_FALLBACKS) return showError('Playback failed. This TV cannot play this file.');
    attempt++;
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
  let saving = false;
  let pendingSave: { position: number; duration: number } | null = null;

  async function flushSave(): Promise<void> {
    if (saving) return;
    saving = true;
    while (pendingSave) {
      const current = pendingSave;
      pendingSave = null;
      await saveState(item.id, current.position, current.duration);
    }
    saving = false;
  }

  function save(force = false): void {
    if (!force && Date.now() - lastSave < SAVE_EVERY_MS) return;
    lastSave = Date.now();
    if (now() > 1) {
      pendingSave = { position: now(), duration: total() };
      void flushSave();
    }
  }

  function onPageHide(): void {
    if (now() > 1) beaconState(item.id, now(), total());
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'hidden') save(true);
  }

  function render(): void {
    const t = total();
    fill.style.width = t > 0 ? `${Math.min(100, (now() / t) * 100)}%` : '0%';
    clock.textContent = `${fmtTime(now())} / ${fmtTime(t)}`;
    const want = video.paused ? 'play' : 'pause';
    if (playBtn.getAttribute('data-icon') !== want) {
      clear(playBtn);
      playBtn.appendChild(icon(want));
      playBtn.setAttribute('data-icon', want);
    }
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

  function loadSubs(s: SubtitleTrackMeta): void {
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
    // "No choice" means the file's default track (the server picks it the same way), not the first one.
    const defaultIndex = (audioTracks.find((a) => a.isDefault) ?? audioTracks[0])?.index;
    for (const a of audioTracks) {
      const label = `${a.lang ? a.lang.toUpperCase() + ' ' : ''}${a.title ?? ''} ${a.codec} ${a.channels}ch`.trim();
      const active = (audioIndex ?? defaultIndex) === a.index;
      audioCol.appendChild(
        pick(label, active, () => {
          // Keep the default as "no choice" so direct play stays possible for it.
          audioIndex = a.index === defaultIndex ? undefined : a.index;
          void load(now());
        }),
      );
    }
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
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
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
  video.addEventListener('pause', () => {
    render();
    ui.poke();
    save(true);
  });
  video.addEventListener('ended', () => {
    pendingSave = { position: total(), duration: total() };
    void flushSave();
    close();
  });
  video.addEventListener('error', () => {
    if (video.getAttribute('src') || hls) fallback();
  });
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  const tick = window.setInterval(render, 1000);

  focus(progress, false);
  ui.poke();
  void load(resume);
  return close;
}

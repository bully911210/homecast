// HLS job manager: at most N ffmpeg jobs, idle kill, PID tracking, size-capped cache.
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { log } from './log.ts';
import { HW_ORDER, probeEncoderArgs, type Encoder, type PlaybackMode } from './playback.ts';
import { run } from './run.ts';

const FILE_RE = /^(index\.m3u8|init\.mp4|seg_\d{5}\.(ts|m4s))$/;
const WAIT_MS = 30_000;
const IDLE_MS = 60_000;

function isHlsFile(name: string): boolean {
  return FILE_RE.test(name);
}

interface Job {
  key: string;
  group: string;
  dir: string;
  proc: ChildProcess;
  lastAccess: number;
  exited: boolean;
  exitCode: number | null;
  stderr: string;
}

export interface HlsRequest {
  key: string; // unique per (item, device, start, audio track)
  group: string; // per (item, device): a new start offset replaces the old job
  file: string; // index.m3u8 | init.mp4 | seg_NNNNN.ts|m4s
  playbackMode: Exclude<PlaybackMode, 'direct' | 'unplayable'>;
  uri: (file: string) => string; // absolute URL for a segment, used to rewrite the playlist
  args: (outDir: string) => string[];
}

export interface HlsOptions {
  ffmpeg: string;
  dir: string;
  maxJobs: number;
  cacheBytes: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    total += await stat(join(dir, f)).then((s) => s.size).catch(() => 0);
  }
  return total;
}

/** Is this PID (from a previous run) still an ffmpeg process? Avoids killing a recycled PID. */
async function isFfmpeg(pid: number): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const r = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], 5000);
      return /ffmpeg/i.test(r.stdout.toString());
    }
    return /ffmpeg/.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
  } catch {
    return false;
  }
}

export async function pickEncoders(ffmpeg: string | null): Promise<Encoder[]> {
  if (!ffmpeg) return [];
  const candidates: readonly Encoder[] = [...HW_ORDER, 'libx264'];
  const available = await Promise.all(candidates.map(async (encoder) => {
    try {
      return (await run(ffmpeg, probeEncoderArgs(encoder), 15_000)).code === 0;
    } catch {
      return false;
    }
  }));
  return candidates.filter((_encoder, index) => available[index]);
}

export async function pickEncoder(ffmpeg: string | null): Promise<Encoder> {
  const encoders = await pickEncoders(ffmpeg);
  return encoders.find((e) => e !== 'libx264') ?? 'libx264';
}

export class HlsJobs {
  readonly #o: HlsOptions;
  readonly #jobs = new Map<string, Job>();
  readonly #starting = new Map<string, Promise<Job>>();
  readonly #pidFile: string;
  readonly #reaper: NodeJS.Timeout;

  constructor(o: HlsOptions) {
    this.#o = o;
    this.#pidFile = join(o.dir, 'pids.json');
    this.#reaper = setInterval(() => this.#reap(), 5000);
    this.#reaper.unref();
  }

  activeJobs(): number {
    return [...this.#jobs.values()].filter((j) => !j.exited).length;
  }

  pids(): number[] {
    return [...this.#jobs.values()].filter((j) => !j.exited && j.proc.pid).map((j) => j.proc.pid!);
  }

  async cacheBytes(): Promise<number> {
    let total = 0;
    for (const d of await readdir(this.#o.dir).catch(() => [] as string[])) {
      if (d !== 'pids.json') total += await dirSize(join(this.#o.dir, d));
    }
    return total;
  }

  /** Kill ffmpeg processes left over by a previous crash. */
  async sweepOrphans(): Promise<number> {
    await mkdir(this.#o.dir, { recursive: true });
    let pids: number[] = [];
    try {
      pids = JSON.parse(readFileSync(this.#pidFile, 'utf8')) as number[];
    } catch {
      return 0;
    }
    let killed = 0;
    for (const pid of pids.filter((p) => Number.isInteger(p) && p > 0)) {
      if (await isFfmpeg(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
          killed++;
        } catch {
          // already gone
        }
      }
    }
    this.#savePids();
    if (killed) log.warn(`killed ${killed} orphan ffmpeg process(es)`);
    return killed;
  }

  async serve(req: HlsRequest): Promise<Response> {
    if (!isHlsFile(req.file)) return new Response('bad hls file', { status: 400 });
    const dir = join(this.#o.dir, safeKey(req.key));
    let job = this.#jobs.get(req.key);
    // A failed job is forgotten so the next request tries again (the client gives up after one retry).
    if (job?.exited && job.exitCode !== 0) {
      this.#jobs.delete(req.key);
      job = undefined;
    }
    const complete = !job && existsSync(join(dir, 'index.m3u8')) && readFileSync(join(dir, 'index.m3u8'), 'utf8').includes('#EXT-X-ENDLIST');
    if (!job && !complete) {
      // Concurrent requests for the same key share one start, so no ffmpeg ever goes untracked.
      let starting = this.#starting.get(req.key);
      if (!starting) {
        starting = this.#start(req, dir).finally(() => this.#starting.delete(req.key));
        this.#starting.set(req.key, starting);
      }
      job = await starting;
    }
    if (job) job.lastAccess = Date.now();

    const path = join(dir, req.file);
    const ready = await this.#waitFor(path, job, req.file === 'index.m3u8');
    if (!ready) {
      // ffmpeg's stderr stays in the server log: it contains file paths the client must never see.
      const failed = job?.exited === true && job.exitCode !== 0;
      return new Response(failed ? 'conversion failed' : 'segment not available', { status: failed ? 500 : 404 });
    }
    if (req.file === 'index.m3u8') {
      const text = await readFile(path, 'utf8');
      const body = text
        .split('\n')
        .map((l) => (isHlsFile(l.trim()) ? req.uri(l.trim()) : l.replace(/URI="(init\.mp4)"/, (_m, f: string) => `URI="${req.uri(f)}"`)))
        .join('\n')
        // A growing EVENT playlist looks live; tell players to start at the beginning, not the live edge.
        .replace('#EXTM3U', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES');
      return new Response(body, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache', 'X-HomeCast-Playback': req.playbackMode } });
    }
    const st = await stat(path);
    const rs = createReadStream(path);
    return new Response(Readable.toWeb(rs) as ReadableStream<Uint8Array>, {
      headers: {
        'Content-Type': req.file.endsWith('.ts') ? 'video/mp2t' : 'video/mp4',
        'Content-Length': String(st.size),
        'Cache-Control': 'private, max-age=3600',
        'X-HomeCast-Playback': req.playbackMode,
      },
    });
  }

  /** Stop every job (shutdown, or the "kill on exit" guarantee). Synchronous on purpose. */
  killAll(): void {
    clearInterval(this.#reaper);
    for (const j of this.#jobs.values()) if (!j.exited) j.proc.kill('SIGKILL');
    this.#jobs.clear();
    this.#savePids();
  }

  async #start(req: HlsRequest, dir: string): Promise<Job> {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await this.#evict();
    // From here to #jobs.set there is no await, so concurrent starts can't both pass the cap.
    // A new start offset for the same item+device replaces the old job (that's a seek).
    for (const j of [...this.#jobs.values()]) if (j.group === req.group) this.#kill(j);
    // Over the cap: evict the least recently used job.
    const live = [...this.#jobs.values()].filter((j) => !j.exited).sort((a, b) => a.lastAccess - b.lastAccess);
    while (live.length >= this.#o.maxJobs) this.#kill(live.shift()!);
    const proc = spawn(this.#o.ffmpeg, req.args(dir), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const job: Job = { key: req.key, group: req.group, dir, proc, lastAccess: Date.now(), exited: false, exitCode: null, stderr: '' };
    proc.stderr?.on('data', (b: Buffer) => {
      if (job.stderr.length < 16_000) job.stderr += b.toString();
    });
    const onExit = (code: number | null): void => {
      if (job.exited) return;
      job.exited = true;
      job.exitCode = code;
      if (code !== 0 && code !== null) log.warn(`ffmpeg job ${req.key} exited ${code}: ${job.stderr.slice(-400)}`);
      this.#savePids();
    };
    proc.on('exit', onExit);
    proc.on('error', (err) => {
      job.stderr += String(err);
      onExit(-1);
    });
    this.#jobs.set(req.key, job);
    this.#savePids();
    return job;
  }

  async #waitFor(path: string, job: Job | undefined, playlist: boolean): Promise<boolean> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      if (existsSync(path)) {
        if (!playlist) return true;
        const text = readFileSync(path, 'utf8');
        if (text.includes('#EXTINF') || text.includes('#EXT-X-ENDLIST')) return true;
      }
      if (!job || job.exited || Date.now() > deadline) return existsSync(path);
      await sleep(150);
    }
  }

  #kill(j: Job): void {
    if (!j.exited) j.proc.kill('SIGKILL');
    this.#jobs.delete(j.key);
  }

  #reap(): void {
    const now = Date.now();
    for (const j of [...this.#jobs.values()]) {
      if (now - j.lastAccess > IDLE_MS) this.#kill(j);
    }
    this.#savePids();
  }

  /** Delete whole job folders, oldest first, until the cache is under its cap. */
  async #evict(): Promise<void> {
    const dirs: { path: string; mtime: number; size: number }[] = [];
    for (const d of await readdir(this.#o.dir).catch(() => [] as string[])) {
      const p = join(this.#o.dir, d);
      if (d === 'pids.json' || [...this.#jobs.values()].some((j) => j.dir === p)) continue;
      const st = await stat(p).catch(() => null);
      if (st?.isDirectory()) dirs.push({ path: p, mtime: st.mtimeMs, size: await dirSize(p) });
    }
    let total = dirs.reduce((s, d) => s + d.size, 0);
    for (const d of dirs.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= this.#o.cacheBytes) break;
      await rm(d.path, { recursive: true, force: true });
      total -= d.size;
    }
  }

  #savePids(): void {
    try {
      writeFileSync(this.#pidFile, JSON.stringify(this.pids()));
    } catch {
      // cache dir gone (tests) — nothing to track
    }
  }
}

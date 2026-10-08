// Minimal logger: one file per day, 7 days kept, mirrored to the console.
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

type Level = 'info' | 'warn' | 'error';

const KEEP_DAYS = 7;
const LOG_NAME_RE = /^homecast-(\d{4}-\d{2}-\d{2})\.log$/;
let dir: string | null = null;
let currentDay = '';

function day(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function prune(): void {
  if (!dir) return;
  const cutoff = day(new Date(Date.now() - KEEP_DAYS * 86_400_000));
  for (const f of readdirSync(dir)) {
    const m = f.match(LOG_NAME_RE);
    if (m && m[1]! < cutoff) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        // A locked old log is not worth crashing over.
      }
    }
  }
}

export function initLog(logDir: string): void {
  mkdirSync(logDir, { recursive: true });
  dir = logDir;
  currentDay = day();
  prune();
}

function fmt(v: unknown): string {
  if (v instanceof Error) return v.stack ?? v.message;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function write(level: Level, msg: string, extra: unknown[]): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}${extra.length ? ' ' + extra.map(fmt).join(' ') : ''}`;
  if (process.env.HOMECAST_QUIET !== '1') (level === 'info' ? process.stdout : process.stderr).write(line + '\n');
  if (!dir) return;
  const today = day();
  if (today !== currentDay) {
    currentDay = today;
    prune();
  }
  try {
    appendFileSync(join(dir, `homecast-${today}.log`), line + '\n');
  } catch {
    // Disk full or locked: console output still happened.
  }
}

export const log = {
  info: (msg: string, ...extra: unknown[]): void => write('info', msg, extra),
  warn: (msg: string, ...extra: unknown[]): void => write('warn', msg, extra),
  error: (msg: string, ...extra: unknown[]): void => write('error', msg, extra),
};

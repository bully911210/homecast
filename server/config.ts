// One JSON config file with defaults. Lives in the app data dir, never in a library root.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Root {
  id: string;
  path: string;
}

export interface Config {
  port: number;
  maxJobs: number;
  cacheGb: number;
  roots: Root[];
  adapter?: string; // override adapter name or IP
  mdns: boolean;
}

export const DEFAULTS: Config = { port: 8096, maxJobs: 2, cacheGb: 10, roots: [], mdns: true };

export function dataDir(): string {
  if (process.env.HOMECAST_DATA) return process.env.HOMECAST_DATA;
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'HomeCast');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'homecast');
}

function intIn(v: unknown, min: number, max: number, dflt: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : dflt;
}

/** Validate an untrusted parsed JSON object into a Config, falling back field by field. */
export function sanitizeConfig(raw: unknown): Config {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const roots = Array.isArray(r.roots)
    ? r.roots.filter(
        (x): x is Root =>
          typeof x === 'object' && x !== null && typeof (x as Root).id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test((x as Root).id) && typeof (x as Root).path === 'string',
      )
    : [];
  return {
    port: intIn(r.port, 1, 65535, DEFAULTS.port),
    maxJobs: intIn(r.maxJobs, 1, 8, DEFAULTS.maxJobs),
    cacheGb: intIn(r.cacheGb, 1, 1000, DEFAULTS.cacheGb),
    roots: roots.map((x) => ({ id: x.id, path: x.path })),
    adapter: typeof r.adapter === 'string' && r.adapter.length > 0 ? r.adapter : undefined,
    mdns: typeof r.mdns === 'boolean' ? r.mdns : DEFAULTS.mdns,
  };
}

export class ConfigFile {
  readonly path: string;
  #value: Config;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'config.json');
    let raw: unknown = {};
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      // Missing or corrupt: start from defaults and write them out so the user can find the file.
    }
    this.#value = sanitizeConfig(raw);
    this.#write();
  }

  get(): Config {
    return this.#value;
  }

  update(patch: Partial<Config>): Config {
    this.#value = sanitizeConfig({ ...this.#value, ...patch });
    this.#write();
    return this.#value;
  }

  #write(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#value, null, 2));
    renameSync(tmp, this.path);
  }
}

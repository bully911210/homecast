// The thin router. Four item routes, pairing, health, admin. Everything else is a provider's job.
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { isItemId, parsePairBody, parseRootBody, parseStateBody, parseCaps } from '../shared/guards.ts';
import type { Device, Item, OpenCtx } from '../shared/types.ts';
import { HttpError } from './http.ts';
import { log } from './log.ts';
import { isAllowedHost, isLanAddress, isLoopback, isSameOrigin } from './net.ts';
import { COOKIE, type Pairing } from './pairing.ts';
import type { Registry } from './registry.ts';
import { getStates, saveState, type Database } from './store.ts';

export interface Asset {
  body: Uint8Array<ArrayBuffer> | string;
  type: string;
}

export interface AdminApi {
  status(): Promise<unknown>;
  addRoot(path: string): Promise<void>;
  removeRoot(id: string): Promise<void>;
  rescan(): Promise<void>;
  setAutostart(on: boolean): Promise<void>;
}

export interface AppDeps {
  db: Database;
  registry: Registry;
  pairing: Pairing;
  health: (full: boolean) => Promise<unknown>;
  admin: AdminApi;
  asset: (name: string) => Promise<Asset | null>;
  extraHosts?: readonly string[];
}

type Env = { Variables: { device: Device; remote: string } };

const TEN_YEARS = 10 * 365 * 86_400;

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

async function jsonBody(c: Context): Promise<unknown> {
  if (!(c.req.header('content-type') ?? '').includes('application/json')) throw new HttpError(415, 'expected application/json');
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function itemParam(c: Context): string {
  const id = c.req.param('id');
  if (!isItemId(id)) throw new HttpError(404, 'not found');
  return id;
}

export function buildApp(d: AppDeps): Hono<Env> {
  const app = new Hono<Env>();

  async function withState(items: Item[]): Promise<Item[]> {
    const states = getStates(d.db, items.filter((i) => i.kind !== 'folder').map((i) => i.id));
    return items.map((i) => {
      const s = states.get(i.id);
      return s ? { ...i, meta: { ...i.meta, position: s.position, watched: s.watched } } : i;
    });
  }

  // ---- guards: LAN only, Host allowlist (DNS rebinding), same-origin writes (CSRF) ----
  app.use('*', async (c, next) => {
    let remote = '';
    try {
      remote = getConnInfo(c).remote.address ?? '';
    } catch {
      remote = '';
    }
    if (!isLanAddress(remote)) return c.json({ error: 'LAN only' }, 403);
    if (!isAllowedHost(c.req.header('host'), d.extraHosts)) return c.json({ error: 'unknown host' }, 403);
    const write = c.req.method !== 'GET' && c.req.method !== 'HEAD';
    if (write && !isSameOrigin(c.req.header('origin'), c.req.header('host'))) return c.json({ error: 'cross-origin request refused' }, 403);
    c.set('remote', remote);
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    log.error(`${c.req.method} ${c.req.path} failed`, err);
    return c.json({ error: 'internal error' }, 500);
  });

  // ---- static client ----
  const sendAsset = async (c: Context, name: string): Promise<Response> => {
    const a = await d.asset(name);
    if (!a) return c.json({ error: 'not found' }, 404);
    const cache = name.endsWith('.html') ? 'no-cache' : 'public, max-age=300';
    return new Response(a.body, { headers: { 'Content-Type': a.type, 'Cache-Control': cache } });
  };
  app.get('/', (c) => sendAsset(c, 'index.html'));
  app.get('/assets/:name{[a-z0-9.-]+}', (c) => sendAsset(c, c.req.param('name')));

  // ---- pairing ----
  app.post('/pair', async (c) => {
    const raw = (await jsonBody(c)) as Record<string, unknown>;
    const existing = d.pairing.authenticate(readCookie(c.req.header('cookie'), COOKIE));
    if (existing && raw && typeof raw === 'object' && raw.pin === undefined) {
      d.pairing.updateCaps(existing.id, parseCaps(raw.caps));
      return c.json({ ok: true, device: { id: existing.id, name: existing.name } });
    }
    const body = parsePairBody(raw);
    if (!body) return c.json({ error: 'enter the 6-digit PIN shown on the PC' }, 400);
    const r = d.pairing.pair(c.get('remote'), body);
    if (!r.ok) return c.json({ error: r.status === 429 ? 'too many attempts, wait a minute' : 'wrong PIN' }, r.status);
    log.info(`paired device "${r.device.name}" from ${c.get('remote')}`);
    c.header('Set-Cookie', `${COOKIE}=${r.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TEN_YEARS}`);
    return c.json({ ok: true, device: { id: r.device.id, name: r.device.name } });
  });

  // ---- health: summary for anyone on the LAN, details for paired devices and this PC ----
  app.get('/api/health', async (c) => {
    const full = isLoopback(c.get('remote')) || d.pairing.authenticate(readCookie(c.req.header('cookie'), COOKIE)) !== null;
    return c.json(await d.health(full));
  });

  // ---- auth for the item API ----
  app.use('/api/*', async (c, next) => {
    const device = d.pairing.authenticate(readCookie(c.req.header('cookie'), COOKIE));
    if (!device) return c.json({ error: 'not paired' }, 401);
    c.set('device', device);
    await next();
  });

  const ctxFor = (c: Context<Env>, variant: OpenCtx['variant']): OpenCtx => ({
    req: c.req.raw,
    device: c.get('device'),
    variant,
    query: new URL(c.req.url).searchParams,
  });

  app.get('/api/items', async (c) => {
    const parent = c.req.query('parent');
    if (parent !== undefined && !isItemId(parent)) throw new HttpError(404, 'not found');
    return c.json({ items: await withState(await d.registry.list(parent)) }, 200, { 'Cache-Control': 'no-store' });
  });

  app.get('/api/open/:id', (c) => {
    const ctx = ctxFor(c, 'main');
    return d.registry.open(itemParam(c), ctx.query.has('track') ? { ...ctx, variant: 'sub' } : ctx);
  });

  app.get('/api/thumb/:id', (c) => d.registry.open(itemParam(c), ctxFor(c, 'thumb')));

  app.post('/api/state/:id', async (c) => {
    const id = itemParam(c);
    if (!d.registry.has(id)) throw new HttpError(404, 'not found');
    const body = parseStateBody(await jsonBody(c));
    if (!body) return c.json({ error: 'expected { position, duration }' }, 400);
    return c.json({ state: saveState(d.db, id, body) });
  });

  // ---- admin: this PC only ----
  app.use('/admin/*', async (c, next) => {
    if (!isLoopback(c.get('remote'))) return c.json({ error: 'admin is only available on the PC itself' }, 403);
    await next();
  });
  app.get('/admin', async (c) => {
    if (!isLoopback(c.get('remote'))) return c.json({ error: 'admin is only available on the PC itself' }, 403);
    return sendAsset(c, 'admin.html');
  });
  app.get('/admin/api/status', async (c) => c.json(await d.admin.status(), 200, { 'Cache-Control': 'no-store' }));
  app.post('/admin/api/roots', async (c) => {
    const body = parseRootBody(await jsonBody(c));
    if (!body) return c.json({ error: 'expected { path }' }, 400);
    await d.admin.addRoot(body.path);
    return c.json({ ok: true });
  });
  app.delete('/admin/api/roots/:rid{[A-Za-z0-9_-]{1,32}}', async (c) => {
    await d.admin.removeRoot(c.req.param('rid'));
    return c.json({ ok: true });
  });
  app.post('/admin/api/rescan', async (c) => {
    await jsonBody(c);
    void d.admin.rescan();
    return c.json({ ok: true });
  });
  app.delete('/admin/api/devices/:did{[a-f0-9]{16}}', (c) => c.json({ ok: d.pairing.revoke(c.req.param('did')) }));
  app.post('/admin/api/pin', async (c) => {
    await jsonBody(c);
    d.pairing.rotate();
    return c.json({ ok: true });
  });
  app.post('/admin/api/autostart', async (c) => {
    const body = (await jsonBody(c)) as { on?: unknown };
    if (typeof body?.on !== 'boolean') return c.json({ error: 'expected { on: boolean }' }, 400);
    await d.admin.setAutostart(body.on);
    return c.json({ ok: true });
  });

  return app;
}

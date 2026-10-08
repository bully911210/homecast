// LAN guard, Host allowlist and adapter selection. Pure functions, easy to test.
import { isIP } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function inV4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

/** Strip IPv4-mapped IPv6 prefix and zone ids. */
export function normalizeAddress(addr: string): string {
  let a = addr.trim().toLowerCase();
  const zone = a.indexOf('%');
  if (zone !== -1) a = a.slice(0, zone);
  if (a.startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7);
  return a;
}

export function isLoopback(addr: string): boolean {
  const a = normalizeAddress(addr);
  if (isIP(a) === 4) return inV4(a, '127.0.0.0', 8);
  return a === '::1';
}

/** Loopback or private/link-local per RFC 1918, RFC 3927, RFC 4193, RFC 4291. */
export function isLanAddress(addr: string): boolean {
  const a = normalizeAddress(addr);
  const fam = isIP(a);
  if (fam === 4) {
    return (
      inV4(a, '127.0.0.0', 8) ||
      inV4(a, '10.0.0.0', 8) ||
      inV4(a, '172.16.0.0', 12) ||
      inV4(a, '192.168.0.0', 16) ||
      inV4(a, '169.254.0.0', 16)
    );
  }
  if (fam === 6) {
    if (a === '::1') return true;
    const first = parseInt(a.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

/** Hostname part of a Host header ("[::1]:8096" -> "::1", "pc:8096" -> "pc"). */
export function hostOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']') === -1 ? undefined : h.indexOf(']'));
  const colon = h.lastIndexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

/**
 * DNS-rebinding defence: only accept requests addressed to an IP literal or a name
 * that can only mean this machine. An attacker domain rebound to our IP fails here.
 */
export function isAllowedHost(hostHeader: string | undefined, extraNames: readonly string[] = []): boolean {
  if (!hostHeader) return false;
  const h = hostOf(hostHeader);
  if (h.length === 0) return false;
  if (isIP(h) !== 0) return true;
  const me = hostname().toLowerCase();
  const allowed = new Set(['localhost', 'homecast.local', me, `${me}.local`, ...extraNames.map((n) => n.toLowerCase())]);
  return allowed.has(h);
}

/** For mutating requests: if the browser sent an Origin, it must point at the same host. */
export function isSameOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (origin === undefined) return true;
  if (!hostHeader) return false;
  try {
    return new URL(origin).host.toLowerCase() === hostHeader.trim().toLowerCase();
  } catch {
    return false;
  }
}

const VIRTUAL_ADAPTER_RE = /vethernet|wsl|hyper-v|virtualbox|vmware|docker|vpn|tap|tun|tailscale|zerotier|wireguard|loopback|bluetooth/i;

export interface Adapter {
  name: string;
  address: string;
}

/** Candidate LAN adapters, best first. Virtual adapters are dropped unless named by the override. */
export function lanAdapters(override?: string, ifaces = networkInterfaces()): Adapter[] {
  const out: Adapter[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal || !isLanAddress(i.address) || i.address.startsWith('169.254.')) continue;
      if (override ? name !== override && i.address !== override : VIRTUAL_ADAPTER_RE.test(name)) continue;
      out.push({ name, address: i.address });
    }
  }
  // Prefer the usual home ranges.
  const rank = (a: string): number => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : 2);
  return out.sort((x, y) => rank(x.address) - rank(y.address));
}

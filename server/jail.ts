// Folder jail: a relative path from the index may only ever resolve to a real file inside its root.
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';

const WIN = process.platform === 'win32';
const DEVICE_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Structural checks on a stored relative path ("a/b/c.mkv"), before touching the disk. */
export function isSafeRelative(rel: string): boolean {
  if (rel === '') return true; // the root itself
  if (rel.length > 4096 || rel.includes('\0') || rel.includes('\\')) return false;
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) return false;
  for (const part of rel.split('/')) {
    if (part === '' || part === '.' || part === '..') return false;
    if (part.includes(':')) return false; // NTFS alternate data streams, drive letters
    if (DEVICE_RE.test(part)) return false;
    if (WIN && /[. ]$/.test(part)) return false; // Windows silently strips these
  }
  return true;
}

function within(rootReal: string, target: string): boolean {
  const r = WIN ? rootReal.toLowerCase() : rootReal;
  const t = WIN ? target.toLowerCase() : target;
  if (t === r) return true;
  return t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Resolve rel inside rootReal (already realpath'd). Follows symlinks/junctions and
 * re-checks the destination, so a link pointing outside the root is refused.
 * Returns the real absolute path, or null.
 */
export async function resolveInJail(rootReal: string, rel: string): Promise<string | null> {
  if (!isSafeRelative(rel)) return null;
  const candidate = rel === '' ? rootReal : join(rootReal, ...rel.split('/'));
  if (!within(rootReal, candidate)) return null;
  let real: string;
  let root: string;
  try {
    real = await realpath(candidate);
    // Resolve the root the same way: Windows 8.3 short names (C:\Users\RUNNER~1) expand to long ones.
    root = await realpath(rootReal);
  } catch {
    return null;
  }
  return within(root, real) ? real : null;
}

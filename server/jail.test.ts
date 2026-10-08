import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSafeRelative, resolveInJail } from './jail.ts';
import { startTestServer, type TestServer } from './testkit.ts';

let base: string;
let root: string;
let outside: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'homecast-jail-')));
  root = join(base, 'media');
  outside = join(base, 'media2'); // sibling with a shared prefix: classic startsWith bug
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, 'ok.mp4'), 'x');
  writeFileSync(join(root, 'sub', 'deep.mp4'), 'x');
  writeFileSync(join(outside, 'secret.mp4'), 'secret');
  writeFileSync(join(base, 'top-secret.txt'), 'secret');
  // Junctions need no admin rights on Windows; plain symlinks on Linux.
  symlinkSync(outside, join(root, 'escape-link'), process.platform === 'win32' ? 'junction' : 'dir');
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const ATTACKS: readonly string[] = [
  '..',
  '../top-secret.txt',
  '../media2/secret.mp4',
  'sub/../../top-secret.txt',
  'sub/../../../../../../etc/passwd',
  String.raw`..\top-secret.txt`,
  String.raw`sub\..\..\top-secret.txt`,
  '/etc/passwd',
  String.raw`C:\Windows\win.ini`,
  'C:/Windows/win.ini',
  'c:top-secret.txt',
  String.raw`\\server\share\file.mp4`,
  '//server/share/file.mp4',
  String.raw`\\?\C:\Windows\win.ini`,
  'ok.mp4:$DATA',
  'ok.mp4::$DATA',
  'CON',
  'nul.mp4',
  'sub/AUX/x.mp4',
  'COM1.mkv',
  'ok.mp4\0.jpg',
  './ok.mp4',
  'sub//deep.mp4',
  'sub/./deep.mp4',
  'ok.mp4.',
  'ok.mp4 ',
  'escape-link/secret.mp4', // junction/symlink pointing outside the root
  'missing.mp4',
  '%2e%2e/top-secret.txt', // URL encoding is not decoded: just a non-existent name
];

describe('folder jail', () => {
  it('has at least 20 attack cases', () => expect(ATTACKS.length).toBeGreaterThanOrEqual(20));

  it.each(ATTACKS)('rejects %j', async (rel) => {
    expect(await resolveInJail(root, rel)).toBeNull();
  });

  it('allows legitimate paths', async () => {
    expect(await resolveInJail(root, 'ok.mp4')).toBe(join(root, 'ok.mp4'));
    expect(await resolveInJail(root, 'sub/deep.mp4')).toBe(join(root, 'sub', 'deep.mp4'));
    expect(await resolveInJail(root, '')).toBe(root);
  });

  it('structural check is pure', () => {
    expect(isSafeRelative('a/b.mkv')).toBe(true);
    expect(isSafeRelative('a/../b.mkv')).toBe(false);
  });
});

describe('item IDs over HTTP never reach the filesystem', () => {
  let s: TestServer;
  let cookie: string;
  beforeAll(async () => {
    s = await startTestServer({ roots: [root] });
    cookie = await s.pair();
  });
  afterAll(() => s.close());

  const HTTP_ATTACKS = [
    '/api/open/..%2f..%2ftop-secret.txt',
    '/api/open/fs:..%2F..%2Ftop-secret.txt',
    '/api/open/fs%3A..%5Ctop-secret.txt',
    '/api/open/fs:%2e%2e',
    '/api/open/fs:C%3A%5CWindows%5Cwin.ini',
    '/api/open/fs:aaaaaaaaaaaa',
    '/api/open/home:..',
    '/api/open/evil:x',
    '/api/thumb/fs:..%2F..',
    '/api/items?parent=..%2F..',
    '/api/items?parent=fs:..%2F',
    '/api/open/' + 'a'.repeat(5000),
  ];

  it.each(HTTP_ATTACKS)('%s -> 404 without file contents', async (path) => {
    const res = await s.get(path, cookie);
    expect([400, 404]).toContain(res.status);
    expect(await res.text()).not.toContain('secret');
  });
});

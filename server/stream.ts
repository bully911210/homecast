// Direct file streaming with Range / 206 / 416 / HEAD / ETag. Never buffers a whole file.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

let openStreams = 0;
/** Number of file read streams currently open. Exposed for health and leak tests. */
export function openStreamCount(): number {
  return openStreams;
}

export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

const RANGE_RE = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i;

/**
 * Parse a single-range "bytes=" header against a file size.
 * null = ignore the header and send the whole file (absent, malformed or multi-range).
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange {
  if (!header) return null;
  const m = header.match(RANGE_RE);
  if (!m) return null;
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const n = Number(b);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (start >= size) return 'unsatisfiable';
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return null; // syntactically invalid per RFC 9110: ignore
  return { start, end };
}

export function etagFor(size: number, mtimeMs: number): string {
  return `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

function nodeToWeb(path: string, start: number, end: number): ReadableStream<Uint8Array> {
  const rs = createReadStream(path, { start, end, highWaterMark: 256 * 1024 });
  openStreams++;
  rs.once('close', () => openStreams--);
  // Cancelling the web stream (client abort) destroys the file stream and closes the fd.
  return Readable.toWeb(rs) as ReadableStream<Uint8Array>;
}

export interface ServeOpts {
  contentType: string;
  cacheControl?: string;
}

export async function serveFile(req: Request, path: string, opts: ServeOpts): Promise<Response> {
  const st = await stat(path);
  const size = st.size;
  const etag = etagFor(size, st.mtimeMs);
  const base: Record<string, string> = {
    'Content-Type': opts.contentType,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
    'Cache-Control': opts.cacheControl ?? 'private, no-cache',
  };

  const inm = req.headers.get('if-none-match');
  if (inm && inm.split(',').some((t) => t.trim() === etag || t.trim() === '*')) {
    return new Response(null, { status: 304, headers: base });
  }

  let range = parseRange(req.headers.get('range'), size);
  const ifRange = req.headers.get('if-range');
  if (range && ifRange && ifRange.trim() !== etag) range = null; // stale validator: full body

  const head = req.method === 'HEAD';
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
  }
  if (range) {
    const len = range.end - range.start + 1;
    const headers = { ...base, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': String(len) };
    return new Response(head ? null : nodeToWeb(path, range.start, range.end), { status: 206, headers });
  }
  const headers = { ...base, 'Content-Length': String(size) };
  if (head || size === 0) return new Response(null, { status: 200, headers });
  return new Response(nodeToWeb(path, 0, size - 1), { status: 200, headers });
}

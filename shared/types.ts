// The whole system speaks Items. Providers create them; the client renders them by kind.

export type ItemKind = 'folder' | 'video' | 'image' | 'audio' | 'app' | (string & {});

export interface Item {
  id: string; // "<providerId>:<opaque>", stable
  kind: ItemKind;
  title: string;
  parentId?: string;
  thumb?: string; // URL
  meta?: Record<string, unknown>;
}

/** What a paired device said it can decode natively (from canPlayType). */
export interface Caps {
  h264: boolean;
  hevc: boolean;
  vp9: boolean;
  av1: boolean;
  hls: boolean; // native HLS in <video>
}

export interface Device {
  id: string;
  name: string;
  caps: Caps;
}

export interface OpenCtx {
  req: Request;
  device: Device;
  /** 'main' streams the item itself, 'thumb' returns a small JPEG, 'sub' returns a WebVTT track. */
  variant: 'main' | 'thumb' | 'sub';
  query: URLSearchParams;
}

export interface Provider {
  id: string;
  list(parentId?: string): Promise<Item[]>;
  open(id: string, ctx: OpenCtx): Promise<Response>;
  watch?(onChange: () => void): () => void;
}

export interface ItemState {
  position: number;
  duration: number;
  watched: boolean;
  updatedAt: number;
}

export const NO_CAPS: Caps = { h264: false, hevc: false, vp9: false, av1: false, hls: false };

/** Optional capability: resolve Items by ID (used by cross-provider rows like Continue Watching). */
export interface ProviderWithGet extends Provider {
  get(ids: readonly string[]): Promise<Item[]>;
}

export function hasGet(p: Provider): p is ProviderWithGet {
  return typeof (p as Partial<ProviderWithGet>).get === 'function';
}

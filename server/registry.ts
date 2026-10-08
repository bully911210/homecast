// Providers by ID prefix. The core dispatches here and never looks inside an Item ID.
import { hasGet, type Item, type OpenCtx, type Provider } from '../shared/types.ts';
import { notFound } from './http.ts';

export class Registry {
  readonly #providers = new Map<string, Provider>();

  add(p: Provider): void {
    if (this.#providers.has(p.id)) throw new Error(`duplicate provider ${p.id}`);
    this.#providers.set(p.id, p);
  }

  #for(id: string): Provider {
    const p = this.#providers.get(id.slice(0, id.indexOf(':')));
    if (!p) throw notFound();
    return p;
  }

  async list(parentId?: string): Promise<Item[]> {
    if (parentId !== undefined) return this.#for(parentId).list(parentId);
    const all = await Promise.all([...this.#providers.values()].map((p) => p.list()));
    return all.flat();
  }

  open(id: string, ctx: OpenCtx): Promise<Response> {
    return this.#for(id).open(id, ctx);
  }

  has(id: string): boolean {
    return this.#providers.has(id.slice(0, id.indexOf(':')));
  }

  /** Resolve items by ID across providers, preserving order. Providers without get() are skipped. */
  async get(ids: readonly string[]): Promise<Item[]> {
    const byProvider = new Map<string, string[]>();
    for (const id of ids) {
      const pid = id.slice(0, id.indexOf(':'));
      byProvider.set(pid, [...(byProvider.get(pid) ?? []), id]);
    }
    const found = new Map<string, Item>();
    for (const [pid, list] of byProvider) {
      const p = this.#providers.get(pid);
      if (p && hasGet(p)) for (const it of await p.get(list)) found.set(it.id, it);
    }
    return ids.map((i) => found.get(i)).filter((x): x is Item => x !== undefined);
  }

  watchAll(onChange: () => void): () => void {
    const stops = [...this.#providers.values()].map((p) => p.watch?.(onChange)).filter((s): s is () => void => !!s);
    return () => stops.forEach((s) => s());
  }
}

// "home" provider: the Continue Watching row, built from playback state across all providers.
import type { Item, Provider } from '../../shared/types.ts';
import { notFound } from '../http.ts';
import type { Registry } from '../registry.ts';
import { inProgress, type Database } from '../store.ts';

const CONTINUE = 'home:continue';

export function createHomeProvider(db: Database, registry: Registry): Provider {
  return {
    id: 'home',
    async list(parentId?: string): Promise<Item[]> {
      if (parentId === undefined) {
        const any = (await registry.get(inProgress(db, 20))).length > 0;
        return any ? [{ id: CONTINUE, kind: 'folder', title: 'Continue Watching', meta: { row: true } }] : [];
      }
      if (parentId !== CONTINUE) throw notFound();
      return registry.get(inProgress(db, 20));
    },
    async open(): Promise<Response> {
      throw notFound();
    },
  };
}

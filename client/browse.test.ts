import { describe, expect, it } from 'vitest';
import type { Item } from '../shared/types.ts';
import { primaryActionLabel, subtitle } from './browse.ts';

const video = (meta: Item['meta']): Item => ({ id: 'fs:item', kind: 'video', title: 'Show S01E02', meta });

describe('browse playback actions', () => {
  it.each([
    [{}, 'Play'],
    [{ position: 60, duration: 600 }, 'Resume'],
    [{ position: 552, duration: 600 }, 'Play again'],
    [{ watched: true, position: 60, duration: 600 }, 'Play again'],
  ] as const)('labels progress %o', (meta, label) => {
    expect(primaryActionLabel(video(meta))).toBe(label);
  });

  it('shows episode identity in the subtitle', () => {
    expect(subtitle(video({ season: 1, episode: 2 }))).toContain('S01E02');
  });
});

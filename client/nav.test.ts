import { describe, expect, it } from 'vitest';
import { nearest, type Dir } from './nav.ts';
import { srtToVtt } from '../server/subs.ts';

const rect = (left: number, top: number, w = 100, h = 60): DOMRect =>
  ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

// A 3x2 grid plus a top-bar button on the right.
const tiles: Record<string, DOMRect> = {
  a: rect(0, 100), b: rect(120, 100), c: rect(240, 100),
  d: rect(0, 200), e: rect(120, 200), f: rect(240, 200),
  refresh: rect(400, 0, 60, 60),
};
const all = Object.entries(tiles).map(([k, r]) => ({ el: { id: k } as unknown as HTMLElement, r }));
const go = (from: string, dir: Dir): string | undefined =>
  (nearest(tiles[from]!, dir, all.filter((x) => (x.el as unknown as { id: string }).id !== from)) as unknown as { id: string } | null)?.id;

describe('spatial navigation', () => {
  it.each<[string, Dir, string | undefined]>([
    ['a', 'right', 'b'],
    ['b', 'down', 'e'],
    ['e', 'up', 'b'],
    ['f', 'left', 'e'],
    ['a', 'left', undefined],
    ['d', 'down', undefined],
    ['c', 'up', 'refresh'], // nothing straight above: falls back to the nearest thing up there
    ['refresh', 'left', undefined], // no tile shares the top bar's row, so left goes nowhere
    ['refresh', 'down', 'c'],
  ])('%s %s -> %s', (from, dir, want) => expect(go(from, dir)).toBe(want));
});

describe('subtitles', () => {
  it('SRT to WebVTT', () => {
    expect(srtToVtt('﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHi\r\n')).toBe('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHi\n');
  });
});

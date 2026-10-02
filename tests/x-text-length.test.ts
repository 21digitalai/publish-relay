import { describe, expect, it } from 'vitest';

import { validateXPostLength } from '../src/modules/providers/x-text-length.js';

describe('X weighted post length', () => {
  const text = (value: string) => ({ kind: 'text', text: value });

  it('enforces the standard and self-declared ceilings at their boundaries', () => {
    expect(() => {
      validateXPostLength(text('a'.repeat(280)), false);
    }).not.toThrow();
    expect(() => {
      validateXPostLength(text('a'.repeat(281)), false);
    }).toThrow(/limit is 280/);
    expect(() => {
      validateXPostLength(text('a'.repeat(25_000)), true);
    }).not.toThrow();
    expect(() => {
      validateXPostLength(text('a'.repeat(25_001)), true);
    }).toThrow(/limit is 25000/);
  });

  it('uses X URL, emoji, and non-Latin weighting instead of UTF-16 length', () => {
    expect(() => {
      validateXPostLength(text(`${'a'.repeat(257)} https://example.com/a`), false);
    }).toThrow();
    expect(() => {
      validateXPostLength(text(`${'a'.repeat(256)} https://example.com/a`), false);
    }).not.toThrow();
    expect(() => {
      validateXPostLength(text('😀'.repeat(141)), false);
    }).toThrow();
    expect(() => {
      validateXPostLength(text('Ж'.repeat(280)), false);
    }).not.toThrow();
    expect(() => {
      validateXPostLength(text('Ж'.repeat(281)), false);
    }).toThrow();
  });

  it('validates every thread part, including object parts', () => {
    expect(() => {
      validateXPostLength(
        {
          kind: 'thread',
          posts: [
            { text: 'First', mediaIds: [] },
            { text: 'x'.repeat(281), mediaIds: [] },
          ],
        },
        false,
      );
    }).toThrow(/limit is 280/);
    expect(() => {
      validateXPostLength(
        {
          kind: 'thread',
          posts: [
            { text: 'First', mediaIds: [] },
            { text: 'x'.repeat(281), mediaIds: [] },
          ],
        },
        true,
      );
    }).not.toThrow();
    expect(() => {
      validateXPostLength(
        { kind: 'thread', posts: ['First', { text: 'Second', mediaIds: [] }] },
        true,
      );
    }).toThrow(/consistent shape/);
  });
});

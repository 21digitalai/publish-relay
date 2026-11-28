import { describe, expect, it } from 'vitest';
import { summarizeConversationOrdering } from '../src/modules/providers/facebook-conversation-ordering.js';

const cutoff = '2026-11-27T00:00:00Z';
describe('raw conversation ordering observation', () => {
  it('supports cross-page consumer aggregation without counting local recent-after-old twice', () => {
    const pages = [
      [{ updatedAt: '2026-11-28T00:00:00Z' }, { updatedAt: '2026-11-26T00:00:00Z' }],
      [
        { updatedAt: cutoff },
        { updatedAt: null },
        { updatedAt: '2026-11-25T00:00:00Z' },
        { updatedAt: cutoff },
      ],
    ].map((rows) => summarizeConversationOrdering(rows, cutoff));
    let oldSeen = false;
    let last: string | null = null;
    let inversions = 0;
    let recentAfterOld = 0;
    let unknown = 0;
    for (const page of pages) {
      inversions += page.inversions;
      if (
        last &&
        page.firstValidTimestamp &&
        Date.parse(page.firstValidTimestamp) > Date.parse(last)
      )
        inversions++;
      recentAfterOld += oldSeen ? page.recentCount : page.recentAfterFirstOld;
      oldSeen ||= page.oldCount > 0;
      last = page.lastValidTimestamp ?? last;
      unknown += page.unknownCount;
    }
    expect({ inversions, recentAfterOld, unknown }).toEqual({
      inversions: 2,
      recentAfterOld: 2,
      unknown: 1,
    });
  });
  it('keeps the contract bounded and excludes every provider row field', () => {
    const rows = Array.from({ length: 100 }, () => ({
      updatedAt: '2026-11-26T00:00:00+0000',
      id: 'secret-id',
      displayName: 'private',
      text: 'private',
    }));
    const result = summarizeConversationOrdering(rows, cutoff);
    expect(result).toMatchObject({ rawCount: 100, oldCount: 100, firstOldPosition: 0 });
    expect(Object.keys(result).sort()).toEqual(
      [
        'cutoff',
        'rawCount',
        'recentCount',
        'oldCount',
        'unknownCount',
        'firstValidTimestamp',
        'lastValidTimestamp',
        'firstOldPosition',
        'inversions',
        'recentAfterFirstOld',
        'providerPageReads',
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toMatch(/secret|private|token|text|displayName/);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(512);
    expect(summarizeConversationOrdering([{ updatedAt: 'bad' }, {}], cutoff)).toMatchObject({
      unknownCount: 2,
      firstValidTimestamp: null,
      lastValidTimestamp: null,
      firstOldPosition: null,
    });
    expect(summarizeConversationOrdering([], cutoff)).toMatchObject({
      rawCount: 0,
      recentCount: 0,
    });
  });
});

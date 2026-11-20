import { describe, expect, it } from 'vitest';

import {
  MessageGroupValidationError,
  nextWaitingTailState,
  sampleMessageGroupDueAt,
  validateMessageGroupBubbles,
} from '../src/modules/engagement/message-group.js';

describe('message group contract', () => {
  it('keeps provider caps independent beneath the shared five-bubble ceiling', () => {
    expect(() => {
      validateMessageGroupBubbles(['1', '2', '3', '4'], {
        maximumBubbles: 4,
        maximumTextLength: 2_000,
      });
    }).not.toThrow();
    expect(() => {
      validateMessageGroupBubbles(['1', '2', '3', '4', '5'], {
        maximumBubbles: 4,
        maximumTextLength: 2_000,
      });
    }).toThrow(MessageGroupValidationError);
    expect(() => {
      validateMessageGroupBubbles(['1', '2', '3', '4', '5'], {
        maximumBubbles: 5,
        maximumTextLength: 2_000,
      });
    }).not.toThrow();
  });

  it('rejects empty, oversized, and policy-invalid groups', () => {
    const policy = { maximumBubbles: 4, maximumTextLength: 5 };
    expect(() => {
      validateMessageGroupBubbles([], policy);
    }).toThrow();
    expect(() => {
      validateMessageGroupBubbles(['   '], policy);
    }).toThrow();
    expect(() => {
      validateMessageGroupBubbles(['123456'], policy);
    }).toThrow();
    expect(() => {
      validateMessageGroupBubbles(['ok'], { ...policy, maximumBubbles: 6 });
    }).toThrow('Invalid message-group provider policy');
  });

  it('samples an explicit due window without moving its bounds', () => {
    const earliest = new Date('2026-11-20T10:01:00.000Z');
    const latest = new Date('2026-11-20T12:00:00.000Z');
    expect(sampleMessageGroupDueAt(earliest, latest, () => 0)).toEqual(earliest);
    expect(sampleMessageGroupDueAt(earliest, latest, () => 1)).toEqual(latest);
    expect(sampleMessageGroupDueAt(earliest, latest, () => 0.5).getTime()).toBeGreaterThan(
      earliest.getTime(),
    );
  });

  it('releases, freezes, or cancels waiting tails from terminal predecessor truth', () => {
    expect(nextWaitingTailState('confirmed')).toBe('pending');
    expect(nextWaitingTailState('unknown')).toBe('waiting');
    expect(nextWaitingTailState('failed')).toBe('cancelled');
    expect(nextWaitingTailState('cancelled')).toBe('cancelled');
  });
});

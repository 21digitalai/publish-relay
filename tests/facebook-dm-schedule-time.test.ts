import { describe, expect, it } from 'vitest';

import {
  chooseApprovedPageDmDueAt,
  PageDmScheduleWindowError,
} from '../src/modules/providers/facebook-dm-schedule-time.js';

const approvedAt = new Date('2026-11-05T14:54:00Z');
const windowDeadline = new Date('2026-11-05T17:00:00Z');
const delay = { earliestDelaySeconds: 300, latestDelaySeconds: 2700 };

describe('approved Page DM due time', () => {
  it('keeps an agent-selected future spread and adds the Page jitter after it', () => {
    const plannedDueAt = new Date('2026-11-05T16:05:00Z');
    expect(
      chooseApprovedPageDmDueAt({
        plannedDueAt,
        approvedAt,
        windowDeadline,
        ...delay,
        randomValue: 0,
      }).toISOString(),
    ).toBe('2026-11-05T16:10:00.000Z');
  });

  it('reanchors an elapsed plan to approval time and never sends immediately', () => {
    expect(
      chooseApprovedPageDmDueAt({
        plannedDueAt: new Date('2026-11-05T14:05:00Z'),
        approvedAt,
        windowDeadline,
        ...delay,
        randomValue: 0,
      }).toISOString(),
    ).toBe('2026-11-05T14:59:00.000Z');
  });

  it('clamps the maximum jitter to the verified window and rejects too-short windows', () => {
    const input = {
      plannedDueAt: approvedAt,
      approvedAt,
      windowDeadline: new Date('2026-11-05T15:00:00Z'),
      ...delay,
      randomValue: 0.999,
    };
    expect(chooseApprovedPageDmDueAt(input).toISOString()).toBe('2026-11-05T15:00:00.000Z');
    expect(() =>
      chooseApprovedPageDmDueAt({ ...input, windowDeadline: new Date('2026-11-05T14:58:59Z') }),
    ).toThrow(PageDmScheduleWindowError);
  });
});

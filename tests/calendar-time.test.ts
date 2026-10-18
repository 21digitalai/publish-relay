import { describe, expect, it } from 'vitest';

import { calendarDateKey, calendarTime, calendarZonedMidnight } from '../src/ui/calendar-time.js';

describe('calendar workspace timezone', () => {
  it('uses 23- and 25-hour Sofia days at DST boundaries', () => {
    const spring = calendarZonedMidnight('2026-03-29', 'Europe/Sofia');
    const springEnd = calendarZonedMidnight('2026-03-30', 'Europe/Sofia');
    const autumn = calendarZonedMidnight('2026-10-25', 'Europe/Sofia');
    const autumnEnd = calendarZonedMidnight('2026-10-26', 'Europe/Sofia');
    expect(spring.toISOString()).toBe('2026-03-28T22:00:00.000Z');
    expect(springEnd.getTime() - spring.getTime()).toBe(23 * 60 * 60_000);
    expect(autumn.toISOString()).toBe('2026-10-24T21:00:00.000Z');
    expect(autumnEnd.getTime() - autumn.getTime()).toBe(25 * 60 * 60_000);
    expect(calendarDateKey(new Date('2026-10-25T22:30:00Z'), 'Europe/Sofia')).toBe('2026-10-26');
  });

  it('keeps UTC workspace midnight and local hour exact', () => {
    expect(calendarZonedMidnight('2026-10-25', 'UTC').toISOString()).toBe(
      '2026-10-25T00:00:00.000Z',
    );
    expect(calendarTime('2026-10-25T01:30:00Z', 'Europe/Sofia')).toEqual({
      hour: 3,
      minute: 30,
    });
  });
});

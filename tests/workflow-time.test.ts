import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { matchingLocalInstants, offsetLabel } from '../src/ui/schedule-time.js';

describe('composer local-time resolution', () => {
  const originalTimezone = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = 'Europe/Sofia';
  });

  afterAll(() => {
    process.env.TZ = originalTimezone;
  });

  it('rejects a nonexistent spring-forward wall time', () => {
    expect(matchingLocalInstants('2027-03-28T03:30')).toEqual([]);
  });

  it('returns both exact instants for an autumn repeated wall time', () => {
    const matches = matchingLocalInstants('2027-10-31T03:30');
    expect(matches.map((match) => match.toISOString())).toEqual([
      '2027-10-31T00:30:00.000Z',
      '2027-10-31T01:30:00.000Z',
    ]);
    expect(matches.map(offsetLabel)).toEqual(['UTC+03:00', 'UTC+02:00']);
  });
});

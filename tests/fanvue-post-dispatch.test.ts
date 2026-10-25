import { describe, expect, it } from 'vitest';

import { FanvueRequestError } from '../src/modules/providers/fanvue-http-client.js';
import { classifyFanvuePostFailure } from '../src/modules/providers/fanvue-post-dispatch.service.js';
import { FanvuePostOutcomeUnknownError } from '../src/modules/providers/fanvue-post-client.js';

describe('Fanvue post failure classification', () => {
  const now = new Date('2026-10-25T10:00:00Z');

  it('never retries an ambiguous response, server error or transport loss', () => {
    expect(classifyFanvuePostFailure(new FanvuePostOutcomeUnknownError(), 1, now).outcome).toBe(
      'unknown',
    );
    expect(classifyFanvuePostFailure(new FanvueRequestError(502), 1, now).outcome).toBe('unknown');
    expect(classifyFanvuePostFailure(new Error('transport'), 1, now).outcome).toBe('unknown');
  });

  it('records definite provider rejection without unknown reconciliation', () => {
    expect(classifyFanvuePostFailure(new FanvueRequestError(400), 1, now)).toEqual({
      outcome: 'validation',
    });
    expect(classifyFanvuePostFailure(new FanvueRequestError(403), 1, now)).toEqual({
      outcome: 'auth',
    });
  });

  it('schedules only a bounded definite 429 retry', () => {
    const result = classifyFanvuePostFailure(new FanvueRequestError(429), 1, now, () => 0.5);
    expect(result.outcome).toBe('rate_limit');
    expect(result.retryAt?.getTime()).toBeGreaterThan(now.getTime());
  });
});

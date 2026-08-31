import { describe, expect, it } from 'vitest';

import { deriveJobIdempotencyKey } from '../src/modules/scheduler/job.repository.js';
import { calculateFullJitterDelay } from '../src/modules/scheduler/retry-policy.js';

describe('scheduler policy', () => {
  it('derives one stable key from immutable publication identity', () => {
    const input = { jobId: 'job', revisionId: 'revision', providerAccountId: 'account' };
    expect(deriveJobIdempotencyKey(input)).toBe(deriveJobIdempotencyKey(input));
    expect(deriveJobIdempotencyKey({ ...input, revisionId: 'other' })).not.toBe(
      deriveJobIdempotencyKey(input),
    );
  });

  it('uses bounded full jitter and respects retry hints', () => {
    const policy = { baseDelayMs: 1_000, maximumDelayMs: 10_000, maximumAttempts: 4 };
    expect(calculateFullJitterDelay(1, policy, () => 0.5)).toBe(500);
    expect(calculateFullJitterDelay(3, policy, () => 0.5, 3_000)).toBe(3_000);
    expect(calculateFullJitterDelay(4, policy, () => 0.5)).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';

import { publishPersistedReplacement } from '../src/modules/providers/x-remediation-dispatch.service.js';

describe('X remediation replacement dispatch composition', () => {
  it('recovers a durable published attempt without a second provider dispatch', async () => {
    const dispatchExact = vi.fn(() => Promise.resolve(1));
    await expect(
      publishPersistedReplacement(
        {
          findPublishedAttempt: vi.fn(() =>
            Promise.resolve({ attemptId: 'attempt-1', externalPostId: 'post-1' }),
          ),
          dispatchExact,
          externalUrl: (id) => `https://x.com/TheDailyViber/status/${id}`,
        },
        'job-1',
      ),
    ).resolves.toMatchObject({ jobId: 'job-1', attemptId: 'attempt-1', externalPostId: 'post-1' });
    expect(dispatchExact).not.toHaveBeenCalled();
  });

  it('fails closed after an uncertain exact-job outcome and never dispatches twice in one replay', async () => {
    const findPublishedAttempt = vi.fn(() => Promise.resolve(undefined));
    const dispatchExact = vi.fn(() => Promise.resolve(1));
    await expect(
      publishPersistedReplacement(
        {
          findPublishedAttempt,
          dispatchExact,
          externalUrl: (id) => `https://x.com/TheDailyViber/status/${id}`,
        },
        'job-1',
      ),
    ).rejects.toThrow('did not complete');
    expect(dispatchExact).toHaveBeenCalledTimes(1);
    expect(findPublishedAttempt).toHaveBeenCalledTimes(2);
  });
});

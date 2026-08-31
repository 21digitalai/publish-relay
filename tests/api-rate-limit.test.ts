import { describe, expect, it } from 'vitest';

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';

describe('API workspace and key rate limits', () => {
  it('enforces the stricter key bucket and resets after the bounded retry window', () => {
    const limiter = new ApiRateLimiter({
      workspace: 4,
      key: 2,
      mutationWorkspace: 2,
      mutationKey: 1,
      windowMs: 10_000,
    });
    expect(limiter.check('workspace-1', 'key-1', 'read', 1000)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(limiter.check('workspace-1', 'key-1', 'read', 1001)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(limiter.check('workspace-1', 'key-1', 'read', 1002)).toEqual({
      allowed: false,
      limit: 2,
      remaining: 0,
      retryAfterSeconds: 10,
    });
    expect(limiter.check('workspace-1', 'key-1', 'read', 11_001)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });

  it('shares workspace capacity across keys and keeps mutation buckets stricter', () => {
    const limiter = new ApiRateLimiter({
      workspace: 2,
      key: 2,
      mutationWorkspace: 1,
      mutationKey: 1,
      windowMs: 60_000,
    });
    expect(limiter.check('workspace-1', 'key-1', 'read', 0).allowed).toBe(true);
    expect(limiter.check('workspace-1', 'key-2', 'read', 1).allowed).toBe(true);
    expect(limiter.check('workspace-1', 'key-3', 'read', 2).allowed).toBe(false);
    expect(limiter.check('workspace-1', 'key-1', 'mutation', 3).allowed).toBe(true);
    expect(limiter.check('workspace-1', 'key-2', 'mutation', 4).allowed).toBe(false);
    expect(limiter.check('workspace-2', 'key-3', 'read', 5).allowed).toBe(true);
  });
});

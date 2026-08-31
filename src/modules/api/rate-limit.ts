export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds?: number;
}

interface Bucket {
  count: number;
  resetsAt: number;
}

export class ApiRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  public constructor(
    private readonly limits: {
      workspace: number;
      key: number;
      mutationWorkspace: number;
      mutationKey: number;
      windowMs: number;
    },
  ) {
    for (const [name, value] of Object.entries(limits))
      if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  }

  public check(
    workspaceId: string,
    keyId: string,
    kind: 'read' | 'mutation',
    now = Date.now(),
  ): RateLimitDecision {
    const workspaceLimit =
      kind === 'mutation' ? this.limits.mutationWorkspace : this.limits.workspace;
    const keyLimit = kind === 'mutation' ? this.limits.mutationKey : this.limits.key;
    const workspace = this.consume(`workspace:${kind}:${workspaceId}`, workspaceLimit, now);
    const key = this.consume(`key:${kind}:${workspaceId}:${keyId}`, keyLimit, now);
    const allowed = workspace.allowed && key.allowed;
    if (allowed)
      return {
        allowed: true,
        limit: Math.min(workspace.limit, key.limit),
        remaining: Math.min(workspace.remaining, key.remaining),
      };
    const retryAfterSeconds = Math.max(
      workspace.retryAfterSeconds ?? 0,
      key.retryAfterSeconds ?? 0,
    );
    return {
      allowed: false,
      limit: Math.min(workspace.limit, key.limit),
      remaining: 0,
      retryAfterSeconds,
    };
  }

  private consume(bucketKey: string, limit: number, now: number): RateLimitDecision {
    const existing = this.buckets.get(bucketKey);
    const bucket =
      !existing || existing.resetsAt <= now
        ? { count: 0, resetsAt: now + this.limits.windowMs }
        : existing;
    if (bucket.count >= limit)
      return {
        allowed: false,
        limit,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetsAt - now) / 1000)),
      };
    bucket.count += 1;
    this.buckets.set(bucketKey, bucket);
    return { allowed: true, limit, remaining: limit - bucket.count };
  }
}

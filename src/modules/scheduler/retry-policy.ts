export interface RetryPolicy {
  baseDelayMs: number;
  maximumDelayMs: number;
  maximumAttempts: number;
}

export function calculateFullJitterDelay(
  attemptNumber: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
  retryAfterMs?: number,
): number | null {
  if (attemptNumber >= policy.maximumAttempts) return null;
  const exponentialCap = Math.min(
    policy.maximumDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, attemptNumber - 1),
  );
  const jitteredDelay = Math.floor(random() * exponentialCap);
  return Math.min(policy.maximumDelayMs, Math.max(jitteredDelay, retryAfterMs ?? 0));
}

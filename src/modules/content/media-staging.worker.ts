import type { LocalMediaStorage } from './local-media-storage.js';

export function createMediaStagingReconciler(
  storage: Pick<LocalMediaStorage, 'cleanupStaleStaging'>,
  input: { staleMs: number; intervalMs: number },
): (now: Date) => Promise<number | undefined> {
  let nextRunAt = 0;

  return async (now: Date) => {
    if (now.getTime() < nextRunAt) return undefined;
    const deleted = await storage.cleanupStaleStaging({
      staleBefore: new Date(now.getTime() - input.staleMs),
    });
    nextRunAt = now.getTime() + input.intervalMs;
    return deleted;
  };
}

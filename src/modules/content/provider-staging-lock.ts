import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

interface AdvisoryLockClient {
  query(text: string, values: unknown[]): Promise<unknown>;
  release(): void;
}

interface AdvisoryLockPool {
  connect?: () => Promise<AdvisoryLockClient>;
}

const localStagingLocks = new Map<string, Promise<void>>();

export async function withProviderStagingLock<T>(
  database: NodePgDatabase,
  artifactId: string,
  work: () => Promise<T>,
): Promise<T> {
  const pool = (database as NodePgDatabase & { $client: AdvisoryLockPool }).$client;
  if (!pool.connect) return withLocalStagingLock(artifactId, work);
  const connection = await pool.connect();
  await connection.query('SELECT pg_advisory_lock(hashtext($1))', [artifactId]);
  try {
    return await work();
  } finally {
    await connection.query('SELECT pg_advisory_unlock(hashtext($1))', [artifactId]);
    connection.release();
  }
}

async function withLocalStagingLock<T>(artifactId: string, work: () => Promise<T>): Promise<T> {
  const previous = localStagingLocks.get(artifactId) ?? Promise.resolve();
  let releaseLock = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const queued = previous.then(() => current);
  localStagingLocks.set(artifactId, queued);
  await previous;
  try {
    return await work();
  } finally {
    releaseLock();
    if (localStagingLocks.get(artifactId) === queued) localStagingLocks.delete(artifactId);
  }
}

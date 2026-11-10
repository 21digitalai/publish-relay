import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** Serializes admission across the DM, comment and provider action ledgers. */
export async function lockFanvueActionNamespace(
  transaction: NodePgDatabase,
  workspaceId: string,
  clientActionId: string,
): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtext(${workspaceId}), hashtext(${clientActionId}))`,
  );
}

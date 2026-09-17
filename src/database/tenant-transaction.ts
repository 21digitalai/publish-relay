import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export interface TenantTransactionOptions {
  workspaceId: string;
  userId?: string;
}

export async function withTenantTransaction<T>(
  database: NodePgDatabase,
  options: TenantTransactionOptions,
  operation: (transaction: NodePgDatabase) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select set_config('app.workspace_id', ${options.workspaceId}, true)`,
    );
    await transaction.execute(sql`select set_config('app.user_id', ${options.userId ?? ''}, true)`);
    return operation(transaction);
  });
}

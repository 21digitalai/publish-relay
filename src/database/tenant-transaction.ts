import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export interface TenantTransactionOptions {
  workspaceId: string;
  userId?: string;
  machineActor?: {
    type: 'api-key' | 'delegated';
    id: string;
    capability: 'schedules:read' | 'schedules:write' | 'destinations:read';
  };
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
    if (options.machineActor) {
      await transaction.execute(
        sql`select set_config('app.machine_actor_type', ${options.machineActor.type}, true)`,
      );
      await transaction.execute(
        sql`select set_config('app.machine_actor_id', ${options.machineActor.id}, true)`,
      );
      await transaction.execute(
        sql`select set_config('app.machine_capability', ${options.machineActor.capability}, true)`,
      );
    }
    return operation(transaction);
  });
}

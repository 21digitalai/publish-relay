import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { browserMutationResults } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type {
  IdempotentMutationResult,
  StoredMutationResponse,
} from '../api/idempotency.repository.js';

export interface BrowserMutationInput {
  workspaceId: string;
  userId: string;
  operation: string;
  idempotencyKey: string;
  requestFingerprint: string;
}

export async function executeBrowserMutation(
  database: NodePgDatabase,
  input: BrowserMutationInput,
  mutation: (transaction: NodePgDatabase) => Promise<StoredMutationResponse>,
): Promise<IdempotentMutationResult> {
  return withTenantTransaction(database, input, async (transaction) => {
    const inserted = await transaction
      .insert(browserMutationResults)
      .values({ ...input, statusCode: 0, responseBody: {} })
      .onConflictDoNothing()
      .returning({ id: browserMutationResults.id });
    if (inserted[0]) {
      const response = await mutation(transaction);
      await transaction
        .update(browserMutationResults)
        .set({
          statusCode: response.statusCode,
          responseBody: response.body,
          updatedAt: new Date(),
        })
        .where(eq(browserMutationResults.id, inserted[0].id));
      return { kind: 'executed', response };
    }
    const rows = await transaction
      .select({
        requestFingerprint: browserMutationResults.requestFingerprint,
        statusCode: browserMutationResults.statusCode,
        responseBody: browserMutationResults.responseBody,
      })
      .from(browserMutationResults)
      .where(
        and(
          eq(browserMutationResults.workspaceId, input.workspaceId),
          eq(browserMutationResults.userId, input.userId),
          eq(browserMutationResults.operation, input.operation),
          eq(browserMutationResults.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    const stored = rows[0];
    if (!stored) throw new Error('Browser idempotency record disappeared');
    if (stored.requestFingerprint !== input.requestFingerprint) return { kind: 'conflict' };
    return {
      kind: 'replayed',
      response: { statusCode: stored.statusCode, body: stored.responseBody },
    };
  });
}

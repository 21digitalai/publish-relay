import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { apiMutationResults } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export interface StoredMutationResponse {
  statusCode: number;
  body: unknown;
}

export type IdempotentMutationResult =
  | { kind: 'executed'; response: StoredMutationResponse }
  | { kind: 'replayed'; response: StoredMutationResponse }
  | { kind: 'conflict' };

export interface IdempotentMutationInput {
  workspaceId: string;
  apiKeyId: string;
  operation: string;
  idempotencyKey: string;
  requestFingerprint: string;
}

export async function executeIdempotentMutation(
  database: NodePgDatabase,
  input: IdempotentMutationInput,
  mutation: (transaction: NodePgDatabase) => Promise<StoredMutationResponse>,
): Promise<IdempotentMutationResult> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const inserted = await transaction
        .insert(apiMutationResults)
        .values({
          workspaceId: input.workspaceId,
          apiKeyId: input.apiKeyId,
          operation: input.operation,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          statusCode: 0,
          responseBody: {},
        })
        .onConflictDoNothing()
        .returning({ id: apiMutationResults.id });

      if (inserted[0]) {
        const response = await mutation(transaction);
        await transaction
          .update(apiMutationResults)
          .set({
            statusCode: response.statusCode,
            responseBody: response.body,
            updatedAt: new Date(),
          })
          .where(eq(apiMutationResults.id, inserted[0].id));
        return { kind: 'executed', response };
      }

      const rows = await transaction
        .select({
          requestFingerprint: apiMutationResults.requestFingerprint,
          statusCode: apiMutationResults.statusCode,
          responseBody: apiMutationResults.responseBody,
        })
        .from(apiMutationResults)
        .where(
          and(
            eq(apiMutationResults.workspaceId, input.workspaceId),
            eq(apiMutationResults.apiKeyId, input.apiKeyId),
            eq(apiMutationResults.operation, input.operation),
            eq(apiMutationResults.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      const stored = rows[0];
      if (!stored) throw new Error('Idempotency record disappeared during conflict resolution');
      if (stored.requestFingerprint !== input.requestFingerprint) return { kind: 'conflict' };
      return {
        kind: 'replayed',
        response: { statusCode: stored.statusCode, body: stored.responseBody },
      };
    },
  );
}

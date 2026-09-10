import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { mutationFingerprint } from '../api/idempotency.js';
import type { MachinePrincipal } from '../identity/machine-auth.js';
import {
  findExternalDraft,
  getExternalDraftById,
  insertExternalDraft,
  type ExternalDraftRecord,
} from './external-draft.repository.js';

export class ExternalDraftConflictError extends Error {}
export class ExternalDraftValidationError extends Error {}

export interface CreateExternalDraftInput {
  externalId: string;
  mediaIds: string[];
  label?: string;
  returnUrl?: string;
}

export async function getExternalDraft(
  database: NodePgDatabase,
  principal: MachinePrincipal,
  draftId: string,
): Promise<ExternalDraftRecord | null> {
  return withTenantTransaction(database, { workspaceId: principal.workspaceId }, (transaction) =>
    getExternalDraftById(transaction, {
      workspaceId: principal.workspaceId,
      actorType: principal.kind === 'api-key' ? 'api_key' : 'delegated',
      actorId: principal.actorId,
      draftId,
    }),
  );
}

function validateInput(input: CreateExternalDraftInput): void {
  if (!input.externalId.trim() || input.externalId.length > 200)
    throw new ExternalDraftValidationError('externalId must contain 1 to 200 characters');
  if (input.mediaIds.length === 0 || input.mediaIds.length > 20)
    throw new ExternalDraftValidationError('mediaIds must contain 1 to 20 items');
  if (new Set(input.mediaIds).size !== input.mediaIds.length)
    throw new ExternalDraftValidationError('mediaIds must be unique');
  if (input.label && input.label.length > 200)
    throw new ExternalDraftValidationError('label must not exceed 200 characters');
  if (input.returnUrl) {
    try {
      const url = new URL(input.returnUrl);
      if (url.protocol !== 'https:')
        throw new ExternalDraftValidationError('returnUrl must use HTTPS');
    } catch (error) {
      if (error instanceof ExternalDraftValidationError) throw error;
      throw new ExternalDraftValidationError('returnUrl must be a valid HTTPS URL');
    }
  }
}

export async function createExternalDraft(
  database: NodePgDatabase,
  principal: MachinePrincipal,
  input: CreateExternalDraftInput & { requestId: string },
): Promise<{ draft: ExternalDraftRecord; replayed: boolean }> {
  validateInput(input);
  const normalized = {
    externalId: input.externalId.trim(),
    mediaIds: input.mediaIds,
    ...(input.label ? { label: input.label.trim() } : {}),
    ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
  };
  const requestFingerprint = mutationFingerprint(normalized);
  return withTenantTransaction(
    database,
    { workspaceId: principal.workspaceId },
    async (transaction) => {
      const identity = {
        workspaceId: principal.workspaceId,
        actorType: principal.kind === 'api-key' ? ('api_key' as const) : ('delegated' as const),
        actorId: principal.actorId,
        externalId: normalized.externalId,
      } as const;
      const existing = await findExternalDraft(transaction, identity);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint)
          throw new ExternalDraftConflictError();
        return { draft: existing, replayed: true };
      }
      const created = await insertExternalDraft(transaction, {
        ...identity,
        ...(principal.kind === 'delegated' ? { sourceClientId: principal.clientId } : {}),
        ...normalized,
        requestFingerprint,
        requestId: input.requestId,
      });
      if (created) return { draft: created, replayed: false };
      const raced = await findExternalDraft(transaction, identity);
      if (raced?.requestFingerprint === requestFingerprint) return { draft: raced, replayed: true };
      throw new ExternalDraftConflictError();
    },
  );
}

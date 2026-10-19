import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { schedulePreparedTikTokRevision } from '../content/post.repository.js';
import {
  allowAllActionPolicy,
  enforceWorkspaceAction,
  type ActionPolicy,
} from '../policy/action-policy.js';
import {
  TikTokConsentInvalidError,
  verifyTikTokPublicationConsentInTransaction,
} from './tiktok-consent.service.js';

export const tiktokScheduleRequestSchema = z.strictObject({
  postId: z.uuid(),
  revisionId: z.uuid(),
  accountId: z.uuid(),
  receiptId: z.uuid(),
  scheduledAt: z.iso.datetime({ offset: true }),
});
const commandSchema = tiktokScheduleRequestSchema.extend({
  workspaceId: z.uuid(),
  userId: z.uuid(),
  requestId: z.string().min(1),
  idempotencyKey: z.string().min(1),
});
export type TikTokScheduleCommand = z.input<typeof commandSchema>;

export async function scheduleTikTokDraft(
  database: NodePgDatabase,
  input: TikTokScheduleCommand,
  policy: ActionPolicy = allowAllActionPolicy,
): Promise<{ jobId: string }> {
  return withTenantTransaction(database, input, (transaction) =>
    scheduleTikTokDraftInTransaction(transaction, input, policy),
  );
}

export async function scheduleTikTokDraftInTransaction(
  transaction: NodePgDatabase,
  rawInput: TikTokScheduleCommand,
  policy: ActionPolicy = allowAllActionPolicy,
): Promise<{ jobId: string }> {
  const input = commandSchema.parse(rawInput);
  const scheduledAt = new Date(input.scheduledAt);
  if (scheduledAt <= new Date()) throw new TikTokConsentInvalidError();
  const workspace = await transaction.execute(sql`
    select id from workspaces where id = ${input.workspaceId} for update
  `);
  if (workspace.rows.length !== 1) throw new TikTokConsentInvalidError();
  const member = await transaction.execute(sql`
    select 1 from memberships where workspace_id = ${input.workspaceId}
      and user_id = ${input.userId} and role in ('owner', 'admin', 'editor')
  `);
  if (member.rows.length !== 1) throw new TikTokConsentInvalidError();
  const consent = await verifyTikTokPublicationConsentInTransaction(transaction, {
    workspaceId: input.workspaceId,
    postId: input.postId,
    revisionId: input.revisionId,
    accountId: input.accountId,
    receiptId: input.receiptId,
    actor: { type: 'user', id: input.userId },
  });
  await enforceWorkspaceAction(transaction, policy, {
    workspaceId: input.workspaceId,
    actor: { type: 'user', id: input.userId },
    action: 'publication.create',
    requestedProviderAccountIds: [input.accountId],
    request: {
      provider: 'tiktok',
      providerAccountIds: [input.accountId],
      scheduledAt,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  const jobId = await schedulePreparedTikTokRevision(transaction, {
    workspaceId: input.workspaceId,
    postId: input.postId,
    revisionId: input.revisionId,
    accountId: input.accountId,
    scheduledAt,
    actorId: input.userId,
    effectivePayload: {
      schemaVersion: 1,
      destinationProvider: 'tiktok',
      kind: 'video',
      caption: consent.caption,
      mediaId: consent.mediaId,
      mediaSha256: consent.mediaSha256,
      capabilitySnapshotId: consent.capabilitySnapshotId,
      credentialVersion: consent.credentialVersion,
      options: consent.options,
      musicUsageConfirmed: consent.musicUsageConfirmed,
      brandedContentPolicyConfirmed: consent.brandedContentPolicyConfirmed,
      declarationVersion: consent.declarationVersion,
      consentReceiptId: input.receiptId,
    },
  });
  return { jobId };
}

import { isDeepStrictEqual } from 'node:util';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { auditEvents, publicationJobEvents } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

const evidenceReference = z.string().trim().min(8).max(500);
const publishedEvidence = z.strictObject({
  outcome: z.literal('published'),
  attemptId: z.uuid(),
  providerRequestId: z.string().trim().min(1).max(200),
  source: z.enum(['provider_dashboard', 'provider_support', 'provider_api']),
  reference: evidenceReference,
  storyId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/),
  permalink: z.url().max(2048),
});
const failedEvidence = z.strictObject({
  outcome: z.literal('failed'),
  attemptId: z.uuid(),
  providerRequestId: z.string().trim().min(1).max(200),
  source: z.enum(['provider_dashboard', 'provider_support', 'provider_api']),
  reference: evidenceReference,
  finding: z.enum(['provider_rejected', 'verified_absent']),
});
export const snapchatStoryResolutionSchema = z.discriminatedUnion('outcome', [
  publishedEvidence,
  failedEvidence,
]);
export type SnapchatStoryResolution = z.infer<typeof snapchatStoryResolutionSchema>;

export class SnapchatStoryResolutionConflict extends Error {}
export class SnapchatStoryResolutionNotFound extends Error {}

interface JobRow extends Record<string, unknown> {
  id: string;
  state: string;
  attemptNumber: number;
  reconciliationRequired: boolean;
}

interface AttemptRow extends Record<string, unknown> {
  id: string;
  outcome: string | null;
  providerRequestId: string | null;
  externalPostId: string | null;
  externalUrl: string | null;
  reconciliationKey: string | null;
}

async function readLockedStory(transaction: NodePgDatabase, workspaceId: string, jobId: string) {
  const jobs = await transaction.execute<JobRow>(sql`
    select j.id, j.state, j.attempt_number as "attemptNumber",
      j.reconciliation_required as "reconciliationRequired"
    from publication_jobs j
    join provider_accounts a on a.workspace_id = j.workspace_id and a.id = j.provider_account_id
    where j.workspace_id = ${workspaceId} and j.id = ${jobId}
      and a.destination_provider = 'snapchat'
      and j.effective_payload->>'kind' in ('story_image', 'story_video')
    for update of j
  `);
  const job = jobs.rows[0];
  if (!job) throw new SnapchatStoryResolutionNotFound();
  const attempts = await transaction.execute<AttemptRow>(sql`
    select id, outcome, provider_request_id as "providerRequestId",
      external_post_id as "externalPostId", external_url as "externalUrl",
      reconciliation_key as "reconciliationKey"
    from publication_attempts where workspace_id = ${workspaceId}
      and job_id = ${jobId} and attempt_number = ${job.attemptNumber}
    for update
  `);
  const attempt = attempts.rows[0];
  if (!attempt) throw new SnapchatStoryResolutionConflict('Story attempt is unavailable');
  return { job, attempt };
}

async function verifyAdmin(transaction: NodePgDatabase, workspaceId: string, userId: string) {
  const rows = await transaction.execute(sql`
    select 1 from memberships where workspace_id = ${workspaceId} and user_id = ${userId}
      and role in ('owner', 'admin')
  `);
  if (rows.rows.length !== 1) throw new SnapchatStoryResolutionNotFound();
}

function normalizedEvidence(value: SnapchatStoryResolution): SnapchatStoryResolution {
  if (value.outcome === 'failed') return value;
  // The Story POST exposes only a request ID. Core has no authoritative
  // request-to-Story lookup, so a human-supplied URL cannot prove publication.
  throw new SnapchatStoryResolutionConflict('No verified Story correlation is available');
}

export async function resolveSnapchatStoryEvidence(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    userId: string;
    jobId: string;
    requestId: string;
    evidence: SnapchatStoryResolution;
    now?: Date;
  },
): Promise<{ outcome: 'published' | 'failed'; replayed: boolean }> {
  const evidence = normalizedEvidence(snapchatStoryResolutionSchema.parse(input.evidence));
  const now = input.now ?? new Date();
  return withTenantTransaction(database, input, async (transaction) => {
    await verifyAdmin(transaction, input.workspaceId, input.userId);
    const { job, attempt } = await readLockedStory(transaction, input.workspaceId, input.jobId);
    if (
      attempt.id !== evidence.attemptId ||
      attempt.providerRequestId !== evidence.providerRequestId ||
      attempt.reconciliationKey !== `snapchat:story:${input.jobId}`
    )
      throw new SnapchatStoryResolutionConflict(
        'Story evidence does not match the current attempt',
      );
    if (job.state === 'published' || job.state === 'failed') {
      const audits = await transaction.execute<{ evidence: unknown }>(sql`
        select metadata->'evidence' as evidence from audit_events
        where workspace_id = ${input.workspaceId} and target_type = 'publication_job'
          and target_id = ${input.jobId} and action = 'snapchat_story.manual_resolution'
        order by created_at desc, id desc limit 1
      `);
      if (job.state === evidence.outcome && isDeepStrictEqual(audits.rows[0]?.evidence, evidence))
        return { outcome: evidence.outcome, replayed: true };
      throw new SnapchatStoryResolutionConflict('Story outcome was already resolved differently');
    }
    if (job.state !== 'dispatching' || !job.reconciliationRequired || attempt.outcome !== 'unknown')
      throw new SnapchatStoryResolutionConflict('Story is not awaiting evidence resolution');
    const updated = await transaction.execute(sql`
      update publication_jobs set state = ${evidence.outcome}::publication_job_state,
        reconciliation_required = false, lease_owner = null, lease_expires_at = null,
        next_attempt_at = null, updated_at = ${now}
      where workspace_id = ${input.workspaceId} and id = ${input.jobId}
      returning id
    `);
    if (updated.rows.length !== 1) throw new SnapchatStoryResolutionConflict('Story job changed');
    await transaction.execute(sql`
      update publication_attempts set outcome = ${evidence.outcome === 'failed' ? 'permanent' : 'published'}::publication_attempt_outcome,
        external_post_id = ${evidence.outcome === 'published' ? evidence.storyId : null},
        external_url = ${evidence.outcome === 'published' ? evidence.permalink : null},
        finished_at = coalesce(finished_at, ${now}),
        redacted_error = ${evidence.outcome === 'failed' ? 'Verified provider rejection or absence' : null}
      where workspace_id = ${input.workspaceId} and id = ${attempt.id}
    `);
    const metadata = { evidence, actorId: input.userId, resolvedAt: now.toISOString() };
    await transaction.insert(publicationJobEvents).values({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      fromState: 'dispatching',
      toState: evidence.outcome,
      reason: 'snapchat_story_manual_resolution',
      metadata,
    });
    await transaction.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      actorType: 'user',
      actorId: input.userId,
      action: 'snapchat_story.manual_resolution',
      targetType: 'publication_job',
      targetId: input.jobId,
      requestId: input.requestId,
      metadata,
    });
    return { outcome: evidence.outcome, replayed: false };
  });
}

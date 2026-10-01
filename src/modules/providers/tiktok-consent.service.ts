import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { auditEvents } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

const privacySchema = z.enum([
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
]);
const optionsSchema = z.strictObject({
  privacyLevel: privacySchema,
  allowComment: z.boolean(),
  allowDuet: z.boolean(),
  allowStitch: z.boolean(),
  coverTimestampMs: z.number().int().nonnegative().optional(),
  commercialContent: z.enum(['none', 'own_brand', 'branded', 'both']),
  aiGenerated: z.boolean(),
});
const revisionContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('video'),
  caption: z.string(),
  mediaId: z.uuid(),
  options: optionsSchema,
});

// Browser D2b submits only these fields; tenancy and user come from its session.
export const tiktokConsentRequestSchema = z.strictObject({
  postId: z.uuid(),
  revisionId: z.uuid(),
  accountId: z.uuid(),
  capabilitySnapshotId: z.uuid(),
  options: optionsSchema,
  musicUsageConfirmed: z.literal(true),
  brandedContentPolicyConfirmed: z.boolean(),
});
export const tiktokConsentCommandSchema = tiktokConsentRequestSchema.extend({
  workspaceId: z.uuid(),
  userId: z.uuid(),
});
export type TikTokConsentCommand = z.input<typeof tiktokConsentCommandSchema>;

const receiptPayloadSchema = tiktokConsentCommandSchema
  .omit({
    musicUsageConfirmed: true,
  })
  .extend({
    schemaVersion: z.literal(1),
    mediaId: z.uuid(),
    mediaSha256: z.string().regex(/^[0-9a-f]{64}$/),
    credentialVersion: z.number().int().positive(),
    caption: z.string(),
    musicUsageConfirmed: z.literal(true),
    declarationVersion: z.literal(1),
  });

export class TikTokConsentInvalidError extends Error {
  public constructor() {
    super('TikTok publication consent is invalid; refresh the destination and confirm again');
  }
}

interface ConsentSource extends Record<string, unknown> {
  content: unknown;
  currentRevisionId: string;
  mediaId: string | null;
  mediaSha256: string | null;
  mediaDurationMs: number | null;
  mediaMimeType: string | null;
  accountId: string | null;
  connectionId: string | null;
  remoteAccountId: string | null;
  externalSubjectId: string | null;
  credentialVersion: number | null;
  snapshotId: string | null;
  snapshotConnectionId: string | null;
  snapshotSubjectId: string | null;
  snapshotCredentialVersion: number | null;
  privacyOptions: unknown;
  commentDisabled: boolean | null;
  duetDisabled: boolean | null;
  stitchDisabled: boolean | null;
  maxVideoDurationSeconds: number | null;
  fetchedAt: Date | null;
  expiresAt: Date | null;
}

function hashPayload(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonical(nested)]),
      );
    return item;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

async function readConsentSource(
  db: NodePgDatabase,
  input: {
    workspaceId: string;
    postId: string;
    revisionId: string;
    accountId: string;
    snapshotId: string;
  },
): Promise<ConsentSource> {
  const rows = await db.execute<ConsentSource>(sql`
    select r.content, latest.id as "currentRevisionId", rm.media_id as "mediaId",
      m.sha256 as "mediaSha256", m.duration_ms as "mediaDurationMs", m.mime_type as "mediaMimeType",
      a.id as "accountId", a.connection_id as "connectionId", a.remote_account_id as "remoteAccountId",
      c.external_subject_id as "externalSubjectId", credential.version as "credentialVersion",
      s.id as "snapshotId", s.connection_id as "snapshotConnectionId",
      s.external_subject_id as "snapshotSubjectId",
      s.credential_version as "snapshotCredentialVersion", s.privacy_options as "privacyOptions",
      s.comment_disabled as "commentDisabled", s.duet_disabled as "duetDisabled",
      s.stitch_disabled as "stitchDisabled", s.max_video_duration_seconds as "maxVideoDurationSeconds",
      s.fetched_at as "fetchedAt", s.expires_at as "expiresAt"
    from post_revisions r
    join lateral (select id from post_revisions where workspace_id = r.workspace_id
      and post_id = r.post_id order by revision_number desc limit 1) latest on true
    left join revision_media rm on rm.workspace_id = r.workspace_id and rm.revision_id = r.id
    left join media_objects m on m.workspace_id = rm.workspace_id and m.id = rm.media_id
      and m.state = 'ready' and m.deleted_at is null
    left join provider_accounts a on a.workspace_id = r.workspace_id and a.id = ${input.accountId}
      and a.destination_provider = 'tiktok' and a.availability = 'active'
      and a.disconnected_at is null
    left join provider_connections c on c.workspace_id = a.workspace_id and c.id = a.connection_id
      and c.provider = 'tiktok' and c.status = 'active' and c.revoked_at is null
      and c.scopes ? 'video.publish' and c.refresh_expires_at > now()
    left join credentials credential on credential.workspace_id = c.workspace_id
      and credential.id = c.credential_id and credential.revoked_at is null
    left join provider_capability_snapshots s on s.workspace_id = r.workspace_id
      and s.id = ${input.snapshotId} and s.account_id = a.id
    where r.workspace_id = ${input.workspaceId} and r.post_id = ${input.postId}
      and r.id = ${input.revisionId}
    order by rm.position
  `);
  if (rows.rows.length !== 1) throw new TikTokConsentInvalidError();
  const row = rows.rows[0];
  if (!row) throw new TikTokConsentInvalidError();
  return {
    ...row,
    fetchedAt: row.fetchedAt ? new Date(row.fetchedAt) : null,
    expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
  };
}

async function lockAccountGrant(db: NodePgDatabase, workspaceId: string, accountId: string) {
  const locked = await db.execute(sql`select c.id from provider_connections c
    join provider_accounts a on a.workspace_id = c.workspace_id and a.connection_id = c.id
    where a.workspace_id = ${workspaceId} and a.id = ${accountId}
      and a.destination_provider = 'tiktok' and c.provider = 'tiktok'
    for update of c`);
  if (locked.rows.length !== 1) throw new TikTokConsentInvalidError();
}

function validateSource(source: ConsentSource, input: TikTokConsentCommand, now: Date) {
  const content = revisionContentSchema.safeParse(source.content);
  if (!content.success || source.currentRevisionId !== input.revisionId)
    throw new TikTokConsentInvalidError();
  if (
    !source.accountId ||
    !source.connectionId ||
    !source.credentialVersion ||
    source.remoteAccountId !== source.externalSubjectId ||
    !source.snapshotId ||
    source.snapshotConnectionId !== source.connectionId ||
    source.snapshotSubjectId !== source.externalSubjectId ||
    source.snapshotCredentialVersion !== source.credentialVersion ||
    !source.fetchedAt ||
    source.fetchedAt > now ||
    !source.expiresAt ||
    source.expiresAt <= now ||
    !source.mediaId ||
    source.mediaId !== content.data.mediaId ||
    !source.mediaSha256 ||
    !/^[0-9a-f]{64}$/.test(source.mediaSha256) ||
    source.mediaMimeType !== 'video/mp4' ||
    source.mediaDurationMs === null ||
    source.mediaDurationMs <= 0 ||
    !source.maxVideoDurationSeconds ||
    source.mediaDurationMs > source.maxVideoDurationSeconds * 1000
  )
    throw new TikTokConsentInvalidError();
  if (JSON.stringify(content.data.options) !== JSON.stringify(input.options))
    throw new TikTokConsentInvalidError();
  if (
    !Array.isArray(source.privacyOptions) ||
    !source.privacyOptions.includes(input.options.privacyLevel) ||
    (source.commentDisabled && input.options.allowComment) ||
    (source.duetDisabled && input.options.allowDuet) ||
    (source.stitchDisabled && input.options.allowStitch)
  )
    throw new TikTokConsentInvalidError();
  const branded =
    input.options.commercialContent === 'branded' || input.options.commercialContent === 'both';
  if (
    branded &&
    (input.options.privacyLevel !== 'PUBLIC_TO_EVERYONE' || !input.brandedContentPolicyConfirmed)
  )
    throw new TikTokConsentInvalidError();
  if (!branded && input.brandedContentPolicyConfirmed) throw new TikTokConsentInvalidError();
  return content.data;
}

export async function issueTikTokPublicationConsent(
  database: NodePgDatabase,
  rawInput: TikTokConsentCommand,
  now = new Date(),
): Promise<{ id: string; payloadHash: string; consentedAt: string }> {
  const input = tiktokConsentCommandSchema.parse(rawInput);
  return withTenantTransaction(database, input, async (transaction) => {
    // Post mutations lock the workspace first; retain that order across consent issuance.
    const workspace = await transaction.execute(
      sql`select id from workspaces where id = ${input.workspaceId} for update`,
    );
    if (workspace.rows.length !== 1) throw new TikTokConsentInvalidError();
    const member =
      await transaction.execute(sql`select 1 from memberships where workspace_id = ${input.workspaceId}
      and user_id = ${input.userId} and role in ('owner', 'admin', 'editor')`);
    if (member.rows.length !== 1) throw new TikTokConsentInvalidError();
    await lockAccountGrant(transaction, input.workspaceId, input.accountId);
    const source = await readConsentSource(transaction, {
      workspaceId: input.workspaceId,
      postId: input.postId,
      revisionId: input.revisionId,
      accountId: input.accountId,
      snapshotId: input.capabilitySnapshotId,
    });
    const content = validateSource(source, input, now);
    const payload = {
      schemaVersion: 1,
      workspaceId: input.workspaceId,
      userId: input.userId,
      postId: input.postId,
      revisionId: input.revisionId,
      accountId: input.accountId,
      mediaId: source.mediaId,
      mediaSha256: source.mediaSha256,
      capabilitySnapshotId: input.capabilitySnapshotId,
      credentialVersion: source.credentialVersion,
      caption: content.caption,
      options: content.options,
      musicUsageConfirmed: true,
      brandedContentPolicyConfirmed: input.brandedContentPolicyConfirmed,
      declarationVersion: 1,
    };
    const payloadHash = hashPayload(payload);
    const saved = await transaction.execute<{ id: string; consentedAt: Date }>(sql`
      insert into publication_consents (workspace_id, user_id, post_id, revision_id, account_id,
        media_id, media_sha256, capability_snapshot_id, credential_version,
        declaration_version, payload, payload_hash, consented_at)
      values (${input.workspaceId}, ${input.userId}, ${input.postId}, ${input.revisionId},
        ${input.accountId}, ${source.mediaId}, ${source.mediaSha256}, ${input.capabilitySnapshotId},
        ${source.credentialVersion}, 1, ${JSON.stringify(payload)}::jsonb, ${payloadHash}, ${now})
      returning id, consented_at as "consentedAt"
    `);
    const receipt = saved.rows[0];
    if (!receipt) throw new Error('TikTok consent insert returned no record');
    await transaction.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      actorType: 'user',
      actorId: input.userId,
      action: 'publication.consent',
      targetType: 'publication_consent',
      targetId: receipt.id,
      requestId: receipt.id,
      metadata: {
        postId: input.postId,
        revisionId: input.revisionId,
        accountId: input.accountId,
        payloadHash,
      },
    });
    return {
      id: receipt.id,
      payloadHash,
      consentedAt: new Date(receipt.consentedAt).toISOString(),
    };
  });
}

// Scheduling/dispatch must call this server-side. A caller-supplied UUID is never authority.
export async function verifyTikTokPublicationConsent(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    userId: string;
    postId: string;
    revisionId: string;
    accountId: string;
    receiptId: string;
    actorType: 'user' | 'api-key' | 'delegated';
  },
): Promise<z.infer<typeof receiptPayloadSchema>> {
  if (input.actorType !== 'user') throw new TikTokConsentInvalidError();
  return withTenantTransaction(database, input, async (transaction) => {
    const member = await transaction.execute(sql`select 1 from memberships
      where workspace_id = ${input.workspaceId} and user_id = ${input.userId}
        and role in ('owner', 'admin', 'editor')`);
    if (member.rows.length !== 1) throw new TikTokConsentInvalidError();
    await lockAccountGrant(transaction, input.workspaceId, input.accountId);
    const receipt = await transaction.execute<{
      payload: unknown;
      payloadHash: string;
      userId: string;
      mediaSha256: string;
      credentialVersion: number;
      consentedAt: Date;
    }>(sql`select payload, payload_hash as "payloadHash", user_id as "userId",
      media_sha256 as "mediaSha256", credential_version as "credentialVersion",
      consented_at as "consentedAt" from publication_consents
      where workspace_id = ${input.workspaceId} and id = ${input.receiptId}
        and post_id = ${input.postId} and revision_id = ${input.revisionId}
        and account_id = ${input.accountId}`);
    const row = receipt.rows[0];
    const parsed = receiptPayloadSchema.safeParse(row?.payload);
    if (
      !row ||
      !parsed.success ||
      row.userId !== input.userId ||
      hashPayload(parsed.data) !== row.payloadHash ||
      parsed.data.mediaSha256 !== row.mediaSha256 ||
      parsed.data.credentialVersion !== row.credentialVersion ||
      parsed.data.workspaceId !== input.workspaceId ||
      parsed.data.userId !== input.userId ||
      parsed.data.postId !== input.postId ||
      parsed.data.revisionId !== input.revisionId ||
      parsed.data.accountId !== input.accountId
    )
      throw new TikTokConsentInvalidError();
    const source = await readConsentSource(transaction, {
      workspaceId: input.workspaceId,
      postId: input.postId,
      revisionId: input.revisionId,
      accountId: input.accountId,
      snapshotId: parsed.data.capabilitySnapshotId,
    });
    const content = validateSource(source, parsed.data, new Date(row.consentedAt));
    if (
      source.mediaSha256 !== row.mediaSha256 ||
      source.credentialVersion !== row.credentialVersion ||
      content.caption !== parsed.data.caption
    )
      throw new TikTokConsentInvalidError();
    return parsed.data;
  });
}

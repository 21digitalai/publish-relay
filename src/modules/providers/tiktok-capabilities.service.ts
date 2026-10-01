import { and, eq, isNull, lt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  credentials,
  providerAccounts,
  providerCapabilitySnapshots,
  providerConnections,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import { getFreshTikTokTokenWithVersion } from './tiktok-credential.service.js';
import type { TikTokHttpClient, TikTokPrivacy } from './tiktok-http-client.js';

const SNAPSHOT_LIFETIME_MS = 15 * 60_000;
const RETENTION_MS = 24 * 60 * 60_000;

export class TikTokCapabilityUnavailableError extends Error {
  public constructor() {
    super('TikTok destination is unavailable; reconnect or refresh this account');
  }
}

export interface TikTokCapabilitySnapshot {
  id: string;
  accountId: string;
  nickname: string;
  privacyOptions: TikTokPrivacy[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoDurationSeconds: number;
  fetchedAt: string;
  expiresAt: string;
}

export async function getUsableTikTokCapabilitySnapshot(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; snapshotId: string; now?: Date },
): Promise<TikTokCapabilitySnapshot> {
  const now = input.now ?? new Date();
  const account = await eligibleAccount(database, input.workspaceId, input.accountId, now);
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const rows = await transaction
        .select({
          id: providerCapabilitySnapshots.id,
          accountId: providerCapabilitySnapshots.accountId,
          connectionId: providerCapabilitySnapshots.connectionId,
          externalSubjectId: providerCapabilitySnapshots.externalSubjectId,
          credentialVersion: providerCapabilitySnapshots.credentialVersion,
          nickname: providerCapabilitySnapshots.nickname,
          privacyOptions: providerCapabilitySnapshots.privacyOptions,
          commentDisabled: providerCapabilitySnapshots.commentDisabled,
          duetDisabled: providerCapabilitySnapshots.duetDisabled,
          stitchDisabled: providerCapabilitySnapshots.stitchDisabled,
          maxVideoDurationSeconds: providerCapabilitySnapshots.maxVideoDurationSeconds,
          fetchedAt: providerCapabilitySnapshots.fetchedAt,
          expiresAt: providerCapabilitySnapshots.expiresAt,
        })
        .from(providerCapabilitySnapshots)
        .where(
          and(
            eq(providerCapabilitySnapshots.workspaceId, input.workspaceId),
            eq(providerCapabilitySnapshots.accountId, input.accountId),
            eq(providerCapabilitySnapshots.id, input.snapshotId),
          ),
        )
        .limit(1);
      const snapshot = rows[0];
      if (
        !snapshot ||
        snapshot.expiresAt <= now ||
        snapshot.fetchedAt > now ||
        snapshot.connectionId !== account.connectionId ||
        snapshot.externalSubjectId !== account.openId ||
        snapshot.credentialVersion !== account.credentialVersion
      )
        throw new TikTokCapabilityUnavailableError();
      return {
        id: snapshot.id,
        accountId: snapshot.accountId,
        nickname: snapshot.nickname,
        privacyOptions: snapshot.privacyOptions as TikTokPrivacy[],
        commentDisabled: snapshot.commentDisabled,
        duetDisabled: snapshot.duetDisabled,
        stitchDisabled: snapshot.stitchDisabled,
        maxVideoDurationSeconds: snapshot.maxVideoDurationSeconds,
        fetchedAt: snapshot.fetchedAt.toISOString(),
        expiresAt: snapshot.expiresAt.toISOString(),
      };
    },
  );
}

async function eligibleAccount(
  database: NodePgDatabase,
  workspaceId: string,
  accountId: string,
  now: Date,
) {
  return withTenantTransaction(database, { workspaceId }, async (transaction) => {
    const rows = await transaction
      .select({
        connectionId: providerConnections.id,
        openId: providerConnections.externalSubjectId,
        remoteAccountId: providerAccounts.remoteAccountId,
        credentialVersion: credentials.version,
        scopes: providerConnections.scopes,
        accessExpiresAt: providerConnections.accessExpiresAt,
        refreshExpiresAt: providerConnections.refreshExpiresAt,
      })
      .from(providerAccounts)
      .innerJoin(
        providerConnections,
        and(
          eq(providerConnections.workspaceId, providerAccounts.workspaceId),
          eq(providerConnections.id, providerAccounts.connectionId),
        ),
      )
      .innerJoin(
        credentials,
        and(
          eq(credentials.workspaceId, providerConnections.workspaceId),
          eq(credentials.id, providerConnections.credentialId),
        ),
      )
      .where(
        and(
          eq(providerAccounts.workspaceId, workspaceId),
          eq(providerAccounts.id, accountId),
          eq(providerAccounts.destinationProvider, 'tiktok'),
          eq(providerAccounts.availability, 'active'),
          isNull(providerAccounts.disconnectedAt),
          eq(providerConnections.provider, 'tiktok'),
          eq(providerConnections.status, 'active'),
          isNull(providerConnections.revokedAt),
          isNull(credentials.revokedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (
      !row ||
      !Array.isArray(row.scopes) ||
      !row.scopes.includes('video.publish') ||
      !row.openId ||
      row.openId.startsWith('legacy:') ||
      row.remoteAccountId !== row.openId ||
      row.refreshExpiresAt === null ||
      row.refreshExpiresAt <= now
    )
      throw new TikTokCapabilityUnavailableError();
    return row;
  });
}

export async function fetchTikTokCapabilitySnapshot(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: TikTokHttpClient,
  input: { workspaceId: string; accountId: string; requestId: string; now?: Date },
): Promise<TikTokCapabilitySnapshot> {
  const now = input.now ?? new Date();
  const initial = await eligibleAccount(database, input.workspaceId, input.accountId, now);
  const tokenGrant = await getFreshTikTokTokenWithVersion(database, keys, client, {
    workspaceId: input.workspaceId,
    openId: initial.openId,
    requestId: input.requestId,
    now,
  });
  const current = await eligibleAccount(database, input.workspaceId, input.accountId, now);
  if (
    current.connectionId !== initial.connectionId ||
    current.openId !== tokenGrant.token.open_id ||
    current.credentialVersion !== tokenGrant.credentialVersion
  )
    throw new TikTokCapabilityUnavailableError();
  const { creator, logId } = await client.creatorInfoWithLog(tokenGrant.token.access_token);
  const fetchedAt = input.now ?? new Date();
  const expiresAt = new Date(fetchedAt.getTime() + SNAPSHOT_LIFETIME_MS);
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      // Serialize against reconnect, revoke, and rotation before writing provider facts.
      const locked = await transaction
        .select({ id: providerConnections.id })
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.workspaceId, input.workspaceId),
            eq(providerConnections.id, current.connectionId),
          ),
        )
        .for('update')
        .limit(1);
      if (!locked[0]) throw new TikTokCapabilityUnavailableError();
      const valid = await eligibleAccount(
        transaction,
        input.workspaceId,
        input.accountId,
        fetchedAt,
      );
      if (
        valid.connectionId !== current.connectionId ||
        valid.openId !== current.openId ||
        valid.credentialVersion !== current.credentialVersion
      )
        throw new TikTokCapabilityUnavailableError();
      await transaction
        .delete(providerCapabilitySnapshots)
        .where(
          and(
            eq(providerCapabilitySnapshots.workspaceId, input.workspaceId),
            lt(providerCapabilitySnapshots.expiresAt, new Date(fetchedAt.getTime() - RETENTION_MS)),
          ),
        );
      const rows = await transaction
        .insert(providerCapabilitySnapshots)
        .values({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          connectionId: current.connectionId,
          externalSubjectId: current.openId,
          credentialVersion: current.credentialVersion,
          nickname: creator.creator_nickname,
          privacyOptions: creator.privacy_level_options,
          commentDisabled: creator.comment_disabled,
          duetDisabled: creator.duet_disabled,
          stitchDisabled: creator.stitch_disabled,
          maxVideoDurationSeconds: creator.max_video_post_duration_sec,
          providerLogId: logId ?? null,
          fetchedAt,
          expiresAt,
        })
        .returning({ id: providerCapabilitySnapshots.id });
      const id = rows[0]?.id;
      if (!id) throw new Error('TikTok capability snapshot insert returned no record');
      return {
        id,
        accountId: input.accountId,
        nickname: creator.creator_nickname,
        privacyOptions: creator.privacy_level_options,
        commentDisabled: creator.comment_disabled,
        duetDisabled: creator.duet_disabled,
        stitchDisabled: creator.stitch_disabled,
        maxVideoDurationSeconds: creator.max_video_post_duration_sec,
        fetchedAt: fetchedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
    },
  );
}

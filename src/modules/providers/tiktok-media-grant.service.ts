import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import { and, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  mediaObjects,
  providerAccounts,
  providerConnections,
  providerMediaGrants,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

const GRANT_VALIDITY_MS = 91 * 60 * 1000;
const TOKEN_VERSION = 'v1';
const TOKEN_CONTEXT = 'publish-relay:tiktok-media-grant:v1';

interface GrantIdentity {
  workspaceId: string;
  grantId: string;
}

function uuidBytes(value: string): Buffer {
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function bytesUuid(value: Buffer): string {
  const hex = value.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface TikTokMediaGrant {
  storageKey: string;
  sha256: string;
  mimeType: string;
  byteSize: number;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function equalHash(first: string, second: string): boolean {
  const left = Buffer.from(first, 'hex');
  const right = Buffer.from(second, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export class TikTokMediaGrantService {
  private readonly key: Buffer;

  public constructor(
    private readonly database: NodePgDatabase,
    secret: Buffer,
  ) {
    if (secret.byteLength < 32)
      throw new Error('Media grant signing secret must be at least 32 bytes');
    this.key = createHmac('sha256', secret).update(TOKEN_CONTEXT).digest();
  }

  private issueToken(identity: GrantIdentity): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(TOKEN_VERSION));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.concat([uuidBytes(identity.workspaceId), uuidBytes(identity.grantId)])),
      cipher.final(),
    ]);
    return [
      TOKEN_VERSION,
      nonce.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  private decodeToken(token: string): GrantIdentity | null {
    try {
      const [version, nonceValue, bodyValue, tagValue, extra] = token.split('.');
      if (version !== TOKEN_VERSION || !nonceValue || !bodyValue || !tagValue || extra) return null;
      const nonce = Buffer.from(nonceValue, 'base64url');
      if (nonce.length !== 12) return null;
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAAD(Buffer.from(TOKEN_VERSION));
      decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
      const value = Buffer.concat([
        decipher.update(Buffer.from(bodyValue, 'base64url')),
        decipher.final(),
      ]);
      if (value.length !== 32) return null;
      return {
        workspaceId: bytesUuid(value.subarray(0, 16)),
        grantId: bytesUuid(value.subarray(16)),
      };
    } catch {
      return null;
    }
  }

  public async issue(input: {
    workspaceId: string;
    accountId: string;
    mediaId: string;
    publicOrigin: string;
    now?: Date;
  }): Promise<{ id: string; url: string; expiresAt: Date }> {
    const origin = new URL(input.publicOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password)
      throw new Error('TikTok media delivery requires an HTTPS origin');
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + GRANT_VALIDITY_MS);
    const id = randomUUID();
    const token = this.issueToken({ workspaceId: input.workspaceId, grantId: id });
    await withTenantTransaction(this.database, input, async (transaction) => {
      const [account] = await transaction
        .select({ id: providerAccounts.id })
        .from(providerAccounts)
        .innerJoin(
          providerConnections,
          and(
            eq(providerConnections.workspaceId, providerAccounts.workspaceId),
            eq(providerConnections.id, providerAccounts.connectionId),
          ),
        )
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.id, input.accountId),
            eq(providerAccounts.destinationProvider, 'tiktok'),
            eq(providerAccounts.availability, 'active'),
            isNull(providerAccounts.disconnectedAt),
            eq(providerConnections.status, 'active'),
            isNull(providerConnections.revokedAt),
          ),
        )
        .limit(1);
      const [media] = await transaction
        .select({
          sha256: mediaObjects.sha256,
          mimeType: mediaObjects.mimeType,
          byteSize: mediaObjects.byteSize,
        })
        .from(mediaObjects)
        .where(
          and(
            eq(mediaObjects.workspaceId, input.workspaceId),
            eq(mediaObjects.id, input.mediaId),
            eq(mediaObjects.state, 'ready'),
            isNotNull(mediaObjects.retainedAt),
            isNull(mediaObjects.deletedAt),
          ),
        )
        .limit(1)
        .for('update');
      if (!account?.id || media?.mimeType !== 'video/mp4' || media.byteSize <= 0)
        throw new Error('TikTok account or retained video is unavailable');
      await transaction.insert(providerMediaGrants).values({
        id,
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        mediaId: input.mediaId,
        tokenHash: hashToken(token),
        mediaSha256: media.sha256,
        mimeType: media.mimeType,
        byteSize: media.byteSize,
        expiresAt,
        createdAt: now,
      });
    });
    return {
      id,
      url: new URL(`/provider-media/tiktok/${id}/${token}`, origin.origin).toString(),
      expiresAt,
    };
  }

  public async resolve(
    id: string,
    token: string,
    now = new Date(),
  ): Promise<TikTokMediaGrant | null> {
    const identity = this.decodeToken(token);
    if (identity?.grantId !== id) return null;
    return withTenantTransaction(this.database, identity, async (transaction) => {
      const [row] = await transaction
        .select({
          tokenHash: providerMediaGrants.tokenHash,
          sha256: providerMediaGrants.mediaSha256,
          mimeType: providerMediaGrants.mimeType,
          byteSize: providerMediaGrants.byteSize,
          storageKey: mediaObjects.storageKey,
          currentSha256: mediaObjects.sha256,
          currentMimeType: mediaObjects.mimeType,
          currentByteSize: mediaObjects.byteSize,
        })
        .from(providerMediaGrants)
        .innerJoin(
          mediaObjects,
          and(
            eq(mediaObjects.workspaceId, providerMediaGrants.workspaceId),
            eq(mediaObjects.id, providerMediaGrants.mediaId),
          ),
        )
        .where(
          and(
            eq(providerMediaGrants.workspaceId, identity.workspaceId),
            eq(providerMediaGrants.id, id),
            gt(providerMediaGrants.expiresAt, now),
            isNull(providerMediaGrants.revokedAt),
            eq(mediaObjects.state, 'ready'),
            isNull(mediaObjects.deletedAt),
          ),
        )
        .limit(1);
      if (
        !row ||
        !equalHash(row.tokenHash, hashToken(token)) ||
        row.sha256 !== row.currentSha256 ||
        row.mimeType !== row.currentMimeType ||
        row.byteSize !== row.currentByteSize
      )
        return null;
      return {
        storageKey: row.storageKey,
        sha256: row.sha256,
        mimeType: row.mimeType,
        byteSize: row.byteSize,
      };
    });
  }

  public async revoke(input: {
    workspaceId: string;
    accountId: string;
    grantId: string;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    return withTenantTransaction(this.database, input, async (transaction) => {
      const rows = await transaction
        .update(providerMediaGrants)
        .set({ revokedAt: now })
        .where(
          and(
            eq(providerMediaGrants.workspaceId, input.workspaceId),
            eq(providerMediaGrants.accountId, input.accountId),
            eq(providerMediaGrants.id, input.grantId),
            isNull(providerMediaGrants.revokedAt),
          ),
        )
        .returning({ id: providerMediaGrants.id });
      return rows.length > 0;
    });
  }
}

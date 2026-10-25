import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerAccounts, providerConnections } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { getActiveCredential, rotateCredential } from '../credentials/credential.repository.js';
import {
  decryptCredential,
  encryptCredential,
  type MasterKeyProvider,
} from '../credentials/envelope.js';
import {
  assertFanvuePublishingScopes,
  fanvueTokenSchema,
  FanvueRequestError,
  type FanvueHttpClient,
  type FanvueToken,
} from './fanvue-http-client.js';

const REFRESH_SKEW_MS = 5 * 60_000;

async function markReconnection(
  transaction: NodePgDatabase,
  input: {
    workspaceId: string;
    connectionId: string;
    code: string;
    now: Date;
  },
): Promise<void> {
  await transaction
    .update(providerConnections)
    .set({
      status: 'reauth_required',
      lastErrorCode: input.code,
      updatedAt: input.now,
    })
    .where(eq(providerConnections.id, input.connectionId));
  await transaction
    .update(providerAccounts)
    .set({
      availability: 'reauth_required',
      updatedAt: input.now,
    })
    .where(
      and(
        eq(providerAccounts.workspaceId, input.workspaceId),
        eq(providerAccounts.connectionId, input.connectionId),
      ),
    );
}

export async function getFreshFanvueToken(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: FanvueHttpClient,
  input: { workspaceId: string; creatorId: string; now?: Date },
): Promise<FanvueToken> {
  const now = input.now ?? new Date();
  const result = await withTenantTransaction(database, input, async (transaction) => {
    // This row lock spans the provider call: a rotating single-use token must never be sent twice.
    const rows = await transaction
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.workspaceId, input.workspaceId),
          eq(providerConnections.provider, 'fanvue'),
          eq(providerConnections.externalSubjectId, input.creatorId),
          eq(providerConnections.status, 'active'),
          isNull(providerConnections.revokedAt),
        ),
      )
      .for('update')
      .limit(1);
    const connection = rows[0];
    if (!connection) return null;
    const stored = await getActiveCredential(
      transaction,
      input.workspaceId,
      connection.credentialId,
    );
    if (!stored) throw new Error('Fanvue credential is unavailable');
    const plaintext = await decryptCredential(stored, keys);
    let token: FanvueToken;
    try {
      token = fanvueTokenSchema.parse(JSON.parse(plaintext.toString('utf8')));
    } finally {
      plaintext.fill(0);
    }
    assertFanvuePublishingScopes(token.scope);
    if (
      connection.accessExpiresAt &&
      connection.accessExpiresAt.getTime() > now.getTime() + REFRESH_SKEW_MS
    )
      return token;
    let refreshed: FanvueToken;
    try {
      refreshed = await client.refresh(token.refresh_token);
    } catch (error) {
      // A transport failure may mean Fanvue rotated the token but the response was lost.
      // Never replay that single-use refresh token or affect another creator connection.
      if (error instanceof FanvueRequestError && error.status === 429) throw error;
      await markReconnection(transaction, {
        workspaceId: input.workspaceId,
        connectionId: connection.id,
        code:
          error instanceof FanvueRequestError && error.code === 'invalid_grant'
            ? 'invalid_grant'
            : 'refresh_uncertain',
        now,
      });
      return null;
    }
    const encoded = Buffer.from(JSON.stringify(refreshed));
    let encrypted;
    try {
      encrypted = await encryptCredential(encoded, keys);
    } catch {
      await markReconnection(transaction, {
        workspaceId: input.workspaceId,
        connectionId: connection.id,
        code: 'refresh_persistence_failed',
        now,
      });
      return null;
    } finally {
      encoded.fill(0);
    }
    const rotated = await rotateCredential(
      transaction,
      input.workspaceId,
      connection.credentialId,
      stored.version,
      encrypted,
    );
    if (!rotated) {
      await markReconnection(transaction, {
        workspaceId: input.workspaceId,
        connectionId: connection.id,
        code: 'refresh_persistence_failed',
        now,
      });
      return null;
    }
    await transaction
      .update(providerConnections)
      .set({
        scopes: assertFanvuePublishingScopes(refreshed.scope),
        accessExpiresAt: new Date(now.getTime() + refreshed.expires_in * 1000),
        lastRefreshedAt: now,
        lastErrorCode: null,
        updatedAt: now,
      })
      .where(eq(providerConnections.id, connection.id));
    return refreshed;
  });
  if (!result) throw new Error('Fanvue account requires reconnection');
  return result;
}

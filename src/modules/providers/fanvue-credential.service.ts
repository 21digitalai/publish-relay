import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { setTimeout as delay } from 'node:timers/promises';

import { providerAccounts, providerConnections } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { getActiveCredential, rotateCredential } from '../credentials/credential.repository.js';
import {
  decryptCredential,
  encryptCredential,
  type EncryptedCredential,
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
const REFRESH_POLL_MS = 500;
const REFRESH_POLL_ATTEMPTS = 30;

async function awaitConcurrentRefresh(
  database: NodePgDatabase,
  input: { workspaceId: string; creatorId: string },
): Promise<boolean> {
  for (let attempt = 0; attempt < REFRESH_POLL_ATTEMPTS; attempt++) {
    const [connection] = await withTenantTransaction(database, input, (transaction) =>
      transaction
        .select({ status: providerConnections.status, error: providerConnections.lastErrorCode })
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.workspaceId, input.workspaceId),
            eq(providerConnections.provider, 'fanvue'),
            eq(providerConnections.externalSubjectId, input.creatorId),
            isNull(providerConnections.revokedAt),
          ),
        )
        .limit(1),
    );
    if (connection?.status === 'active') return true;
    if (connection?.error !== 'refresh_pending') return false;
    await delay(REFRESH_POLL_MS);
  }
  return false;
}

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
    .where(
      and(
        eq(providerConnections.workspaceId, input.workspaceId),
        eq(providerConnections.id, input.connectionId),
      ),
    );
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
        isNull(providerAccounts.disconnectedAt),
      ),
    );
}

async function recordRefreshFailure(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    connectionId: string;
    credentialId: string;
    code: string;
    now: Date;
  },
): Promise<void> {
  await withTenantTransaction(database, input, async (transaction) => {
    await transaction
      .update(providerConnections)
      .set({ lastErrorCode: input.code, updatedAt: input.now })
      .where(
        and(
          eq(providerConnections.workspaceId, input.workspaceId),
          eq(providerConnections.id, input.connectionId),
          eq(providerConnections.credentialId, input.credentialId),
          eq(providerConnections.status, 'reauth_required'),
          eq(providerConnections.lastErrorCode, 'refresh_pending'),
        ),
      );
  });
}

type RefreshReservation =
  | { kind: 'fresh'; token: FanvueToken }
  | {
      kind: 'reserved';
      token: FanvueToken;
      connectionId: string;
      credentialId: string;
      credentialVersion: number;
    };

async function reserveFanvueRefresh(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: { workspaceId: string; creatorId: string },
  now: Date,
): Promise<RefreshReservation | null> {
  return withTenantTransaction(database, input, async (transaction) => {
    // Commit quarantine before presenting Fanvue's single-use token to the network.
    const [connection] = await transaction
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
      return { kind: 'fresh', token };
    await markReconnection(transaction, {
      workspaceId: input.workspaceId,
      connectionId: connection.id,
      code: 'refresh_pending',
      now,
    });
    return {
      kind: 'reserved',
      token,
      connectionId: connection.id,
      credentialId: connection.credentialId,
      credentialVersion: stored.version,
    };
  });
}

async function persistFanvueRefresh(
  database: NodePgDatabase,
  input: { workspaceId: string; creatorId: string },
  reservation: Extract<RefreshReservation, { kind: 'reserved' }>,
  refreshed: FanvueToken,
  encrypted: EncryptedCredential,
  now: Date,
): Promise<boolean> {
  return withTenantTransaction(database, input, async (transaction) => {
    const [pending] = await transaction
      .select({ id: providerConnections.id })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.workspaceId, input.workspaceId),
          eq(providerConnections.id, reservation.connectionId),
          eq(providerConnections.credentialId, reservation.credentialId),
          eq(providerConnections.status, 'reauth_required'),
          eq(providerConnections.lastErrorCode, 'refresh_pending'),
        ),
      )
      .for('update')
      .limit(1);
    if (!pending) return false;
    const rotated = await rotateCredential(
      transaction,
      input.workspaceId,
      reservation.credentialId,
      reservation.credentialVersion,
      encrypted,
    );
    if (!rotated) {
      await transaction
        .update(providerConnections)
        .set({ lastErrorCode: 'refresh_persistence_failed', updatedAt: now })
        .where(eq(providerConnections.id, reservation.connectionId));
      return false;
    }
    await transaction
      .update(providerConnections)
      .set({
        status: 'active',
        scopes: assertFanvuePublishingScopes(refreshed.scope),
        accessExpiresAt: new Date(now.getTime() + refreshed.expires_in * 1000),
        lastRefreshedAt: now,
        lastErrorCode: null,
        updatedAt: now,
      })
      .where(eq(providerConnections.id, reservation.connectionId));
    await transaction
      .update(providerAccounts)
      .set({ availability: 'active', updatedAt: now })
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          eq(providerAccounts.connectionId, reservation.connectionId),
          isNull(providerAccounts.disconnectedAt),
        ),
      );
    return true;
  });
}

export async function getFreshFanvueToken(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: FanvueHttpClient,
  input: { workspaceId: string; creatorId: string; now?: Date },
): Promise<FanvueToken> {
  const now = input.now ?? new Date();
  const reservation = await reserveFanvueRefresh(database, keys, input, now);
  if (!reservation) {
    if (await awaitConcurrentRefresh(database, input))
      return getFreshFanvueToken(database, keys, client, input);
    throw new Error('Fanvue account requires reconnection');
  }
  if (reservation.kind === 'fresh') return reservation.token;
  const failureContext = {
    workspaceId: input.workspaceId,
    connectionId: reservation.connectionId,
    credentialId: reservation.credentialId,
    now,
  };
  let refreshed: FanvueToken;
  try {
    refreshed = await client.refresh(reservation.token.refresh_token);
  } catch (error) {
    await recordRefreshFailure(database, {
      ...failureContext,
      code:
        error instanceof FanvueRequestError && error.code === 'invalid_grant'
          ? 'invalid_grant'
          : 'refresh_uncertain',
    });
    throw new Error('Fanvue account requires reconnection');
  }
  const encoded = Buffer.from(JSON.stringify(refreshed));
  let encrypted;
  try {
    encrypted = await encryptCredential(encoded, keys);
  } catch {
    await recordRefreshFailure(database, { ...failureContext, code: 'refresh_persistence_failed' });
    throw new Error('Fanvue account requires reconnection');
  } finally {
    encoded.fill(0);
  }
  const saved = await persistFanvueRefresh(database, input, reservation, refreshed, encrypted, now);
  if (!saved) throw new Error('Fanvue account requires reconnection');
  return refreshed;
}

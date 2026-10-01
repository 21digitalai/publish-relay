import { and, eq, inArray, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  auditEvents,
  providerAccounts,
  providerConnections,
  publicationJobs,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  createCredential,
  getActiveCredential,
  revokeCredential,
} from '../credentials/credential.repository.js';
import {
  decryptCredential,
  encryptCredential,
  type MasterKeyProvider,
} from '../credentials/envelope.js';
import { consumeOauthCallback, issueOauthTransaction } from '../credentials/oauth.service.js';
import {
  assertActiveMembership,
  replaceProviderConnection,
} from '../credentials/provider-connection.repository.js';
import {
  allowAllActionPolicy,
  enforceWorkspaceAction,
  type ActionPolicy,
} from '../policy/action-policy.js';
import {
  MetaRequestError,
  type MetaCredential,
  type MetaDiscoveredPage,
} from './meta-http-client.js';
import type { MetaHttpClient } from './meta-http-client.js';

const REQUIRED_PAGE_TASK = 'CREATE_CONTENT';

interface MetaConnectInput {
  workspaceId: string;
  userId: string;
  state: string;
  code: string;
  requestId: string;
}

function serializeCredential(value: object): Buffer {
  return Buffer.from(JSON.stringify(value));
}

async function recordMetaOauthAudit(
  database: NodePgDatabase,
  input: { workspaceId: string; userId: string; requestId: string },
  action: 'meta.oauth.started' | 'meta.oauth.failed',
): Promise<void> {
  await withTenantTransaction(
    database,
    { workspaceId: input.workspaceId, userId: input.userId },
    (transaction) =>
      transaction.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.userId,
        action,
        targetType: 'user',
        targetId: input.userId,
        requestId: input.requestId,
        metadata: { provider: 'meta' },
      }),
  );
}

export async function beginMetaOauthConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: MetaHttpClient,
  input: { workspaceId: string; userId: string; callbackUrl: string; requestId: string },
  policy: ActionPolicy = allowAllActionPolicy,
): Promise<{ authorizationUrl: string; expiresAt: Date }> {
  await withTenantTransaction(database, input, (transaction) =>
    enforceWorkspaceAction(transaction, policy, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: input.userId },
      action: 'provider-account.connect',
      request: { provider: 'meta', requestId: input.requestId },
    }),
  );
  const transaction = await issueOauthTransaction(database, keys, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    provider: 'meta',
    redirectUri: input.callbackUrl,
  });
  await recordMetaOauthAudit(database, input, 'meta.oauth.started');
  return {
    authorizationUrl: client.authorizationUrl({
      redirectUri: input.callbackUrl,
      state: transaction.state,
    }),
    expiresAt: transaction.expiresAt,
  };
}

async function persistMetaDiscovery(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: MetaConnectInput,
  credential: MetaCredential,
  pages: readonly MetaDiscoveredPage[],
) {
  const authorityBytes = serializeCredential(credential);
  const pageBytes = pages.map((page) =>
    serializeCredential({ accessToken: page.accessToken, pageId: page.id }),
  );
  try {
    const encryptedAuthority = await encryptCredential(authorityBytes, keys);
    const encryptedPages = await Promise.all(
      pageBytes.map((bytes) => encryptCredential(bytes, keys)),
    );
    return await withTenantTransaction(
      database,
      { workspaceId: input.workspaceId, userId: input.userId },
      async (transaction) => {
        await assertActiveMembership(transaction, input.workspaceId, input.userId);
        const authority = await createCredential(
          transaction,
          input.workspaceId,
          encryptedAuthority,
        );
        const pageCredentials = await Promise.all(
          encryptedPages.map((encrypted) =>
            createCredential(transaction, input.workspaceId, encrypted),
          ),
        );
        const now = new Date();
        const accounts = pages.flatMap((page, index) => {
          const credentialId = pageCredentials[index]?.id;
          if (!credentialId) throw new Error('Meta Page credential write returned no record');
          const availability = page.tasks.includes(REQUIRED_PAGE_TASK)
            ? ('active' as const)
            : ('permission_lost' as const);
          const capabilitySnapshot = { tasks: [...page.tasks].sort() };
          return [
            {
              providerAccountId: page.id,
              destinationProvider: 'facebook_page' as const,
              remoteAccountId: page.id,
              displayName: page.name,
              credentialId,
              availability,
              capabilitySnapshot,
              capabilitiesCheckedAt: now,
            },
            ...(page.instagram
              ? [
                  {
                    providerAccountId: page.instagram.id,
                    destinationProvider: 'instagram' as const,
                    remoteAccountId: page.instagram.id,
                    remoteParentAccountId: page.id,
                    displayName: page.instagram.name,
                    credentialId,
                    availability,
                    capabilitySnapshot,
                    capabilitiesCheckedAt: now,
                  },
                ]
              : []),
          ];
        });
        const connection = await replaceProviderConnection(transaction, {
          workspaceId: input.workspaceId,
          userId: input.userId,
          provider: 'meta',
          externalSubjectId: credential.userId,
          credentialId: authority.id,
          accounts,
          requestId: input.requestId,
        });
        const replacedIds = new Set([
          ...(connection.replacedCredentialId ? [connection.replacedCredentialId] : []),
          ...connection.replacedAccountCredentialIds,
        ]);
        for (const credentialId of replacedIds)
          await revokeCredential(transaction, input.workspaceId, credentialId, now);
        await transaction.insert(auditEvents).values({
          workspaceId: input.workspaceId,
          actorType: 'user',
          actorId: input.userId,
          action: 'meta.discovery.completed',
          targetType: 'provider_connection',
          targetId: connection.connectionId,
          requestId: input.requestId,
          metadata: {
            pageCount: pages.length,
            instagramCount: pages.filter((page) => page.instagram).length,
            unavailableCount: accounts.filter((account) => account.availability !== 'active')
              .length,
          },
        });
        return {
          connectionId: connection.connectionId,
          accounts: accounts.map((account) => ({
            providerAccountId: account.providerAccountId,
            destinationProvider: account.destinationProvider,
            displayName: account.displayName,
            availability: account.availability,
          })),
        };
      },
    );
  } finally {
    authorityBytes.fill(0);
    for (const bytes of pageBytes) bytes.fill(0);
  }
}

export async function completeMetaOauthConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: MetaHttpClient,
  input: MetaConnectInput,
) {
  const transaction = await consumeOauthCallback(database, keys, {
    workspaceId: input.workspaceId,
    state: input.state,
    userId: input.userId,
    provider: 'meta',
  });
  if (!transaction) return null;
  try {
    const credential = await client.exchangeCode({
      code: input.code,
      redirectUri: transaction.redirectUri,
    });
    const pages = await client.discoverPages(credential.accessToken);
    return await persistMetaDiscovery(database, keys, input, credential, pages);
  } catch (error) {
    await recordMetaOauthAudit(database, input, 'meta.oauth.failed');
    // A callback failure has no verified existing connection to mark unavailable.
    throw error;
  }
}

export async function failMetaOauthConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: { workspaceId: string; userId: string; state: string; requestId: string },
): Promise<boolean> {
  const transaction = await consumeOauthCallback(database, keys, {
    workspaceId: input.workspaceId,
    state: input.state,
    userId: input.userId,
    provider: 'meta',
  });
  if (transaction) await recordMetaOauthAudit(database, input, 'meta.oauth.failed');
  return transaction !== null;
}

export async function revokeRemoteMetaGrant(
  client: MetaHttpClient,
  accessToken: string,
): Promise<void> {
  try {
    await client.revoke(accessToken);
  } catch (error) {
    if (
      !(error instanceof MetaRequestError) ||
      (error.kind !== 'auth' && error.kind !== 'permission')
    )
      throw error;
  }
}

export class MetaConnectionHasActiveJobsError extends Error {
  public constructor() {
    super('Cancel or resolve scheduled publications before revoking this Meta connection');
  }
}

export async function revokeMetaConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: MetaHttpClient,
  input: { workspaceId: string; userId: string; accountId: string; requestId: string },
): Promise<boolean> {
  const connection = await withTenantTransaction(
    database,
    { workspaceId: input.workspaceId, userId: input.userId },
    async (transaction) => {
      await assertActiveMembership(transaction, input.workspaceId, input.userId);
      const rows = await transaction
        .select({ id: providerConnections.id, credentialId: providerConnections.credentialId })
        .from(providerAccounts)
        .innerJoin(providerConnections, eq(providerAccounts.connectionId, providerConnections.id))
        .where(
          and(
            eq(providerConnections.workspaceId, input.workspaceId),
            eq(providerConnections.provider, 'meta'),
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.id, input.accountId),
          ),
        )
        .limit(1);
      if (rows[0]) {
        const activeJobs = await transaction
          .select({ id: publicationJobs.id })
          .from(publicationJobs)
          .innerJoin(providerAccounts, eq(publicationJobs.providerAccountId, providerAccounts.id))
          .where(
            and(
              eq(publicationJobs.workspaceId, input.workspaceId),
              eq(providerAccounts.connectionId, rows[0].id),
              or(
                inArray(publicationJobs.state, [
                  'scheduled',
                  'leased',
                  'dispatching',
                  'accepted_pending',
                  'retry_wait',
                ]),
                eq(publicationJobs.reconciliationRequired, true),
              ),
            ),
          )
          .limit(1);
        if (activeJobs[0]) throw new MetaConnectionHasActiveJobsError();
      }
      return rows[0] ?? null;
    },
  );
  if (!connection) return false;
  const credential = await withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    (transaction) => getActiveCredential(transaction, input.workspaceId, connection.credentialId),
  );
  if (credential) {
    const decrypted = await decryptCredential(credential, keys);
    try {
      const value = JSON.parse(decrypted.toString('utf8')) as { accessToken?: unknown };
      if (typeof value.accessToken !== 'string') throw new Error('Meta credential is invalid');
      await revokeRemoteMetaGrant(client, value.accessToken);
    } finally {
      decrypted.fill(0);
    }
  }
  await withTenantTransaction(
    database,
    { workspaceId: input.workspaceId, userId: input.userId },
    async (transaction) => {
      const now = new Date();
      const accountRows = await transaction
        .select({ credentialId: providerAccounts.credentialId })
        .from(providerAccounts)
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.connectionId, connection.id),
          ),
        );
      await transaction
        .update(providerAccounts)
        .set({ availability: 'reauth_required', disconnectedAt: now, updatedAt: now })
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.connectionId, connection.id),
          ),
        );
      await transaction
        .update(providerConnections)
        .set({ status: 'revoked', updatedAt: now })
        .where(
          and(
            eq(providerConnections.workspaceId, input.workspaceId),
            eq(providerConnections.id, connection.id),
          ),
        );
      for (const credentialId of new Set([
        connection.credentialId,
        ...accountRows.flatMap((account) => (account.credentialId ? [account.credentialId] : [])),
      ]))
        await revokeCredential(transaction, input.workspaceId, credentialId, now);
      await transaction.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.userId,
        action: 'meta.connection.revoked',
        targetType: 'provider_connection',
        targetId: connection.id,
        requestId: input.requestId,
        metadata: { destinationCount: accountRows.length },
      });
    },
  );
  return true;
}

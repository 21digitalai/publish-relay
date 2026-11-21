import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  auditEvents,
  providerAccounts,
  providerConnections,
  workspaces,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  createCredential,
  getActiveCredential,
  revokeCredential,
} from '../credentials/credential.repository.js';
import { hasActiveProviderAccountJobs } from '../credentials/provider-account-exposure.service.js';
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
  type MetaDiscoveryEvidence,
  type MetaDiscoveredPage,
  type MetaGrantFamily,
  type MetaPermission,
} from './meta-http-client.js';
import type { MetaHttpClient } from './meta-http-client.js';
import { completePageMessagesConsent, pageMessagesIntent } from './meta-page-messages.service.js';
import { completePageCommentsConsent, pageCommentsIntent } from './meta-page-comments.service.js';

const REQUIRED_PAGE_TASK = 'CREATE_CONTENT';

interface MetaConnectInput {
  workspaceId: string;
  userId: string;
  state: string;
  code: string;
  requestId: string;
}

function familyFromTransaction(provider: string): MetaGrantFamily | null {
  if (provider === 'meta:facebook_pages') return 'facebook_pages';
  if (provider === 'meta:instagram') return 'instagram';
  return null;
}

const META_CALLBACK_PROVIDERS = [
  'meta',
  'meta:facebook_pages',
  'meta:instagram',
  'meta:facebook_page_messages',
  'meta:facebook_page_comments',
] as const;

export class MetaPageMessagesCallbackError extends Error {
  constructor(public override readonly cause: unknown) {
    super('Facebook Page Messages connection did not complete', { cause });
  }
}

export class MetaPageCommentsCallbackError extends Error {
  constructor(public override readonly cause: unknown) {
    super('Facebook Page Comments connection did not complete', { cause });
  }
}

export class MetaFamilyCallbackError extends Error {
  constructor(
    public readonly family: MetaGrantFamily,
    cause: unknown,
  ) {
    super('Meta connection did not complete', { cause });
  }
}

export class MetaNoUsableDestinationsError extends Error {
  constructor(
    public readonly family: MetaGrantFamily,
    public readonly discoveryEvidence?: MetaDiscoveryEvidence,
  ) {
    super(`No usable ${family} destinations were discovered`);
  }
}

function serializeCredential(value: object): Buffer {
  return Buffer.from(JSON.stringify(value));
}

async function recordMetaOauthAudit(
  database: NodePgDatabase,
  input: { workspaceId: string; userId: string; requestId: string },
  action: 'meta.oauth.started' | 'meta.oauth.failed',
  family?: MetaGrantFamily,
  metadata: Record<string, unknown> = {},
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
        metadata: { provider: 'meta', ...(family ? { family } : {}), ...metadata },
      }),
  );
}

export async function beginMetaOauthConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: MetaHttpClient,
  input: {
    workspaceId: string;
    userId: string;
    callbackUrl: string;
    requestId: string;
    family: MetaGrantFamily;
    permissions: readonly MetaPermission[];
  },
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
    provider: `meta:${input.family}`,
    redirectUri: input.callbackUrl,
  });
  await recordMetaOauthAudit(database, input, 'meta.oauth.started', input.family);
  return {
    authorizationUrl: client.authorizationUrl({
      redirectUri: input.callbackUrl,
      state: transaction.state,
      permissions: input.permissions,
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
  family: MetaGrantFamily,
) {
  const authorityBytes = serializeCredential({
    accessToken: credential.accessToken,
    userId: credential.userId,
    ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
    scopes: credential.scopes,
  });
  const selectedPages = family === 'instagram' ? pages.filter((page) => page.instagram) : pages;
  const pageBytes = selectedPages.map((page) =>
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
        const accounts = selectedPages.flatMap((page, index) => {
          const credentialId = pageCredentials[index]?.id;
          if (!credentialId) throw new Error('Meta Page credential write returned no record');
          const availability =
            family === 'instagram' || page.tasks.includes(REQUIRED_PAGE_TASK)
              ? ('active' as const)
              : ('permission_lost' as const);
          const capabilitySnapshot = { tasks: [...page.tasks].sort() };
          return [
            ...(family === 'facebook_pages'
              ? [
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
                ]
              : []),
            ...(family === 'instagram' && page.instagram
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
          grantFamily: family,
          externalSubjectId: credential.userId,
          scopes: credential.scopes,
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
            pageCount: family === 'facebook_pages' ? accounts.length : 0,
            instagramCount: family === 'instagram' ? accounts.length : 0,
            family,
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

async function disconnectEmptyMetaFamilyGrant(
  database: NodePgDatabase,
  input: MetaConnectInput,
  family: MetaGrantFamily,
  subjectId: string,
): Promise<void> {
  await withTenantTransaction(database, input, async (transaction) => {
    await assertActiveMembership(transaction, input.workspaceId, input.userId);
    await transaction
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .for('update');
    const connections = await transaction
      .select({ id: providerConnections.id, credentialId: providerConnections.credentialId })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.workspaceId, input.workspaceId),
          eq(providerConnections.provider, 'meta'),
          eq(providerConnections.grantFamily, family),
          eq(providerConnections.externalSubjectId, subjectId),
          eq(providerConnections.status, 'active'),
        ),
      )
      .for('update')
      .limit(1);
    const connection = connections[0];
    if (!connection) return;
    const accounts = await transaction
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          eq(providerAccounts.connectionId, connection.id),
        ),
      )
      .limit(1);
    if (accounts[0]) return;
    const now = new Date();
    await transaction
      .update(providerConnections)
      .set({ status: 'disconnected', updatedAt: now })
      .where(
        and(
          eq(providerConnections.workspaceId, input.workspaceId),
          eq(providerConnections.id, connection.id),
        ),
      );
    await revokeCredential(transaction, input.workspaceId, connection.credentialId, now);
    await transaction.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      actorType: 'user',
      actorId: input.userId,
      action: 'meta.connection.disconnected',
      targetType: 'provider_connection',
      targetId: connection.id,
      requestId: input.requestId,
      metadata: { family, reason: 'no_usable_destinations' },
    });
  });
}

export async function completeMetaOauthConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: MetaHttpClient,
  input: MetaConnectInput,
  familyPermissions: Partial<Record<MetaGrantFamily, readonly MetaPermission[]>> = {},
) {
  const transaction = await consumeOauthCallback(database, keys, {
    workspaceId: input.workspaceId,
    state: input.state,
    userId: input.userId,
    provider: META_CALLBACK_PROVIDERS,
  });
  if (!transaction) return null;
  if (transaction.provider === 'meta:facebook_page_comments') {
    try {
      const result = await completePageCommentsConsent(database, keys, client, {
        ...input,
        redirectUri: transaction.redirectUri,
        intent: pageCommentsIntent(transaction.intent),
      });
      return {
        family: 'facebook_page_comments' as const,
        connectionId: result.connectionId,
        accounts: [
          {
            providerAccountId: result.pageId,
            destinationProvider: 'facebook_page' as const,
            displayName: result.displayName,
            availability: 'active' as const,
          },
        ],
      };
    } catch (error) {
      await recordMetaOauthAudit(database, input, 'meta.oauth.failed', 'facebook_pages');
      throw new MetaPageCommentsCallbackError(error);
    }
  }
  if (transaction.provider === 'meta:facebook_page_messages') {
    try {
      const result = await completePageMessagesConsent(database, keys, client, {
        ...input,
        redirectUri: transaction.redirectUri,
        intent: pageMessagesIntent(transaction.intent),
      });
      return {
        family: 'facebook_page_messages' as const,
        connectionId: result.connectionId,
        accounts: [
          {
            providerAccountId: result.pageId,
            destinationProvider: 'facebook_page' as const,
            displayName: result.displayName,
            availability: 'active' as const,
          },
        ],
      };
    } catch (error) {
      await recordMetaOauthAudit(database, input, 'meta.oauth.failed', 'facebook_pages');
      throw new MetaPageMessagesCallbackError(error);
    }
  }
  const family = familyFromTransaction(transaction.provider);
  if (!family) return null;
  const permissions = familyPermissions[family];
  if (!permissions)
    throw new MetaFamilyCallbackError(family, new Error('Meta consent is not configured'));
  let discoveryEvidence: MetaDiscoveryEvidence | undefined;
  let credential: MetaCredential | undefined;
  try {
    credential = await client.exchangeCode({
      code: input.code,
      redirectUri: transaction.redirectUri,
      permissions,
    });
    const pages = await client.discoverPages(credential.accessToken, family, (evidence) => {
      discoveryEvidence = evidence;
    });
    const hasUsableDestination = pages.some((page) =>
      family === 'instagram' ? Boolean(page.instagram) : page.tasks.includes(REQUIRED_PAGE_TASK),
    );
    if (!hasUsableDestination) {
      await disconnectEmptyMetaFamilyGrant(database, input, family, credential.userId);
      throw new MetaNoUsableDestinationsError(family, discoveryEvidence);
    }
    return {
      family,
      ...(await persistMetaDiscovery(database, keys, input, credential, pages, family)),
    };
  } catch (error) {
    const discovery =
      error instanceof MetaNoUsableDestinationsError ? error.discoveryEvidence : discoveryEvidence;
    await recordMetaOauthAudit(
      database,
      input,
      'meta.oauth.failed',
      family,
      discovery
        ? {
            failure:
              discovery.kind === 'pages' ? 'no_usable_destinations' : 'discovery_schema_invalid',
            discovery,
            ...(credential?.granularPermissions.length
              ? { grantedPermissions: credential.granularPermissions }
              : {}),
          }
        : {},
    );
    // Only an independently verified empty grant is disconnected above.
    throw new MetaFamilyCallbackError(family, error);
  }
}

export async function failMetaOauthConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: { workspaceId: string; userId: string; state: string; requestId: string },
): Promise<MetaGrantFamily | 'facebook_page_messages' | 'facebook_page_comments' | null> {
  const transaction = await consumeOauthCallback(database, keys, {
    workspaceId: input.workspaceId,
    state: input.state,
    userId: input.userId,
    provider: META_CALLBACK_PROVIDERS,
  });
  const family =
    transaction?.provider === 'meta:facebook_page_comments'
      ? ('facebook_page_comments' as const)
      : transaction?.provider === 'meta:facebook_page_messages'
        ? ('facebook_page_messages' as const)
        : transaction
          ? familyFromTransaction(transaction.provider)
          : null;
  if (family)
    await recordMetaOauthAudit(
      database,
      input,
      'meta.oauth.failed',
      family === 'facebook_page_messages' || family === 'facebook_page_comments'
        ? 'facebook_pages'
        : family,
    );
  return family;
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

export class MetaRevocationPendingError extends Error {
  public constructor(cause: unknown) {
    super(
      'Meta grant revocation is pending. Retry Revoke Meta connection to finish; scheduling and reconnect are paused',
      { cause },
    );
  }
}

async function lockMetaWorkspace(transaction: NodePgDatabase, workspaceId: string): Promise<void> {
  await transaction
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for('update');
}

async function assertNoMetaActiveJobs(
  transaction: NodePgDatabase,
  workspaceId: string,
  connectionId: string,
): Promise<void> {
  const accounts = await transaction
    .select({ id: providerAccounts.id })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.workspaceId, workspaceId),
        eq(providerAccounts.connectionId, connectionId),
      ),
    );
  for (const account of accounts)
    if (await hasActiveProviderAccountJobs(transaction, workspaceId, account.id))
      throw new MetaConnectionHasActiveJobsError();
}

interface MetaRevokeInput {
  workspaceId: string;
  userId: string;
  accountId: string;
  requestId: string;
}

interface MetaRevokeConnection {
  id: string;
  credentialId: string;
  status: string;
  grantFamily: string | null;
}

async function finalizeMetaGrantRevoke(
  database: NodePgDatabase,
  input: MetaRevokeInput,
  connection: MetaRevokeConnection,
): Promise<void> {
  await withTenantTransaction(database, input, async (transaction) => {
    await lockMetaWorkspace(transaction, input.workspaceId);
    const reserved = await transaction
      .select({ status: providerConnections.status })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.workspaceId, input.workspaceId),
          eq(providerConnections.id, connection.id),
          eq(providerConnections.credentialId, connection.credentialId),
        ),
      )
      .for('update')
      .limit(1);
    if (reserved[0]?.status === 'revoked') return;
    if (reserved[0]?.status !== 'revoking')
      throw new Error('Meta grant changed during revoke; local state was preserved');
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
          eq(providerConnections.credentialId, connection.credentialId),
          eq(providerConnections.status, 'revoking'),
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
      action: connection.grantFamily ? 'meta.connection.disconnected' : 'meta.connection.revoked',
      targetType: 'provider_connection',
      targetId: connection.id,
      requestId: input.requestId,
      metadata: {
        destinationCount: accountRows.length,
        ...(connection.grantFamily ? { family: connection.grantFamily } : {}),
      },
    });
  });
}

export async function revokeMetaConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: MetaHttpClient,
  input: MetaRevokeInput,
): Promise<boolean> {
  const connection = await withTenantTransaction(
    database,
    { workspaceId: input.workspaceId, userId: input.userId },
    async (transaction) => {
      await assertActiveMembership(transaction, input.workspaceId, input.userId);
      // The same workspace row is locked by reconnect and publication admission.
      await lockMetaWorkspace(transaction, input.workspaceId);
      const rows = await transaction
        .select({
          id: providerConnections.id,
          credentialId: providerConnections.credentialId,
          status: providerConnections.status,
          grantFamily: providerConnections.grantFamily,
        })
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
      if (rows[0]?.status === 'active') {
        await assertNoMetaActiveJobs(transaction, input.workspaceId, rows[0].id);
        await transaction
          .update(providerConnections)
          .set({ status: 'revoking', updatedAt: new Date() })
          .where(
            and(
              eq(providerConnections.workspaceId, input.workspaceId),
              eq(providerConnections.id, rows[0].id),
              eq(providerConnections.status, 'active'),
            ),
          );
      }
      return rows[0] ?? null;
    },
  );
  if (!connection) return false;
  if (connection.status === 'revoked') return true;
  if (connection.status !== 'active' && connection.status !== 'revoking')
    throw new Error('Meta connection is not active');
  if (connection.grantFamily) {
    await finalizeMetaGrantRevoke(database, input, connection);
    return true;
  }
  try {
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
    await finalizeMetaGrantRevoke(database, input, connection);
    return true;
  } catch (error) {
    throw new MetaRevocationPendingError(error);
  }
}

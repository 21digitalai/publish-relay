import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import {
  auditEvents,
  facebookPageEngagementModules,
  providerAccounts,
  providerConnections,
  workspaces,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { createCredential, revokeCredential } from '../credentials/credential.repository.js';
import { encryptCredential, type MasterKeyProvider } from '../credentials/envelope.js';
import { issueOauthTransaction } from '../credentials/oauth.service.js';
import { assertActiveMembership } from '../credentials/provider-connection.repository.js';
import {
  allowAllActionPolicy,
  enforceWorkspaceAction,
  type ActionPolicy,
} from '../policy/action-policy.js';
import {
  META_FAMILY_PERMISSIONS,
  type MetaDiscoveredPage,
  type MetaHttpClient,
  type MetaPermission,
} from './meta-http-client.js';

const MESSAGE_PERMISSIONS = ['pages_messaging', 'pages_manage_metadata'] as const;
const intentSchema = z.object({
  accountId: z.uuid(),
  pageId: z.string().min(1),
  connectionId: z.uuid(),
  subjectId: z.string().min(1),
  credentialId: z.uuid(),
});
type Intent = z.infer<typeof intentSchema>;

export class MetaPageMessagesError extends Error {
  constructor(public readonly reason: 'unavailable' | 'account-mismatch' | 'permissions') {
    super(`Facebook Page Messages consent ${reason}`);
  }
}

function selectedPageCriteria(workspaceId: string, accountId: string) {
  return and(
    eq(providerAccounts.workspaceId, workspaceId),
    eq(providerAccounts.id, accountId),
    eq(providerAccounts.destinationProvider, 'facebook_page'),
    eq(providerAccounts.availability, 'active'),
    isNull(providerAccounts.disconnectedAt),
    eq(providerConnections.workspaceId, workspaceId),
    eq(providerConnections.provider, 'meta'),
    eq(providerConnections.grantFamily, 'facebook_pages'),
    eq(providerConnections.status, 'active'),
    isNull(providerConnections.revokedAt),
  );
}

async function selectedPage(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string },
) {
  const [row] = await database
    .select({
      pageId: providerAccounts.remoteAccountId,
      credentialId: providerAccounts.credentialId,
      connectionId: providerConnections.id,
      subjectId: providerConnections.externalSubjectId,
      scopes: providerConnections.scopes,
    })
    .from(providerAccounts)
    .innerJoin(providerConnections, eq(providerAccounts.connectionId, providerConnections.id))
    .where(selectedPageCriteria(input.workspaceId, input.accountId))
    .limit(1);
  if (!row?.credentialId || !row.subjectId) throw new MetaPageMessagesError('unavailable');
  return {
    ...row,
    credentialId: row.credentialId,
    subjectId: row.subjectId,
    scopes: z.array(z.string()).parse(row.scopes),
  };
}

export async function beginPageMessagesConsent(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: MetaHttpClient,
  input: {
    workspaceId: string;
    userId: string;
    accountId: string;
    callbackUrl: string;
    requestId: string;
  },
  policy: ActionPolicy = allowAllActionPolicy,
) {
  const page = await withTenantTransaction(database, input, async (transaction) => {
    await assertActiveMembership(transaction, input.workspaceId, input.userId);
    await enforceWorkspaceAction(transaction, policy, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: input.userId },
      action: 'provider-account.connect',
      request: { provider: 'meta', requestId: input.requestId },
    });
    return selectedPage(transaction, input);
  });
  const required = [...META_FAMILY_PERMISSIONS.facebook_pages, ...MESSAGE_PERMISSIONS];
  if (!META_FAMILY_PERMISSIONS.facebook_pages.every((scope) => page.scopes.includes(scope)))
    throw new MetaPageMessagesError('unavailable');
  const intent: Intent = {
    accountId: input.accountId,
    pageId: page.pageId,
    connectionId: page.connectionId,
    subjectId: page.subjectId,
    credentialId: page.credentialId,
  };
  const transaction = await issueOauthTransaction(database, keys, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    provider: 'meta:facebook_page_messages',
    redirectUri: input.callbackUrl,
    intent: JSON.stringify(intent),
  });
  return {
    authorizationUrl: client.authorizationUrl({
      redirectUri: input.callbackUrl,
      state: transaction.state,
      permissions: required,
    }),
    expiresAt: transaction.expiresAt,
  };
}

export function pageMessagesIntent(value: string | null | undefined): Intent {
  const parsed = z.string().min(1).parse(value);
  return intentSchema.parse(JSON.parse(parsed) as unknown);
}

export function selectVerifiedMessagesPage(
  intent: Intent,
  subjectId: string,
  pages: readonly MetaDiscoveredPage[],
): MetaDiscoveredPage {
  if (subjectId !== intent.subjectId) throw new MetaPageMessagesError('account-mismatch');
  const page = pages.find((candidate) => candidate.id === intent.pageId);
  if (!page) throw new MetaPageMessagesError('account-mismatch');
  if (!page.tasks.includes('CREATE_CONTENT') || !page.tasks.includes('MESSAGING'))
    throw new MetaPageMessagesError('permissions');
  return page;
}

export async function completePageMessagesConsent(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: MetaHttpClient,
  input: {
    workspaceId: string;
    userId: string;
    code: string;
    requestId: string;
    redirectUri: string;
    intent: Intent;
  },
) {
  const permissions = [
    ...META_FAMILY_PERMISSIONS.facebook_pages,
    ...MESSAGE_PERMISSIONS,
  ] as MetaPermission[];
  const credential = await client.exchangeCode({
    code: input.code,
    redirectUri: input.redirectUri,
    permissions,
  });
  const pages = await client.discoverPages(credential.accessToken, 'facebook_pages');
  const page = selectVerifiedMessagesPage(input.intent, credential.userId, pages);
  return persistPageMessagesConsent(database, keys, input, page, credential.scopes);
}

async function persistPageMessagesConsent(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: { workspaceId: string; userId: string; requestId: string; intent: Intent },
  page: MetaDiscoveredPage,
  scopes: readonly MetaPermission[],
) {
  const plaintext = Buffer.from(JSON.stringify({ accessToken: page.accessToken, pageId: page.id }));
  try {
    const encrypted = await encryptCredential(plaintext, keys);
    return await withTenantTransaction(database, input, async (transaction) => {
      await assertActiveMembership(transaction, input.workspaceId, input.userId);
      await transaction
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId))
        .for('update');
      const current = await selectedPage(transaction, {
        workspaceId: input.workspaceId,
        accountId: input.intent.accountId,
      });
      if (
        current.pageId !== input.intent.pageId ||
        current.subjectId !== input.intent.subjectId ||
        current.connectionId !== input.intent.connectionId ||
        current.credentialId !== input.intent.credentialId
      )
        throw new MetaPageMessagesError('unavailable');
      const saved = await createCredential(transaction, input.workspaceId, encrypted);
      const now = new Date();
      await transaction
        .update(providerAccounts)
        .set({
          credentialId: saved.id,
          capabilitySnapshot: { tasks: [...page.tasks].sort() },
          capabilitiesCheckedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.id, input.intent.accountId),
          ),
        );
      await transaction
        .insert(facebookPageEngagementModules)
        .values({
          workspaceId: input.workspaceId,
          accountId: input.intent.accountId,
          dmsEnabled: true,
          dmsProviderGrant: 'verified',
          dmsVerifiedAt: now,
          dmsCredentialId: saved.id,
          dmsGrantedScopes: [...scopes].sort(),
        })
        .onConflictDoUpdate({
          target: [
            facebookPageEngagementModules.workspaceId,
            facebookPageEngagementModules.accountId,
          ],
          set: {
            dmsEnabled: true,
            dmsProviderGrant: 'verified',
            dmsVerifiedAt: now,
            dmsCredentialId: saved.id,
            dmsGrantedScopes: [...scopes].sort(),
            updatedAt: now,
          },
        });
      await revokeCredential(transaction, input.workspaceId, current.credentialId, now);
      await transaction.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.userId,
        action: 'meta.page_messages.verified',
        targetType: 'provider_account',
        targetId: input.intent.accountId,
        requestId: input.requestId,
        metadata: { module: 'dms', scopeCount: scopes.length },
      });
      return { connectionId: current.connectionId, pageId: page.id, displayName: page.name };
    });
  } finally {
    plaintext.fill(0);
  }
}

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { auditEvents } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { createCredential, revokeCredential } from '../credentials/credential.repository.js';
import { encryptCredential, type MasterKeyProvider } from '../credentials/envelope.js';
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
import type { InstagramUnifiedLoginClient } from './instagram-unified-login-client.js';

export const INSTAGRAM_UNIFIED_PROVIDER = 'instagram_unified_login';

interface Input {
  workspaceId: string;
  userId: string;
  requestId: string;
}

export async function beginInstagramUnifiedLogin(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: InstagramUnifiedLoginClient,
  input: Input & { callbackUrl: string },
  policy: ActionPolicy = allowAllActionPolicy,
) {
  await withTenantTransaction(database, input, (transaction) =>
    enforceWorkspaceAction(transaction, policy, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: input.userId },
      action: 'provider-account.connect',
      request: { provider: 'instagram', requestId: input.requestId },
    }),
  );
  const state = await issueOauthTransaction(database, keys, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    provider: INSTAGRAM_UNIFIED_PROVIDER,
    redirectUri: input.callbackUrl,
  });
  return {
    authorizationUrl: client.authorizationUrl({
      redirectUri: input.callbackUrl,
      state: state.state,
    }),
    expiresAt: state.expiresAt,
  };
}

export async function completeInstagramUnifiedLogin(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: InstagramUnifiedLoginClient,
  input: Input & { state: string; code: string },
) {
  const state = await consumeOauthCallback(database, keys, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    state: input.state,
    provider: INSTAGRAM_UNIFIED_PROVIDER,
  });
  if (!state) return null;
  const grant = await client.exchangeCode({ code: input.code, redirectUri: state.redirectUri });
  if (grant.accounts.length === 0)
    throw new Error('No Instagram professional accounts were shared with this app');
  const plaintext = Buffer.from(
    JSON.stringify({ accessToken: grant.accessToken, clientBusinessId: grant.clientBusinessId }),
  );
  try {
    const encrypted = await encryptCredential(plaintext, keys);
    return await withTenantTransaction(database, input, async (transaction) => {
      await assertActiveMembership(transaction, input.workspaceId, input.userId);
      const credential = await createCredential(transaction, input.workspaceId, encrypted);
      const connection = await replaceProviderConnection(transaction, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        provider: INSTAGRAM_UNIFIED_PROVIDER,
        externalSubjectId: grant.clientBusinessId,
        credentialId: credential.id,
        ...(grant.expiresAt ? { accessExpiresAt: grant.expiresAt } : {}),
        scopes: ['instagram_basic', 'instagram_content_publish'],
        accounts: grant.accounts.map((account) => ({
          providerAccountId: account.id,
          remoteAccountId: account.id,
          destinationProvider: 'instagram',
          displayName: account.username,
          credentialId: credential.id,
          availability: 'active',
        })),
        requestId: input.requestId,
      });
      const now = new Date();
      for (const id of new Set([
        ...(connection.replacedCredentialId ? [connection.replacedCredentialId] : []),
        ...connection.replacedAccountCredentialIds,
      ]))
        await revokeCredential(transaction, input.workspaceId, id, now);
      await transaction.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.userId,
        action: 'instagram.unified_login.connected',
        targetType: 'provider_connection',
        targetId: connection.connectionId,
        requestId: input.requestId,
        metadata: { destinationCount: grant.accounts.length },
      });
      return { connectionId: connection.connectionId, accountCount: grant.accounts.length };
    });
  } finally {
    plaintext.fill(0);
  }
}

export async function failInstagramUnifiedLogin(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: Input & { state: string },
) {
  const state = await consumeOauthCallback(database, keys, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    state: input.state,
    provider: INSTAGRAM_UNIFIED_PROVIDER,
  });
  if (!state) return false;
  await withTenantTransaction(database, input, (transaction) =>
    transaction.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      actorType: 'user',
      actorId: input.userId,
      action: 'instagram.unified_login.denied',
      targetType: 'user',
      targetId: input.userId,
      requestId: input.requestId,
      metadata: {},
    }),
  );
  return true;
}

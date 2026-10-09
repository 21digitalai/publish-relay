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
import { INSTAGRAM_LOGIN_SCOPES, type InstagramLoginClient } from './instagram-login-client.js';

interface InstagramLoginInput {
  workspaceId: string;
  userId: string;
  requestId: string;
}

export async function beginInstagramLogin(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: InstagramLoginClient,
  input: InstagramLoginInput & { callbackUrl: string },
  policy: ActionPolicy = allowAllActionPolicy,
): Promise<{ authorizationUrl: string; expiresAt: Date }> {
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
    provider: 'instagram_login',
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

export async function completeInstagramLogin(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: InstagramLoginClient,
  input: InstagramLoginInput & { state: string; code: string },
): Promise<{ connectionId: string } | null> {
  const state = await consumeOauthCallback(database, keys, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    state: input.state,
    provider: 'instagram_login',
  });
  if (!state) return null;
  const grant = await client.exchangeCode({ code: input.code, redirectUri: state.redirectUri });
  const plaintext = Buffer.from(JSON.stringify({ accessToken: grant.accessToken }));
  try {
    const encrypted = await encryptCredential(plaintext, keys);
    return await withTenantTransaction(database, input, async (transaction) => {
      await assertActiveMembership(transaction, input.workspaceId, input.userId);
      const credential = await createCredential(transaction, input.workspaceId, encrypted);
      const connection = await replaceProviderConnection(transaction, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        provider: 'instagram_login',
        externalSubjectId: grant.appScopedUserId,
        credentialId: credential.id,
        scopes: INSTAGRAM_LOGIN_SCOPES,
        accessExpiresAt: grant.expiresAt,
        accounts: [
          {
            providerAccountId: grant.remoteUserId,
            remoteAccountId: grant.remoteUserId,
            destinationProvider: 'instagram',
            displayName: grant.username,
            credentialId: credential.id,
            availability: 'publishing_unavailable',
          },
        ],
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
        action: 'instagram.login.connected',
        targetType: 'provider_connection',
        targetId: connection.connectionId,
        requestId: input.requestId,
        metadata: { destinationCount: 1 },
      });
      return { connectionId: connection.connectionId };
    });
  } finally {
    plaintext.fill(0);
  }
}

export async function failInstagramLogin(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: InstagramLoginInput & { state: string },
): Promise<boolean> {
  const state = await consumeOauthCallback(database, keys, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    state: input.state,
    provider: 'instagram_login',
  });
  if (!state) return false;
  await withTenantTransaction(database, input, (transaction) =>
    transaction.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      actorType: 'user',
      actorId: input.userId,
      action: 'instagram.login.denied',
      targetType: 'user',
      targetId: input.userId,
      requestId: input.requestId,
      metadata: {},
    }),
  );
  return true;
}

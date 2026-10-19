import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import { consumeOauthCallback, issueOauthTransaction } from '../credentials/oauth.service.js';
import { connectProvider } from '../credentials/provider-connection.service.js';
import {
  allowAllActionPolicy,
  enforceWorkspaceAction,
  type ActionPolicy,
} from '../policy/action-policy.js';
import type { SnapchatHttpClient } from './snapchat-http-client.js';

const PROFILE_SCOPE = 'snapchat-profile-api';

export async function beginSnapchatOauthConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: SnapchatHttpClient,
  input: { workspaceId: string; userId: string; callbackUrl: string; requestId: string },
  policy: ActionPolicy = allowAllActionPolicy,
): Promise<{ authorizationUrl: string; expiresAt: Date }> {
  await withTenantTransaction(database, input, (transaction) =>
    enforceWorkspaceAction(transaction, policy, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: input.userId },
      action: 'provider-account.connect',
      request: { provider: 'snapchat', requestId: input.requestId },
    }),
  );
  const transaction = await issueOauthTransaction(database, keys, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    provider: 'snapchat',
    redirectUri: input.callbackUrl,
  });
  return {
    authorizationUrl: client.authorizationUrl({
      redirectUri: input.callbackUrl,
      state: transaction.state,
    }),
    expiresAt: transaction.expiresAt,
  };
}

export async function completeSnapchatOauthConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: SnapchatHttpClient,
  input: { workspaceId: string; userId: string; state: string; code: string; requestId: string },
  now = new Date(),
) {
  const transaction = await consumeOauthCallback(database, keys, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    state: input.state,
    provider: 'snapchat',
  });
  if (!transaction) return null;
  const token = await client.exchangeCode({
    code: input.code,
    redirectUri: transaction.redirectUri,
  });
  if (!token.scope.split(/[\s,]+/).includes(PROFILE_SCOPE))
    throw new Error('Snapchat grant is missing Public Profile scope');
  const profile = await client.discoverOwnerProfile(token.access_token);
  return connectProvider(
    database,
    keys,
    {
      discoverAccounts: () =>
        Promise.resolve([{ providerAccountId: profile.id, displayName: profile.display_name }]),
    },
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
      provider: 'snapchat',
      externalSubjectId: profile.id,
      accessToken: JSON.stringify(token),
      scopes: [PROFILE_SCOPE],
      accessExpiresAt: new Date(now.getTime() + token.expires_in * 1000),
      requestId: input.requestId,
    },
  );
}

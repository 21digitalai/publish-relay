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
import type { TikTokHttpClient, TikTokToken } from './tiktok-http-client.js';

const REQUIRED_SCOPES = ['user.info.basic', 'video.publish'];

function tokenDates(token: TikTokToken, now: Date) {
  return {
    accessExpiresAt: new Date(now.getTime() + token.expires_in * 1000),
    refreshExpiresAt: new Date(now.getTime() + token.refresh_expires_in * 1000),
  };
}

export async function beginTikTokOauthConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: TikTokHttpClient,
  input: { workspaceId: string; userId: string; callbackUrl: string; requestId: string },
  policy: ActionPolicy = allowAllActionPolicy,
): Promise<{ authorizationUrl: string; expiresAt: Date }> {
  await withTenantTransaction(database, input, (transaction) =>
    enforceWorkspaceAction(transaction, policy, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: input.userId },
      action: 'provider-account.connect',
      request: { provider: 'tiktok', requestId: input.requestId },
    }),
  );
  const transaction = await issueOauthTransaction(database, keys, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    provider: 'tiktok',
    redirectUri: input.callbackUrl,
  });
  return {
    authorizationUrl: client.authorizationUrl({
      redirectUri: input.callbackUrl,
      state: transaction.state,
      codeChallenge: transaction.codeChallenge,
    }),
    expiresAt: transaction.expiresAt,
  };
}

export async function completeTikTokOauthConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: TikTokHttpClient,
  input: { workspaceId: string; userId: string; state: string; code: string; requestId: string },
  now = new Date(),
) {
  const transaction = await consumeOauthCallback(database, keys, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    state: input.state,
    provider: 'tiktok',
  });
  if (!transaction) return null;
  const token = await client.exchangeCode({
    code: input.code,
    codeVerifier: transaction.codeVerifier,
    redirectUri: transaction.redirectUri,
  });
  const scopes = token.scope
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (REQUIRED_SCOPES.some((scope) => !scopes.includes(scope)))
    throw new Error('TikTok grant is missing required scopes');
  const account = await client.discoverAccount(token.access_token);
  if (account.openId !== token.open_id)
    throw new Error('TikTok account identity does not match the OAuth grant');
  return connectProvider(
    database,
    keys,
    {
      discoverAccounts: () =>
        Promise.resolve([
          {
            providerAccountId: account.openId,
            displayName: account.displayName,
          },
        ]),
    },
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
      provider: 'tiktok',
      externalSubjectId: account.openId,
      accessToken: JSON.stringify(token),
      scopes,
      ...tokenDates(token, now),
      requestId: input.requestId,
    },
  );
}

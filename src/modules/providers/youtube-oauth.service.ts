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
import type { YouTubeHttpClient } from './youtube-http-client.js';

export async function beginYouTubeOauthConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: YouTubeHttpClient,
  input: { workspaceId: string; userId: string; callbackUrl: string; requestId: string },
  policy: ActionPolicy = allowAllActionPolicy,
): Promise<{ authorizationUrl: string; expiresAt: Date }> {
  await withTenantTransaction(database, input, (transaction) =>
    enforceWorkspaceAction(transaction, policy, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: input.userId },
      action: 'provider-account.connect',
      request: { provider: 'youtube', requestId: input.requestId },
    }),
  );
  const transaction = await issueOauthTransaction(database, keys, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    provider: 'youtube',
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

export async function completeYouTubeOauthConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: YouTubeHttpClient,
  input: { workspaceId: string; userId: string; state: string; code: string; requestId: string },
) {
  const transaction = await consumeOauthCallback(database, keys, {
    workspaceId: input.workspaceId,
    state: input.state,
    userId: input.userId,
    provider: 'youtube',
  });
  if (!transaction) return null;
  const credential = await client.exchangeCode({
    code: input.code,
    codeVerifier: transaction.codeVerifier,
    redirectUri: transaction.redirectUri,
  });
  const subjectId = await client.discoverPrincipal(credential.accessToken);
  return connectProvider(
    database,
    keys,
    {
      discoverAccounts: async (serializedCredential) => {
        const parsed = JSON.parse(serializedCredential) as { accessToken?: unknown };
        if (typeof parsed.accessToken !== 'string')
          throw new Error('YouTube credential is invalid');
        const channels = await client.discoverChannels(parsed.accessToken);
        return channels.map((channel) => ({
          providerAccountId: channel.id,
          displayName: channel.displayName,
        }));
      },
    },
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
      provider: 'youtube',
      externalSubjectId: subjectId,
      accessToken: JSON.stringify(credential),
      requestId: input.requestId,
    },
  );
}

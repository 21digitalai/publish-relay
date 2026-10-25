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
import { assertFanvuePublishingScopes, type FanvueHttpClient } from './fanvue-http-client.js';

export async function beginFanvueOauthConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: FanvueHttpClient,
  input: { workspaceId: string; userId: string; callbackUrl: string; requestId: string },
  policy: ActionPolicy = allowAllActionPolicy,
): Promise<{ authorizationUrl: string; expiresAt: Date }> {
  await withTenantTransaction(database, input, (transaction) =>
    enforceWorkspaceAction(transaction, policy, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: input.userId },
      action: 'provider-account.connect',
      request: { provider: 'fanvue', requestId: input.requestId },
    }),
  );
  const pending = await issueOauthTransaction(database, keys, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    provider: 'fanvue',
    redirectUri: input.callbackUrl,
  });
  return {
    authorizationUrl: client.authorizationUrl({
      redirectUri: input.callbackUrl,
      state: pending.state,
      codeChallenge: pending.codeChallenge,
    }),
    expiresAt: pending.expiresAt,
  };
}

export async function completeFanvueOauthConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: FanvueHttpClient,
  input: { workspaceId: string; userId: string; state: string; code: string; requestId: string },
  now = new Date(),
) {
  const pending = await consumeOauthCallback(database, keys, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    state: input.state,
    provider: 'fanvue',
  });
  if (!pending) return null;
  const token = await client.exchangeCode({
    code: input.code,
    redirectUri: pending.redirectUri,
    codeVerifier: pending.codeVerifier,
  });
  const scopes = assertFanvuePublishingScopes(token.scope);
  const profile = await client.discoverCreator(token.access_token);
  return connectProvider(
    database,
    keys,
    {
      discoverAccounts: () =>
        Promise.resolve([
          {
            providerAccountId: profile.uuid,
            displayName: profile.displayName ?? profile.handle ?? 'Fanvue creator',
          },
        ]),
    },
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
      provider: 'fanvue',
      externalSubjectId: profile.uuid,
      accessToken: JSON.stringify(token),
      scopes,
      accessExpiresAt: new Date(now.getTime() + token.expires_in * 1000),
      requestId: input.requestId,
    },
  );
}

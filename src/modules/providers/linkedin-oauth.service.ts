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
import type { LinkedInHttpClient } from './linkedin-http-client.js';

export async function beginLinkedInConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: LinkedInHttpClient,
  input: { workspaceId: string; userId: string; callbackUrl: string; requestId: string },
  policy: ActionPolicy = allowAllActionPolicy,
): Promise<{ authorizationUrl: string; expiresAt: Date }> {
  await withTenantTransaction(database, input, (transaction) =>
    enforceWorkspaceAction(transaction, policy, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: input.userId },
      action: 'provider-account.connect',
      request: { provider: 'linkedin', requestId: input.requestId },
    }),
  );
  const transaction = await issueOauthTransaction(database, keys, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    provider: 'linkedin',
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

export async function completeLinkedInConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: LinkedInHttpClient,
  input: { workspaceId: string; userId: string; state: string; code: string; requestId: string },
) {
  const transaction = await consumeOauthCallback(database, keys, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    state: input.state,
    provider: 'linkedin',
  });
  if (!transaction) return null;
  const credential = await client.exchangeCode({
    code: input.code,
    redirectUri: transaction.redirectUri,
  });
  return connectProvider(
    database,
    keys,
    {
      discoverAccounts: async (serializedCredential) => {
        const parsed = JSON.parse(serializedCredential) as {
          memberUrn?: unknown;
          accessToken?: unknown;
        };
        if (typeof parsed.memberUrn !== 'string' || typeof parsed.accessToken !== 'string')
          throw new Error('LinkedIn credential is invalid');
        const member = await client.discoverMember(parsed.accessToken);
        if (member.memberUrn !== parsed.memberUrn)
          throw new Error('LinkedIn member identity changed during connection');
        return [{ providerAccountId: member.memberUrn, displayName: member.displayName }];
      },
    },
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
      provider: 'linkedin',
      accessToken: JSON.stringify(credential),
      expiresAt: new Date(credential.expiresAt),
      requestId: input.requestId,
    },
  );
}

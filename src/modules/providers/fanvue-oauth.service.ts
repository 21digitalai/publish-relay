import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { providerAccounts, providerConnections } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import { consumeOauthCallback, issueOauthTransaction } from '../credentials/oauth.service.js';
import { connectProvider } from '../credentials/provider-connection.service.js';
import {
  allowAllActionPolicy,
  enforceWorkspaceAction,
  type ActionPolicy,
} from '../policy/action-policy.js';
import {
  assertFanvueChatReadScopes,
  assertFanvuePublishingScopes,
  type FanvueHttpClient,
} from './fanvue-http-client.js';

const CHAT_READ_INTENT = 'fanvue:chat-read:';

async function connectedCreatorForAccount(
  database: NodePgDatabase,
  input: { workspaceId: string; userId: string; accountId: string },
): Promise<string> {
  const [account] = await withTenantTransaction(database, input, (transaction) =>
    transaction
      .select({ creatorId: providerAccounts.remoteAccountId })
      .from(providerAccounts)
      .innerJoin(
        providerConnections,
        and(
          eq(providerConnections.workspaceId, providerAccounts.workspaceId),
          eq(providerConnections.id, providerAccounts.connectionId),
        ),
      )
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          eq(providerAccounts.id, z.uuid().parse(input.accountId)),
          eq(providerAccounts.destinationProvider, 'fanvue'),
          eq(providerAccounts.availability, 'active'),
          isNull(providerAccounts.disconnectedAt),
          eq(providerConnections.provider, 'fanvue'),
          eq(providerConnections.status, 'active'),
          isNull(providerConnections.revokedAt),
        ),
      )
      .limit(1),
  );
  if (!account) throw new Error('Fanvue account is unavailable for module consent');
  return account.creatorId;
}

export async function beginFanvueOauthConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: FanvueHttpClient,
  input: {
    workspaceId: string;
    userId: string;
    callbackUrl: string;
    requestId: string;
    readChatAccountId?: string;
  },
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
  if (input.readChatAccountId)
    await connectedCreatorForAccount(database, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      accountId: input.readChatAccountId,
    });
  const pending = await issueOauthTransaction(database, keys, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    provider: 'fanvue',
    redirectUri: input.callbackUrl,
    ...(input.readChatAccountId ? { intent: `${CHAT_READ_INTENT}${input.readChatAccountId}` } : {}),
  });
  return {
    authorizationUrl: client.authorizationUrl({
      redirectUri: input.callbackUrl,
      state: pending.state,
      codeChallenge: pending.codeChallenge,
      ...(input.readChatAccountId ? { readChat: true } : {}),
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
  const readChatAccountId = pending.intent?.startsWith(CHAT_READ_INTENT)
    ? z.uuid().parse(pending.intent.slice(CHAT_READ_INTENT.length))
    : null;
  if (pending.intent && !readChatAccountId) throw new Error('Unknown Fanvue OAuth intent');
  const existingCreatorId = readChatAccountId
    ? await connectedCreatorForAccount(database, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        accountId: readChatAccountId,
      })
    : null;
  const token = await client.exchangeCode({
    code: input.code,
    redirectUri: pending.redirectUri,
    codeVerifier: pending.codeVerifier,
    ...(readChatAccountId ? { readChat: true } : {}),
  });
  const scopes = readChatAccountId
    ? assertFanvueChatReadScopes(token.scope)
    : assertFanvuePublishingScopes(token.scope);
  const profile = await client.discoverCreator(token.access_token);
  if (existingCreatorId && profile.uuid !== existingCreatorId)
    throw new Error('Fanvue module consent returned a different creator account');
  const connection = await connectProvider(
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
  return {
    ...connection,
    ...(readChatAccountId ? { consentKind: 'read-chat' as const } : {}),
  };
}

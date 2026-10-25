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

export class FanvueModuleConsentError extends Error {
  constructor(public readonly reason: 'unavailable' | 'scope' | 'account-mismatch') {
    super(`Fanvue message-reading consent ${reason}`);
  }
}

export async function completeFanvueOauthDenial(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: { workspaceId: string; userId: string; state: string },
): Promise<'chat-read' | 'publishing' | null> {
  const pending = await consumeOauthCallback(database, keys, {
    ...input,
    provider: 'fanvue',
  });
  if (!pending) return null;
  return pending.intent?.startsWith(CHAT_READ_INTENT) ? 'chat-read' : 'publishing';
}

async function activeCreatorForAccount(
  transaction: NodePgDatabase,
  input: { workspaceId: string; userId: string; accountId: string },
): Promise<{ creatorId: string; connectionId: string; credentialId: string }> {
  const [account] = await transaction
    .select({
      creatorId: providerAccounts.remoteAccountId,
      connectionId: providerConnections.id,
      credentialId: providerConnections.credentialId,
    })
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
    .limit(1);
  if (!account) throw new FanvueModuleConsentError('unavailable');
  return account;
}

async function connectedCreatorForAccount(
  database: NodePgDatabase,
  input: { workspaceId: string; userId: string; accountId: string },
) {
  return withTenantTransaction(database, input, (transaction) =>
    activeCreatorForAccount(transaction, input),
  );
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
  const existingAccount = readChatAccountId
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
  let scopes: string[];
  if (readChatAccountId) {
    try {
      scopes = assertFanvueChatReadScopes(token.scope);
    } catch {
      throw new FanvueModuleConsentError('scope');
    }
  } else scopes = assertFanvuePublishingScopes(token.scope);
  const profile = await client.discoverCreator(token.access_token);
  if (existingAccount && profile.uuid !== existingAccount.creatorId)
    throw new FanvueModuleConsentError('account-mismatch');
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
      ...(readChatAccountId && existingAccount
        ? {
            beforeReplace: async (transaction: NodePgDatabase) => {
              const current = await activeCreatorForAccount(transaction, {
                workspaceId: input.workspaceId,
                userId: input.userId,
                accountId: readChatAccountId,
              });
              if (
                current.creatorId !== existingAccount.creatorId ||
                current.connectionId !== existingAccount.connectionId ||
                current.credentialId !== existingAccount.credentialId
              )
                throw new FanvueModuleConsentError('unavailable');
            },
          }
        : {}),
    },
  );
  return {
    ...connection,
    ...(readChatAccountId ? { consentKind: 'read-chat' as const } : {}),
  };
}

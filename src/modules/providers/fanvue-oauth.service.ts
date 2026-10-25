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
  FanvueScopeError,
  assertFanvuePublishingScopes,
  assertFanvueReadGrantScopes,
  FANVUE_CHAT_READ_SCOPES,
  FANVUE_CHAT_SEND_SCOPES,
  FANVUE_PAYMENT_SCOPE,
  type FanvueHttpClient,
} from './fanvue-http-client.js';

const CHAT_READ_INTENT = 'fanvue:chat-read:';
const CHAT_SEND_INTENT = 'fanvue:chat-send:';
const PAYMENT_INTENT = 'fanvue:payment:';

export class FanvueModuleConsentError extends Error {
  constructor(
    public readonly reason: 'unavailable' | 'scope' | 'account-mismatch',
    public readonly kind: 'read' | 'send' | 'payment' = 'read',
  ) {
    super(`Fanvue message-reading consent ${reason}`);
  }
}

export async function completeFanvueOauthDenial(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: { workspaceId: string; userId: string; state: string },
): Promise<'chat-read' | 'chat-send' | 'payment' | 'publishing' | null> {
  const pending = await consumeOauthCallback(database, keys, {
    ...input,
    provider: 'fanvue',
  });
  if (!pending) return null;
  if (pending.intent?.startsWith(CHAT_READ_INTENT)) return 'chat-read';
  if (pending.intent?.startsWith(CHAT_SEND_INTENT)) return 'chat-send';
  if (pending.intent?.startsWith(PAYMENT_INTENT)) return 'payment';
  return 'publishing';
}

async function activeCreatorForAccount(
  transaction: NodePgDatabase,
  input: { workspaceId: string; userId: string; accountId: string },
): Promise<{ creatorId: string; connectionId: string; credentialId: string; scopes: string[] }> {
  const [account] = await transaction
    .select({
      creatorId: providerAccounts.remoteAccountId,
      connectionId: providerConnections.id,
      credentialId: providerConnections.credentialId,
      scopes: providerConnections.scopes,
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
  return { ...account, scopes: z.array(z.string()).parse(account.scopes) };
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
    sendChatAccountId?: string;
    paymentAccountId?: string;
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
  if (
    [input.readChatAccountId, input.sendChatAccountId, input.paymentAccountId].filter(Boolean)
      .length > 1
  )
    throw new Error('Choose one Fanvue consent module');
  const selectedAccountId =
    input.readChatAccountId ?? input.sendChatAccountId ?? input.paymentAccountId;
  const selectedAccount = selectedAccountId
    ? await connectedCreatorForAccount(database, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        accountId: selectedAccountId,
      })
    : null;
  const requiredScopes = input.sendChatAccountId
    ? FANVUE_CHAT_SEND_SCOPES
    : input.readChatAccountId
      ? FANVUE_CHAT_READ_SCOPES
      : input.paymentAccountId
        ? [FANVUE_PAYMENT_SCOPE]
        : [];
  const requestedScopes = selectedAccount
    ? [...new Set([...requiredScopes, ...selectedAccount.scopes])]
    : undefined;
  const pending = await issueOauthTransaction(database, keys, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    provider: 'fanvue',
    redirectUri: input.callbackUrl,
    ...(input.readChatAccountId
      ? { intent: `${CHAT_READ_INTENT}${input.readChatAccountId}` }
      : input.sendChatAccountId
        ? { intent: `${CHAT_SEND_INTENT}${input.sendChatAccountId}` }
        : input.paymentAccountId
          ? { intent: `${PAYMENT_INTENT}${input.paymentAccountId}` }
          : {}),
  });
  return {
    authorizationUrl: client.authorizationUrl({
      redirectUri: input.callbackUrl,
      state: pending.state,
      codeChallenge: pending.codeChallenge,
      ...(input.readChatAccountId ? { readChat: true } : {}),
      ...(input.sendChatAccountId ? { sendChat: true } : {}),
      ...(input.paymentAccountId ? { payment: true } : {}),
      ...(requestedScopes ? { existingScopes: requestedScopes } : {}),
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
  const sendChatAccountId = pending.intent?.startsWith(CHAT_SEND_INTENT)
    ? z.uuid().parse(pending.intent.slice(CHAT_SEND_INTENT.length))
    : null;
  const paymentAccountId = pending.intent?.startsWith(PAYMENT_INTENT)
    ? z.uuid().parse(pending.intent.slice(PAYMENT_INTENT.length))
    : null;
  const selectedAccountId = readChatAccountId ?? sendChatAccountId ?? paymentAccountId;
  const kind = paymentAccountId ? 'payment' : sendChatAccountId ? 'send' : 'read';
  if (pending.intent && !selectedAccountId) throw new Error('Unknown Fanvue OAuth intent');
  let existingAccount: Awaited<ReturnType<typeof connectedCreatorForAccount>> | null = null;
  if (selectedAccountId) {
    try {
      existingAccount = await connectedCreatorForAccount(database, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        accountId: selectedAccountId,
      });
    } catch (error) {
      if (error instanceof FanvueModuleConsentError)
        throw new FanvueModuleConsentError(error.reason, kind);
      throw error;
    }
  }
  let token: Awaited<ReturnType<typeof client.exchangeCode>>;
  try {
    token = await client.exchangeCode({
      code: input.code,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.codeVerifier,
      ...(readChatAccountId ? { readChat: true } : {}),
      ...(sendChatAccountId ? { sendChat: true } : {}),
      ...(paymentAccountId ? { payment: true } : {}),
      ...(existingAccount
        ? {
            requiredScopes: [
              ...new Set([
                ...existingAccount.scopes,
                ...(sendChatAccountId
                  ? FANVUE_CHAT_SEND_SCOPES
                  : readChatAccountId
                    ? FANVUE_CHAT_READ_SCOPES
                    : [FANVUE_PAYMENT_SCOPE]),
              ]),
            ],
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof FanvueScopeError && selectedAccountId)
      throw new FanvueModuleConsentError('scope', kind);
    throw error;
  }
  let scopes: string[];
  if (selectedAccountId) {
    try {
      scopes = assertFanvueReadGrantScopes(token.scope);
      const needed = [
        ...(existingAccount?.scopes ?? []),
        ...(sendChatAccountId
          ? FANVUE_CHAT_SEND_SCOPES
          : readChatAccountId
            ? FANVUE_CHAT_READ_SCOPES
            : [FANVUE_PAYMENT_SCOPE]),
      ];
      if (needed.some((scope) => !scopes.includes(scope))) throw new Error('Missing module scope');
    } catch {
      throw new FanvueModuleConsentError('scope', kind);
    }
  } else scopes = assertFanvuePublishingScopes(token.scope);
  const profile = await client.discoverCreator(token.access_token);
  if (existingAccount && profile.uuid !== existingAccount.creatorId)
    throw new FanvueModuleConsentError('account-mismatch', kind);
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
      ...(selectedAccountId && existingAccount
        ? {
            beforeReplace: async (transaction: NodePgDatabase) => {
              let current;
              try {
                current = await activeCreatorForAccount(transaction, {
                  workspaceId: input.workspaceId,
                  userId: input.userId,
                  accountId: selectedAccountId,
                });
              } catch (error) {
                if (error instanceof FanvueModuleConsentError)
                  throw new FanvueModuleConsentError(error.reason, kind);
                throw error;
              }
              if (
                current.creatorId !== existingAccount.creatorId ||
                current.connectionId !== existingAccount.connectionId ||
                current.credentialId !== existingAccount.credentialId
              )
                throw new FanvueModuleConsentError('unavailable', kind);
            },
          }
        : {}),
    },
  );
  return {
    ...connection,
    ...(readChatAccountId
      ? { consentKind: 'read-chat' as const }
      : sendChatAccountId
        ? { consentKind: 'send-chat' as const }
        : paymentAccountId
          ? { consentKind: 'payment' as const }
          : {}),
  };
}

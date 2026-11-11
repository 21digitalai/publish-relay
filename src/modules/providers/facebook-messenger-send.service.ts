import { createHash } from 'node:crypto';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  isPageConversationNoGo,
  isPageConversationNoGoInTransaction,
  lockPageDmAccount,
} from './facebook-dm-no-go.repository.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import { enforceWorkspaceAction, type ActionPolicy } from '../policy/action-policy.js';
import {
  findFacebookDmAction,
  reserveFacebookDmAction,
  settleFacebookDmAction,
  type FacebookDmActionKey,
  type FacebookDmOutcome,
  type FacebookDmReservation,
} from './facebook-dm-action.repository.js';
import { FacebookRequestError, type FacebookHttpClient } from './facebook-http-client.js';
import {
  PageReadUnavailableError,
  withPageReadToken,
} from './facebook-page-read-context.service.js';

const commandSchema = z.strictObject({
  workspaceId: z.uuid(),
  accountId: z.uuid(),
  conversationId: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/)
    .max(256),
  clientActionId: z.uuid(),
  text: z.string().trim().min(1).max(2000),
  expectedLatestInboundMessageId: z.string().trim().min(1).max(256).optional(),
  actor: z.strictObject({
    type: z.enum(['user', 'api-key', 'delegated']),
    id: z.uuid(),
  }),
});

const STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;
const WINDOW_SAFETY_MS = 2 * 60 * 1000;

export class FacebookDmActionConflictError extends Error {
  constructor() {
    super('Facebook DM action ID conflicts with a prior request');
  }
}

export class FacebookDmWindowClosedError extends Error {
  constructor() {
    super('No recent inbound message proves a standard Messenger reply window');
  }
}

export class FacebookDmNoGoError extends Error {
  constructor() {
    super('This Page conversation is on the no-go list');
  }
}

export class FacebookDmConversationChangedError extends Error {
  constructor() {
    super('A newer inbound message arrived; review the conversation before sending');
  }
}

function replay(reservation: FacebookDmReservation): FacebookDmOutcome {
  if (reservation.kind === 'conflict') throw new FacebookDmActionConflictError();
  if (reservation.kind === 'new') throw new Error('Expected an existing Facebook DM action');
  return reservation.outcome;
}

async function findEligibleRecipient(
  client: FacebookHttpClient,
  conversationId: string,
  pageId: string,
  accessToken: string,
  now: number,
  expectedLatestInboundMessageId?: string,
): Promise<{
  id: string;
  label: string | null;
  latestInboundMessageId: string | null;
  latestInboundAt: Date;
  windowDeadline: Date;
}> {
  const participants = await client.getConversationParticipants(conversationId, accessToken);
  const fans = participants.filter((person) => person.id !== pageId);
  if (
    participants.filter((person) => person.id === pageId).length !== 1 ||
    fans.length !== 1 ||
    !fans[0]
  )
    throw new PageReadUnavailableError();
  const recipient = fans[0];
  const result = await client.listConversationMessages({ conversationId, accessToken, limit: 100 });
  const inbound = result.messages
    .filter((message) => message.senderId === recipient.id)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const latest = inbound[0];
  const latestTime = latest ? Date.parse(latest.createdAt) : NaN;
  if (
    !Number.isFinite(latestTime) ||
    latestTime > now ||
    latestTime < now - STANDARD_WINDOW_MS + WINDOW_SAFETY_MS
  )
    throw new FacebookDmWindowClosedError();
  if (
    inbound[1] &&
    Date.parse(inbound[1].createdAt) === latestTime &&
    expectedLatestInboundMessageId
  )
    throw new FacebookDmConversationChangedError();
  if (expectedLatestInboundMessageId) {
    if (latest?.id !== expectedLatestInboundMessageId)
      throw new FacebookDmConversationChangedError();
  }
  return {
    id: recipient.id,
    label: recipient.name?.trim().slice(0, 200) ?? null,
    latestInboundMessageId: latest?.id ?? null,
    latestInboundAt: new Date(latestTime),
    windowDeadline: new Date(latestTime + STANDARD_WINDOW_MS - WINDOW_SAFETY_MS),
  };
}

/** Approval uses the same identity and reply-window proof as actual dispatch. */
export async function getPageDmApprovalWindow(
  runtime: { database: NodePgDatabase; keys: MasterKeyProvider; client: FacebookHttpClient },
  input: { workspaceId: string; accountId: string; conversationId: string },
): Promise<{ latestInboundMessageId: string; latestInboundAt: Date; windowDeadline: Date }> {
  return withPageReadToken(runtime, { ...input, module: 'dms' }, async (pageId, token) => {
    const proof = await findEligibleRecipient(
      runtime.client,
      input.conversationId,
      pageId,
      token,
      Date.now(),
    );
    if (!proof.latestInboundMessageId) throw new PageReadUnavailableError();
    return {
      latestInboundMessageId: proof.latestInboundMessageId,
      latestInboundAt: proof.latestInboundAt,
      windowDeadline: proof.windowDeadline,
    };
  });
}

/** One Page-local text RESPONSE, never a new conversation or an automatic retry. */
export async function sendAccountPageConversationMessage(
  runtime: {
    database: NodePgDatabase;
    keys: MasterKeyProvider;
    client: FacebookHttpClient;
    policy: ActionPolicy;
  },
  input: z.input<typeof commandSchema>,
): Promise<FacebookDmOutcome> {
  const command = commandSchema.parse(input);
  const action: FacebookDmActionKey = {
    workspaceId: command.workspaceId,
    accountId: command.accountId,
    conversationId: command.conversationId,
    text: command.text,
    clientActionId: command.clientActionId,
    actor: command.actor,
    requestFingerprint: createHash('sha256')
      .update(
        JSON.stringify({
          accountId: command.accountId,
          conversationId: command.conversationId,
          text: command.text,
        }),
      )
      .digest('hex'),
  };
  await withTenantTransaction(runtime.database, command, (transaction) =>
    enforceWorkspaceAction(transaction, runtime.policy, {
      workspaceId: command.workspaceId,
      actor: command.actor,
      action: 'engagement.send',
      request: { provider: 'facebook_page', providerAccountIds: [command.accountId] },
      requestedProviderAccountIds: [command.accountId],
    }),
  );
  const existing = await findFacebookDmAction(runtime.database, action);
  if (existing) return replay(existing);
  if (await isPageConversationNoGo(runtime.database, command)) throw new FacebookDmNoGoError();
  return withPageReadToken(runtime, { ...command, module: 'dms' }, async (pageId, token) => {
    const recipient = await findEligibleRecipient(
      runtime.client,
      command.conversationId,
      pageId,
      token,
      Date.now(),
      command.expectedLatestInboundMessageId,
    );
    if (await isPageConversationNoGo(runtime.database, command)) throw new FacebookDmNoGoError();
    const reservation = await reserveFacebookDmAction(runtime.database, {
      ...action,
      receiverLabel: recipient.label,
    });
    if (reservation.kind !== 'new') return replay(reservation);
    // The intent has committed before provider I/O. The shared account lock orders
    // a block against the actual dispatch, not merely against an earlier preflight.
    const dispatch = await withTenantTransaction(runtime.database, command, async (tx) => {
      await lockPageDmAccount(tx, command);
      if (await isPageConversationNoGoInTransaction(tx, command)) return null;
      try {
        const messageId = await runtime.client.sendPageMessage({
          pageId,
          recipientId: recipient.id,
          text: command.text,
          accessToken: token,
        });
        return { outcome: { state: 'confirmed', messageId } as const };
      } catch (error) {
        const isDefiniteFailure =
          error instanceof FacebookRequestError &&
          !error.outcomeUnknown &&
          error.evidence.status >= 400 &&
          error.evidence.status < 500;
        return isDefiniteFailure && error instanceof FacebookRequestError
          ? {
              outcome: { state: 'failed', failureStatus: error.evidence.status } as const,
              failureEvidence: {
                code: error.evidence.code,
                subcode: error.evidence.subcode,
                traceId: error.evidence.traceId,
                isTransient: error.evidence.isTransient,
              },
            }
          : { outcome: { state: 'unknown' } as const };
      }
    });
    const outcome: FacebookDmOutcome = dispatch?.outcome ?? { state: 'failed', failureStatus: 403 };
    await settleFacebookDmAction(runtime.database, {
      ...action,
      reservationId: reservation.id,
      outcome,
      ...(dispatch && 'failureEvidence' in dispatch
        ? { failureEvidence: dispatch.failureEvidence }
        : {}),
    });
    if (!dispatch) throw new FacebookDmNoGoError();
    return outcome;
  });
}

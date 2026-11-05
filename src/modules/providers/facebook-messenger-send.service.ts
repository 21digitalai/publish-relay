import { createHash } from 'node:crypto';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
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
): Promise<{ id: string; label: string | null }> {
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
  const recentInbound = result.messages.some((message) => {
    const timestamp = Date.parse(message.createdAt);
    return (
      message.senderId === recipient.id &&
      timestamp <= now &&
      timestamp >= now - STANDARD_WINDOW_MS + WINDOW_SAFETY_MS
    );
  });
  if (!recentInbound) throw new FacebookDmWindowClosedError();
  return { id: recipient.id, label: recipient.name?.trim().slice(0, 200) ?? null };
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
  return withPageReadToken(runtime, { ...command, module: 'dms' }, async (pageId, token) => {
    const recipient = await findEligibleRecipient(
      runtime.client,
      command.conversationId,
      pageId,
      token,
      Date.now(),
    );
    const reservation = await reserveFacebookDmAction(runtime.database, {
      ...action,
      receiverLabel: recipient.label,
    });
    if (reservation.kind !== 'new') return replay(reservation);
    let outcome: FacebookDmOutcome;
    try {
      const messageId = await runtime.client.sendPageMessage({
        pageId,
        recipientId: recipient.id,
        text: command.text,
        accessToken: token,
      });
      outcome = { state: 'confirmed', messageId };
    } catch (error) {
      outcome =
        error instanceof FacebookRequestError &&
        !error.outcomeUnknown &&
        error.evidence.status >= 400 &&
        error.evidence.status < 500
          ? { state: 'failed', failureStatus: error.evidence.status }
          : { state: 'unknown' };
    }
    await settleFacebookDmAction(runtime.database, {
      ...action,
      reservationId: reservation.id,
      outcome,
    });
    return outcome;
  });
}

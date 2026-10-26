import { createHash } from 'node:crypto';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import { enforceWorkspaceAction, type ActionPolicy } from '../policy/action-policy.js';
import {
  findFacebookCommentAction,
  reserveFacebookCommentAction,
  settleFacebookCommentAction,
  type FacebookCommentActionKey,
  type FacebookCommentOutcome,
  type FacebookCommentReservation,
} from './facebook-comment-action.repository.js';
import { FacebookRequestError, type FacebookHttpClient } from './facebook-http-client.js';
import {
  PageReadUnavailableError,
  withPageReadToken,
} from './facebook-page-read-context.service.js';

const commandSchema = z.strictObject({
  workspaceId: z.uuid(),
  accountId: z.uuid(),
  postId: z
    .string()
    .regex(/^[0-9]+(?:_[0-9]+)*$/)
    .max(256),
  commentId: z
    .string()
    .regex(/^[0-9]+(?:_[0-9]+)*$/)
    .max(256),
  clientActionId: z.uuid(),
  text: z.string().trim().min(1).max(2000),
  actor: z.strictObject({
    type: z.enum(['user', 'api-key', 'delegated']),
    id: z.uuid(),
  }),
});

export class FacebookCommentActionConflictError extends Error {
  constructor() {
    super('Facebook comment action ID conflicts with a prior request');
  }
}

function replay(reservation: FacebookCommentReservation): FacebookCommentOutcome {
  if (reservation.kind === 'conflict') throw new FacebookCommentActionConflictError();
  if (reservation.kind === 'new') throw new Error('Expected an existing Facebook comment action');
  return reservation.outcome;
}

/** One Page-local comment reply, never an automatic retry. */
export async function sendAccountPageCommentReply(
  runtime: {
    database: NodePgDatabase;
    keys: MasterKeyProvider;
    client: FacebookHttpClient;
    policy: ActionPolicy;
  },
  input: z.input<typeof commandSchema>,
): Promise<FacebookCommentOutcome> {
  const command = commandSchema.parse(input);
  const action: FacebookCommentActionKey = {
    workspaceId: command.workspaceId,
    accountId: command.accountId,
    commentId: command.commentId,
    clientActionId: command.clientActionId,
    actor: command.actor,
    requestFingerprint: createHash('sha256')
      .update(
        JSON.stringify({
          accountId: command.accountId,
          postId: command.postId,
          commentId: command.commentId,
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
  const existing = await findFacebookCommentAction(runtime.database, action);
  if (existing) return replay(existing);
  return withPageReadToken(
    runtime,
    {
      ...command,
      module: 'comments',
      additionalScopes: ['pages_read_user_content', 'pages_manage_engagement'],
      additionalTasks: ['MODERATE'],
    },
    async (pageId, token) => {
      const ownerPageId = await runtime.client.getPostOwner(command.postId, token);
      if (ownerPageId !== pageId) throw new PageReadUnavailableError();
      const owned = await runtime.client.isCommentUnderPost(
        command.commentId,
        command.postId,
        token,
      );
      if (!owned) throw new PageReadUnavailableError();
      const reservation = await reserveFacebookCommentAction(runtime.database, action);
      if (reservation.kind !== 'new') return replay(reservation);
      let outcome: FacebookCommentOutcome;
      try {
        const commentId = await runtime.client.replyToComment({
          commentId: command.commentId,
          text: command.text,
          accessToken: token,
        });
        outcome = { state: 'confirmed', commentId };
      } catch (error) {
        outcome =
          error instanceof FacebookRequestError &&
          !error.outcomeUnknown &&
          error.evidence.status >= 400 &&
          error.evidence.status < 500
            ? { state: 'failed', failureStatus: error.evidence.status }
            : { state: 'unknown' };
      }
      await settleFacebookCommentAction(runtime.database, {
        ...action,
        reservationId: reservation.id,
        outcome,
      });
      return outcome;
    },
  );
}

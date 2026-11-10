import { createHash } from 'node:crypto';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { enforceWorkspaceAction, type ActionPolicy } from '../policy/action-policy.js';
import {
  reserveFanvueAction,
  settleFanvueAction,
  type FanvueActionReservation,
} from './fanvue-action-intent.repository.js';
import type { FanvueCommentClient } from './fanvue-comment-client.js';
import { FanvueRequestError } from './fanvue-http-client.js';
import { markFanvuePreSendError } from './fanvue-pre-send-error.js';
import {
  replayScheduledFanvueComment,
  scheduleFanvueComment,
} from './fanvue-comment-pending.repository.js';
import type { FanvueReadService } from './fanvue-read.service.js';

const sendInput = z.strictObject({
  workspaceId: z.uuid(),
  accountId: z.uuid(),
  postUuid: z.uuid(),
  clientActionId: z.uuid(),
  text: z.string().min(1).max(600),
  actor: z.strictObject({
    type: z.enum(['user', 'api-key', 'delegated']),
    id: z.uuid(),
  }),
});

export type FanvueCommentResult =
  | { state: 'confirmed'; commentUuid: string }
  | { state: 'failed'; failureStatus: number }
  | { state: 'unknown' };

export class FanvueActionConflictError extends Error {
  constructor() {
    super('Fanvue action ID conflicts with prior input');
  }
}

function replayResult(reservation: FanvueActionReservation): FanvueCommentResult {
  if (reservation.kind === 'conflict') throw new FanvueActionConflictError();
  if (reservation.kind === 'new') throw new Error('Expected an existing Fanvue action');
  if (reservation.state === 'confirmed' && reservation.providerObjectUuid)
    return { state: 'confirmed', commentUuid: reservation.providerObjectUuid };
  if (reservation.state === 'failed' && reservation.failureStatus)
    return { state: 'failed', failureStatus: reservation.failureStatus };
  return { state: 'unknown' };
}

/** This command creates a top-level comment only, never a threaded reply. */
export class FanvueCommentService {
  constructor(
    private readonly database: NodePgDatabase,
    private readonly reads: FanvueReadService,
    private readonly client: FanvueCommentClient,
    private readonly policy: ActionPolicy,
  ) {}

  async preflightScheduledComment(input: z.input<typeof sendInput>): Promise<string | null> {
    const command = sendInput.parse(input);
    try {
      const selected = await this.reads.getOwnedPostForComment(command);
      await withTenantTransaction(this.database, command, (transaction) =>
        enforceWorkspaceAction(transaction, this.policy, {
          workspaceId: command.workspaceId,
          actor: command.actor,
          action: 'engagement.send',
          request: { provider: 'fanvue', providerAccountIds: [command.accountId] },
          requestedProviderAccountIds: [command.accountId],
        }),
      );
      const excerpt = selected.post.text?.trim().slice(0, 160);
      const postedAt = Date.parse(selected.post.createdAt);
      return excerpt?.length
        ? excerpt
        : Number.isFinite(postedAt)
          ? `Media post · ${new Date(postedAt).toISOString().slice(0, 10)}`
          : 'Selected account post';
    } catch (cause) {
      throw markFanvuePreSendError(cause);
    }
  }

  async schedule(input: z.input<typeof sendInput> & { dueAt: Date }) {
    const { dueAt, ...request } = input;
    const command = sendInput.parse(request);
    const prior = await replayScheduledFanvueComment(this.database, {
      ...command,
      dueAt,
    });
    if (prior)
      return {
        clientActionId: prior.clientActionId,
        status: prior.status,
        dueAt: prior.dueAt.toISOString(),
      };
    const targetLabel = await this.preflightScheduledComment(command);
    const row = await scheduleFanvueComment(this.database, {
      ...command,
      targetLabel,
      dueAt,
    });
    return {
      clientActionId: row.clientActionId,
      status: row.status,
      dueAt: row.dueAt.toISOString(),
    };
  }

  async send(
    input: z.input<typeof sendInput>,
    scheduledLeaseOwner?: string,
  ): Promise<FanvueCommentResult> {
    const command = sendInput.parse(input);
    let accessToken: string;
    let targetLabel: string | null;
    try {
      const selected = await this.reads.getOwnedPostForComment(command);
      accessToken = selected.accessToken;
      const excerpt = selected.post.text?.trim().slice(0, 160);
      const postedAt = Date.parse(selected.post.createdAt);
      targetLabel = excerpt?.length
        ? excerpt
        : Number.isFinite(postedAt)
          ? `Media post · ${new Date(postedAt).toISOString().slice(0, 10)}`
          : 'Selected account post';
      await withTenantTransaction(this.database, command, (transaction) =>
        enforceWorkspaceAction(transaction, this.policy, {
          workspaceId: command.workspaceId,
          actor: command.actor,
          action: 'engagement.send',
          request: { provider: 'fanvue', providerAccountIds: [command.accountId] },
          requestedProviderAccountIds: [command.accountId],
        }),
      );
    } catch (cause) {
      throw markFanvuePreSendError(cause);
    }
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ postUuid: command.postUuid, text: command.text }))
      .digest('hex');
    const intent = {
      workspaceId: command.workspaceId,
      accountId: command.accountId,
      clientActionId: command.clientActionId,
      actionKind: 'comment' as const,
      targetUuid: command.postUuid,
      requestFingerprint,
      textBody: command.text,
      targetLabel,
      actorType: command.actor.type === 'api-key' ? 'api_key' : command.actor.type,
      actorId: command.actor.id,
      scheduledLeaseOwner,
    };
    const reservation = await reserveFanvueAction(this.database, intent);
    if (reservation.kind !== 'new') return replayResult(reservation);

    let result: FanvueCommentResult;
    try {
      const comment = await this.client.createComment(accessToken, command.postUuid, command.text);
      result = { state: 'confirmed', commentUuid: comment.uuid };
    } catch (error) {
      result =
        error instanceof FanvueRequestError && error.status >= 400 && error.status < 500
          ? { state: 'failed', failureStatus: error.status }
          : { state: 'unknown' };
    }
    const settlement =
      result.state === 'confirmed'
        ? { state: 'confirmed' as const, providerObjectUuid: result.commentUuid }
        : result;
    await settleFanvueAction(this.database, {
      ...intent,
      reservationId: reservation.id,
      result: settlement,
    });
    return result;
  }
}

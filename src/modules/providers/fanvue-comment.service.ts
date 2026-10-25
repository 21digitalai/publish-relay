import { createHash } from 'node:crypto';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import {
  reserveFanvueAction,
  settleFanvueAction,
  type FanvueActionReservation,
} from './fanvue-action-intent.repository.js';
import type { FanvueCommentClient } from './fanvue-comment-client.js';
import { FanvueRequestError } from './fanvue-http-client.js';
import type { FanvueReadService } from './fanvue-read.service.js';

const sendInput = z.strictObject({
  workspaceId: z.uuid(),
  accountId: z.uuid(),
  postUuid: z.uuid(),
  clientActionId: z.uuid(),
  text: z.string().min(1).max(600),
});

export type FanvueCommentResult =
  | { state: 'confirmed'; commentUuid: string }
  | { state: 'failed'; failureStatus: number }
  | { state: 'unknown' };

function replayResult(reservation: FanvueActionReservation): FanvueCommentResult {
  if (reservation.kind === 'conflict')
    throw new Error('Fanvue action ID conflicts with prior input');
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
  ) {}

  async send(input: z.input<typeof sendInput>): Promise<FanvueCommentResult> {
    const command = sendInput.parse(input);
    const { accessToken } = await this.reads.getOwnedPostForComment(command);
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

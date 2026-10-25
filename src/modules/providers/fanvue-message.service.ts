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
import { FanvueRequestError } from './fanvue-http-client.js';
import type { FanvueMessageClient } from './fanvue-message-client.js';
import type { FanvueReadService } from './fanvue-read.service.js';

const textMessage = z.strictObject({
  workspaceId: z.uuid(),
  accountId: z.uuid(),
  fanUuid: z.uuid(),
  clientActionId: z.uuid(),
  text: z.string().min(1).max(5000),
  actor: z.strictObject({
    type: z.enum(['user', 'api-key', 'delegated']),
    id: z.uuid(),
  }),
});

export type FanvueTextMessageResult =
  | { state: 'confirmed'; messageUuid: string }
  | { state: 'failed'; failureStatus: number }
  | { state: 'unknown' };

function replayResult(reservation: FanvueActionReservation): FanvueTextMessageResult {
  if (reservation.kind === 'conflict')
    throw new Error('Fanvue action ID conflicts with prior input');
  if (reservation.kind === 'new') throw new Error('Expected an existing Fanvue action');
  if (reservation.state === 'confirmed' && reservation.providerObjectUuid)
    return { state: 'confirmed', messageUuid: reservation.providerObjectUuid };
  if (reservation.state === 'failed' && reservation.failureStatus)
    return { state: 'failed', failureStatus: reservation.failureStatus };
  return { state: 'unknown' };
}

/** Text-only command; ready free/paid media must use a separately proved local media binding. */
export class FanvueMessageService {
  constructor(
    private readonly database: NodePgDatabase,
    private readonly reads: FanvueReadService,
    private readonly client: FanvueMessageClient,
    private readonly policy: ActionPolicy,
  ) {}

  async sendText(input: z.input<typeof textMessage>): Promise<FanvueTextMessageResult> {
    const command = textMessage.parse(input);
    const { accessToken } = await this.reads.getExistingChatForMessage(command);
    await withTenantTransaction(this.database, command, (transaction) =>
      enforceWorkspaceAction(transaction, this.policy, {
        workspaceId: command.workspaceId,
        actor: command.actor,
        action: 'engagement.send',
        request: { provider: 'fanvue', providerAccountIds: [command.accountId] },
        requestedProviderAccountIds: [command.accountId],
      }),
    );
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ fanUuid: command.fanUuid, text: command.text }))
      .digest('hex');
    const intent = {
      workspaceId: command.workspaceId,
      accountId: command.accountId,
      clientActionId: command.clientActionId,
      actionKind: 'message' as const,
      targetUuid: command.fanUuid,
      requestFingerprint,
    };
    const reservation = await reserveFanvueAction(this.database, intent);
    if (reservation.kind !== 'new') return replayResult(reservation);

    let result: FanvueTextMessageResult;
    try {
      const message = await this.client.sendMessage(accessToken, command.fanUuid, {
        text: command.text,
      });
      result = { state: 'confirmed', messageUuid: message.messageUuid };
    } catch (error) {
      result =
        error instanceof FanvueRequestError && error.status >= 400 && error.status < 500
          ? { state: 'failed', failureStatus: error.status }
          : { state: 'unknown' };
    }
    const settlement =
      result.state === 'confirmed'
        ? { state: 'confirmed' as const, providerObjectUuid: result.messageUuid }
        : result;
    await settleFanvueAction(this.database, {
      ...intent,
      reservationId: reservation.id,
      result: settlement,
    });
    return result;
  }
}

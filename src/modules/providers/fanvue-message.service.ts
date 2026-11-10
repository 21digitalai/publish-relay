import { createHash } from 'node:crypto';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { enforceWorkspaceAction, type ActionPolicy } from '../policy/action-policy.js';
import {
  findFanvueAction,
  reserveFanvueAction,
  settleFanvueAction,
  type FanvueActionReservation,
} from './fanvue-action-intent.repository.js';
import { getReadyFanvueDmMedia } from './fanvue-dm-ready-media.repository.js';
import {
  cancelPendingFanvueDm,
  findPendingFanvueDm,
  replayScheduledFanvueDm,
  scheduleFanvueDm,
  scheduleInput,
} from './fanvue-dm-pending.repository.js';
import { FanvueRequestError } from './fanvue-http-client.js';
import { markFanvuePreSendError } from './fanvue-pre-send-error.js';
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
const messageCommand = textMessage
  .omit({ text: true })
  .extend({
    text: z.string().min(1).max(5000).optional(),
    mediaUuids: z.array(z.uuid()).min(1).max(10).optional(),
    mediaIds: z.array(z.uuid()).min(1).max(10).optional(),
    mediaPreviewUuid: z.uuid().optional(),
    mediaPreviewId: z.uuid().optional(),
    price: z.number().int().min(300).optional(),
  })
  .superRefine((value, context) => {
    if (!value.text && !value.mediaUuids?.length && !value.mediaIds?.length)
      context.addIssue({ code: 'custom', message: 'Text or media is required' });
    if (value.mediaUuids && value.mediaIds)
      context.addIssue({ code: 'custom', message: 'Choose local or provider media, not both' });
    if (value.mediaUuids && new Set(value.mediaUuids).size !== value.mediaUuids.length)
      context.addIssue({ code: 'custom', message: 'Duplicate media is not allowed' });
    if (value.mediaIds && new Set(value.mediaIds).size !== value.mediaIds.length)
      context.addIssue({ code: 'custom', message: 'Duplicate media is not allowed' });
    if (value.price !== undefined && !value.mediaUuids?.length && !value.mediaIds?.length)
      context.addIssue({ code: 'custom', message: 'Priced messages require media' });
    if (
      value.mediaPreviewUuid &&
      (value.price === undefined || !value.mediaUuids?.includes(value.mediaPreviewUuid))
    )
      context.addIssue({ code: 'custom', message: 'Preview must be attached to priced media' });
    if (
      value.mediaPreviewId &&
      (value.price === undefined || !value.mediaIds?.includes(value.mediaPreviewId))
    )
      context.addIssue({ code: 'custom', message: 'Preview must be attached to priced media' });
  });
const createChatCommand = textMessage
  .pick({
    workspaceId: true,
    accountId: true,
    fanUuid: true,
    clientActionId: true,
    actor: true,
  })
  .extend({
    audience: z.enum(['followers', 'subscribers']),
    page: z.number().int().positive().optional(),
    cursor: z.string().min(1).max(1024).optional(),
    size: z.number().int().min(1).max(50).default(15),
  })
  .superRefine((value, context) => {
    if ((value.page === undefined) === (value.cursor === undefined))
      context.addIssue({ code: 'custom', message: 'Select one Audience page or cursor' });
    if (value.audience === 'followers' && value.cursor !== undefined)
      context.addIssue({ code: 'custom', message: 'Follower selection requires a page' });
  });

export type FanvueTextMessageResult =
  | { state: 'confirmed'; messageUuid: string }
  | { state: 'failed'; failureStatus: number }
  | { state: 'unknown' };

export class FanvueMessageActionConflictError extends Error {
  constructor() {
    super('Fanvue action ID conflicts with prior input');
  }
}

export class FanvueMessageMediaUnavailableError extends Error {
  constructor() {
    super('Fanvue media is not ready for this account');
  }
}

export class FanvueSelectedFanUnavailableError extends Error {
  constructor() {
    super('Selected fan is no longer on this account Audience page');
  }
}

function replayResult(reservation: FanvueActionReservation): FanvueTextMessageResult {
  if (reservation.kind === 'conflict') throw new FanvueMessageActionConflictError();
  if (reservation.kind === 'new') throw new Error('Expected an existing Fanvue action');
  if (reservation.state === 'confirmed' && reservation.providerObjectUuid)
    return { state: 'confirmed', messageUuid: reservation.providerObjectUuid };
  if (reservation.state === 'failed' && reservation.failureStatus)
    return { state: 'failed', failureStatus: reservation.failureStatus };
  return { state: 'unknown' };
}

function replayChatCreate(
  reservation: FanvueActionReservation,
):
  | { state: 'confirmed'; fanUuid: string }
  | { state: 'failed'; failureStatus: number }
  | { state: 'unknown' } {
  if (reservation.kind === 'conflict') throw new FanvueMessageActionConflictError();
  if (reservation.kind === 'new') throw new Error('Expected an existing Fanvue chat action');
  if (reservation.state === 'confirmed' && reservation.providerObjectUuid)
    return { state: 'confirmed', fanUuid: reservation.providerObjectUuid };
  if (reservation.state === 'failed' && reservation.failureStatus)
    return { state: 'failed', failureStatus: reservation.failureStatus };
  return { state: 'unknown' };
}

/** Existing provider media is account-scoped and rechecked before the same durable send intent. */
export class FanvueMessageService {
  constructor(
    private readonly database: NodePgDatabase,
    private readonly reads: FanvueReadService,
    private readonly client: FanvueMessageClient,
    private readonly policy: ActionPolicy,
  ) {}

  async scheduleMessage(input: z.input<typeof scheduleInput>) {
    const command = scheduleInput.parse(input);
    const replay = await replayScheduledFanvueDm(this.database, command);
    if (replay) return replay;
    let targetLabel: string | null;
    try {
      ({ targetLabel } = await this.reads.getExistingChatForMessage(command));
      await this.resolveMedia(command);
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
    return scheduleFanvueDm(this.database, {
      workspaceId: command.workspaceId,
      accountId: command.accountId,
      fanUuid: command.fanUuid,
      clientActionId: command.clientActionId,
      actor: command.actor,
      targetLabel,
      ...(command.text ? { text: command.text } : {}),
      ...(command.mediaIds ? { mediaIds: command.mediaIds } : {}),
      ...(command.mediaPreviewId ? { mediaPreviewId: command.mediaPreviewId } : {}),
      ...(command.price !== undefined ? { price: command.price } : {}),
      dueAt: input.dueAt,
    });
  }

  async scheduledMessageStatus(input: {
    workspaceId: string;
    accountId: string;
    fanUuid: string;
    clientActionId: string;
  }) {
    const intent = await findPendingFanvueDm(this.database, input);
    if (!intent) return null;
    return {
      clientActionId: intent.clientActionId,
      status: intent.status,
      dueAt: intent.dueAt.toISOString(),
    };
  }

  async cancelScheduledMessage(input: {
    workspaceId: string;
    accountId: string;
    fanUuid: string;
    clientActionId: string;
  }) {
    return cancelPendingFanvueDm(this.database, input);
  }

  async createChat(
    input: z.input<typeof createChatCommand>,
  ): Promise<
    | { state: 'confirmed'; fanUuid: string }
    | { state: 'failed'; failureStatus: number }
    | { state: 'unknown' }
  > {
    const command = createChatCommand.parse(input);
    const accessToken = await this.reads.getChatCreateToken(command);
    await withTenantTransaction(this.database, command, (transaction) =>
      enforceWorkspaceAction(transaction, this.policy, {
        workspaceId: command.workspaceId,
        actor: command.actor,
        action: 'engagement.send',
        request: { provider: 'fanvue', providerAccountIds: [command.accountId] },
        requestedProviderAccountIds: [command.accountId],
      }),
    );
    const intent = {
      workspaceId: command.workspaceId,
      accountId: command.accountId,
      clientActionId: command.clientActionId,
      actionKind: 'chat_create' as const,
      targetUuid: command.fanUuid,
      requestFingerprint: createHash('sha256')
        .update(
          JSON.stringify({
            operation: 'chat_create',
            fanUuid: command.fanUuid,
            audience: command.audience,
            page: command.page,
            cursor: command.cursor,
            size: command.size,
          }),
        )
        .digest('hex'),
    };
    const existing = await findFanvueAction(this.database, intent);
    if (existing) return replayChatCreate(existing);
    const audience =
      command.audience === 'followers'
        ? await this.reads.listFollowers({
            workspaceId: command.workspaceId,
            accountId: command.accountId,
            ...(command.page !== undefined ? { page: command.page } : {}),
            size: command.size,
          })
        : await this.reads.listSubscribers({
            workspaceId: command.workspaceId,
            accountId: command.accountId,
            ...(command.page !== undefined ? { page: command.page } : {}),
            ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
            size: command.size,
          });
    if (!audience.data.some((person) => person.uuid === command.fanUuid))
      throw new FanvueSelectedFanUnavailableError();
    const reservation = await reserveFanvueAction(this.database, intent);
    if (reservation.kind !== 'new') return replayChatCreate(reservation);
    let result:
      | { state: 'confirmed'; providerObjectUuid: string }
      | { state: 'failed'; failureStatus: number }
      | { state: 'unknown' };
    try {
      await this.client.createChat(accessToken, command.fanUuid);
      result = { state: 'confirmed', providerObjectUuid: command.fanUuid };
    } catch (error) {
      result =
        error instanceof FanvueRequestError && error.status >= 400 && error.status < 500
          ? { state: 'failed', failureStatus: error.status }
          : { state: 'unknown' };
    }
    await settleFanvueAction(this.database, {
      ...intent,
      reservationId: reservation.id,
      result,
    });
    if (result.state === 'confirmed') return { state: 'confirmed', fanUuid: command.fanUuid };
    return result;
  }

  async sendText(input: z.input<typeof textMessage>): Promise<FanvueTextMessageResult> {
    return this.sendMessage(textMessage.parse(input));
  }

  async sendMessage(input: z.input<typeof messageCommand>): Promise<FanvueTextMessageResult> {
    const command = messageCommand.parse(input);
    let accessToken: string;
    let targetLabel: string | null;
    let mediaUuids: string[] | undefined;
    let mediaPreviewUuid: string | undefined;
    try {
      ({ accessToken, targetLabel } = await this.reads.getExistingChatForMessage(command));
      ({ mediaUuids, mediaPreviewUuid } = await this.resolveMedia(command));
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
      .update(
        JSON.stringify({
          fanUuid: command.fanUuid,
          text: command.text,
          mediaIds: command.mediaIds,
          mediaUuids,
          mediaPreviewUuid,
          price: command.price,
        }),
      )
      .digest('hex');
    const intent = {
      workspaceId: command.workspaceId,
      accountId: command.accountId,
      clientActionId: command.clientActionId,
      actionKind: 'message' as const,
      targetUuid: command.fanUuid,
      requestFingerprint,
      textBody: command.text ?? null,
      targetLabel,
      mediaCount: mediaUuids?.length ?? 0,
      priceCents: command.price ?? null,
    };
    const reservation = await reserveFanvueAction(this.database, intent);
    if (reservation.kind !== 'new') return replayResult(reservation);

    let result: FanvueTextMessageResult;
    try {
      const message = await this.client.sendMessage(accessToken, command.fanUuid, {
        ...(command.text ? { text: command.text } : {}),
        ...(mediaUuids ? { mediaUuids } : {}),
        ...(mediaPreviewUuid ? { mediaPreviewUuid } : {}),
        ...(command.price !== undefined ? { price: command.price } : {}),
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

  private async resolveMedia(command: z.output<typeof messageCommand>) {
    const ready = command.mediaIds
      ? await getReadyFanvueDmMedia(this.database, {
          workspaceId: command.workspaceId,
          accountId: command.accountId,
          clientActionId: command.clientActionId,
          mediaIds: command.mediaIds,
        })
      : null;
    if (command.mediaIds && ready?.size !== command.mediaIds.length)
      throw new FanvueMessageMediaUnavailableError();
    const mediaUuids = command.mediaIds
      ? command.mediaIds.map((id) => ready?.get(id) ?? '')
      : command.mediaUuids;
    const mediaPreviewUuid = command.mediaPreviewId
      ? ready?.get(command.mediaPreviewId)
      : command.mediaPreviewUuid;
    for (const mediaUuid of mediaUuids ?? []) {
      if (!mediaUuid) throw new FanvueMessageMediaUnavailableError();
      const media = await this.reads.getMediaStatus({
        workspaceId: command.workspaceId,
        accountId: command.accountId,
        mediaUuid,
      });
      if (media.uuid !== mediaUuid || media.status !== 'ready')
        throw new FanvueMessageMediaUnavailableError();
    }
    return { mediaUuids, mediaPreviewUuid };
  }
}

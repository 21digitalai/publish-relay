import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import {
  fanvueActionIntents,
  fanvueDmPendingIntents,
  providerAccounts,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export const scheduleInput = z
  .strictObject({
    workspaceId: z.uuid(),
    accountId: z.uuid(),
    fanUuid: z.uuid(),
    clientActionId: z.uuid(),
    actor: z.strictObject({ type: z.enum(['user', 'api-key', 'delegated']), id: z.uuid() }),
    text: z.string().min(1).max(5000).optional(),
    mediaIds: z.array(z.uuid()).min(1).max(10).optional(),
    mediaPreviewId: z.uuid().optional(),
    price: z.number().int().min(300).optional(),
    dueAt: z.date(),
  })
  .superRefine((input, context) => {
    if (!input.text && !input.mediaIds?.length)
      context.addIssue({ code: 'custom', message: 'Text or media is required' });
    if (input.price !== undefined && !input.mediaIds?.length)
      context.addIssue({ code: 'custom', message: 'Priced messages require media' });
    if (input.mediaIds && new Set(input.mediaIds).size !== input.mediaIds.length)
      context.addIssue({ code: 'custom', message: 'Duplicate media is not allowed' });
    if (
      input.mediaPreviewId &&
      (input.price === undefined || !input.mediaIds?.includes(input.mediaPreviewId))
    )
      context.addIssue({ code: 'custom', message: 'Preview must be attached to priced media' });
  });

export class FanvueDmScheduleConflictError extends Error {
  constructor() {
    super('Scheduled Fanvue DM action ID conflicts with prior input');
  }
}

const projection = {
  id: fanvueDmPendingIntents.id,
  workspaceId: fanvueDmPendingIntents.workspaceId,
  accountId: fanvueDmPendingIntents.accountId,
  fanUuid: fanvueDmPendingIntents.fanUuid,
  clientActionId: fanvueDmPendingIntents.clientActionId,
  actorType: fanvueDmPendingIntents.actorType,
  actorId: fanvueDmPendingIntents.actorId,
  text: fanvueDmPendingIntents.textBody,
  mediaIds: fanvueDmPendingIntents.mediaIds,
  mediaPreviewId: fanvueDmPendingIntents.mediaPreviewId,
  price: fanvueDmPendingIntents.priceCents,
  dueAt: fanvueDmPendingIntents.dueAt,
  status: fanvueDmPendingIntents.status,
};

/** Timing state only. The due worker must use the canonical FanvueMessageService sender. */
export async function scheduleFanvueDm(
  database: NodePgDatabase,
  unparsed: z.input<typeof scheduleInput>,
) {
  const input = scheduleInput.parse(unparsed);
  const actorType = input.actor.type === 'api-key' ? 'api_key' : input.actor.type;
  const mediaIds = input.mediaIds ?? [];
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        accountId: input.accountId,
        fanUuid: input.fanUuid,
        actorType,
        actorId: input.actor.id,
        text: input.text ?? null,
        mediaIds,
        mediaPreviewId: input.mediaPreviewId ?? null,
        price: input.price ?? null,
        dueAt: input.dueAt.toISOString(),
      }),
    )
    .digest('hex');
  return withTenantTransaction(database, input, async (tx) => {
    const [account] = await tx
      .select({ provider: providerAccounts.destinationProvider })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          eq(providerAccounts.id, input.accountId),
        ),
      )
      .limit(1);
    if (account?.provider !== 'fanvue') throw new FanvueDmScheduleConflictError();
    const [action] = await tx
      .select({ id: fanvueActionIntents.id })
      .from(fanvueActionIntents)
      .where(
        and(
          eq(fanvueActionIntents.workspaceId, input.workspaceId),
          eq(fanvueActionIntents.clientActionId, input.clientActionId),
        ),
      )
      .limit(1);
    if (action) throw new FanvueDmScheduleConflictError();
    const [inserted] = await tx
      .insert(fanvueDmPendingIntents)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        fanUuid: input.fanUuid,
        clientActionId: input.clientActionId,
        actorType,
        actorId: input.actor.id,
        textBody: input.text ?? null,
        mediaIds,
        mediaPreviewId: input.mediaPreviewId ?? null,
        priceCents: input.price ?? null,
        dueAt: input.dueAt,
      })
      .onConflictDoNothing()
      .returning(projection);
    if (inserted) return inserted;
    const [existing] = await tx
      .select(projection)
      .from(fanvueDmPendingIntents)
      .where(
        and(
          eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
          eq(fanvueDmPendingIntents.clientActionId, input.clientActionId),
        ),
      )
      .limit(1);
    if (!existing) throw new FanvueDmScheduleConflictError();
    const same =
      createHash('sha256')
        .update(
          JSON.stringify({
            accountId: existing.accountId,
            fanUuid: existing.fanUuid,
            actorType: existing.actorType,
            actorId: existing.actorId,
            text: existing.text,
            mediaIds: existing.mediaIds,
            mediaPreviewId: existing.mediaPreviewId,
            price: existing.price,
            dueAt: existing.dueAt.toISOString(),
          }),
        )
        .digest('hex') === fingerprint;
    if (!same) throw new FanvueDmScheduleConflictError();
    return existing;
  });
}

export async function cancelPendingFanvueDm(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; fanUuid: string; clientActionId: string },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [cancelled] = await tx
      .update(fanvueDmPendingIntents)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
          eq(fanvueDmPendingIntents.accountId, input.accountId),
          eq(fanvueDmPendingIntents.fanUuid, input.fanUuid),
          eq(fanvueDmPendingIntents.clientActionId, input.clientActionId),
          eq(fanvueDmPendingIntents.status, 'pending'),
        ),
      )
      .returning({ id: fanvueDmPendingIntents.id });
    return Boolean(cancelled);
  });
}

export async function findPendingFanvueDm(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; fanUuid: string; clientActionId: string },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [intent] = await tx
      .select(projection)
      .from(fanvueDmPendingIntents)
      .where(
        and(
          eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
          eq(fanvueDmPendingIntents.accountId, input.accountId),
          eq(fanvueDmPendingIntents.fanUuid, input.fanUuid),
          eq(fanvueDmPendingIntents.clientActionId, input.clientActionId),
        ),
      )
      .limit(1);
    return intent ?? null;
  });
}

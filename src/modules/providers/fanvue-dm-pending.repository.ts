import { createHash, randomInt, randomUUID } from 'node:crypto';

import { and, eq, isNull, lte, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import {
  fanvueActionIntents,
  fanvueDmDispatchPacing,
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
    targetLabel: z.string().min(1).max(160).nullable().optional(),
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
  targetLabel: fanvueDmPendingIntents.targetLabel,
  mediaIds: fanvueDmPendingIntents.mediaIds,
  mediaPreviewId: fanvueDmPendingIntents.mediaPreviewId,
  price: fanvueDmPendingIntents.priceCents,
  dueAt: fanvueDmPendingIntents.dueAt,
  status: fanvueDmPendingIntents.status,
  leaseOwner: fanvueDmPendingIntents.leaseOwner,
};

function pendingFingerprint(value: {
  accountId: string;
  fanUuid: string;
  actorType: string;
  actorId: string;
  text: string | null;
  mediaIds: string[];
  mediaPreviewId: string | null;
  price: number | null;
  dueAt: Date;
}) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        accountId: value.accountId,
        fanUuid: value.fanUuid,
        actorType: value.actorType,
        actorId: value.actorId,
        text: value.text,
        mediaIds: value.mediaIds,
        mediaPreviewId: value.mediaPreviewId,
        price: value.price,
        dueAt: value.dueAt.toISOString(),
      }),
    )
    .digest('hex');
}

function expectedFingerprint(input: z.output<typeof scheduleInput>) {
  return pendingFingerprint({
    accountId: input.accountId,
    fanUuid: input.fanUuid,
    actorType: input.actor.type === 'api-key' ? 'api_key' : input.actor.type,
    actorId: input.actor.id,
    text: input.text ?? null,
    mediaIds: input.mediaIds ?? [],
    mediaPreviewId: input.mediaPreviewId ?? null,
    price: input.price ?? null,
    dueAt: input.dueAt,
  });
}

export async function replayScheduledFanvueDm(
  database: NodePgDatabase,
  unparsed: z.input<typeof scheduleInput>,
) {
  const input = scheduleInput.parse(unparsed);
  const prior = await findPendingFanvueDm(database, input);
  if (!prior) return null;
  if (pendingFingerprint(prior) !== expectedFingerprint(input))
    throw new FanvueDmScheduleConflictError();
  return prior;
}

/** Timing state only. The due worker must use the canonical FanvueMessageService sender. */
export async function scheduleFanvueDm(
  database: NodePgDatabase,
  unparsed: z.input<typeof scheduleInput>,
) {
  const input = scheduleInput.parse(unparsed);
  const actorType = input.actor.type === 'api-key' ? 'api_key' : input.actor.type;
  const mediaIds = input.mediaIds ?? [];
  const fingerprint = expectedFingerprint(input);
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
        targetLabel: input.targetLabel ?? null,
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
    const same = pendingFingerprint(existing) === fingerprint;
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

/** Worker BYPASSRLS is used only to choose a due row; the account lock serializes pacing. */
export async function claimDueFanvueDm(
  database: NodePgDatabase,
  input: { workerId: string; now: Date; leaseMs: number },
) {
  return database.transaction(async (tx) => {
    const [candidate] = await tx
      .select({
        id: fanvueDmPendingIntents.id,
        workspaceId: fanvueDmPendingIntents.workspaceId,
        accountId: fanvueDmPendingIntents.accountId,
      })
      .from(fanvueDmPendingIntents)
      .leftJoin(
        fanvueDmDispatchPacing,
        and(
          eq(fanvueDmDispatchPacing.workspaceId, fanvueDmPendingIntents.workspaceId),
          eq(fanvueDmDispatchPacing.accountId, fanvueDmPendingIntents.accountId),
        ),
      )
      .where(
        and(
          lte(fanvueDmPendingIntents.dueAt, input.now),
          or(
            isNull(fanvueDmDispatchPacing.accountId),
            lte(fanvueDmDispatchPacing.nextAt, input.now),
          ),
          or(
            eq(fanvueDmPendingIntents.status, 'pending'),
            and(
              eq(fanvueDmPendingIntents.status, 'claimed'),
              lte(fanvueDmPendingIntents.leaseUntil, input.now),
            ),
          ),
        ),
      )
      .orderBy(fanvueDmPendingIntents.dueAt, fanvueDmPendingIntents.id)
      .limit(1);
    if (!candidate) return null;
    const [account] = await tx
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.workspaceId, candidate.workspaceId),
          eq(providerAccounts.id, candidate.accountId),
        ),
      )
      .limit(1)
      .for('update', { skipLocked: true });
    if (!account) return null;
    const [pacing] = await tx
      .select({ nextAt: fanvueDmDispatchPacing.nextAt })
      .from(fanvueDmDispatchPacing)
      .where(
        and(
          eq(fanvueDmDispatchPacing.workspaceId, candidate.workspaceId),
          eq(fanvueDmDispatchPacing.accountId, candidate.accountId),
        ),
      )
      .limit(1);
    if (pacing && pacing.nextAt > input.now) return null;
    const [claimed] = await tx
      .update(fanvueDmPendingIntents)
      .set({
        status: 'claimed',
        leaseOwner: `${input.workerId}:${randomUUID()}`,
        leaseUntil: new Date(input.now.getTime() + input.leaseMs),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(fanvueDmPendingIntents.id, candidate.id),
          lte(fanvueDmPendingIntents.dueAt, input.now),
          or(
            eq(fanvueDmPendingIntents.status, 'pending'),
            and(
              eq(fanvueDmPendingIntents.status, 'claimed'),
              lte(fanvueDmPendingIntents.leaseUntil, input.now),
            ),
          ),
        ),
      )
      .returning(projection);
    if (!claimed) return null;
    const nextAt = new Date(input.now.getTime() + randomInt(60, 121) * 1000);
    await tx
      .insert(fanvueDmDispatchPacing)
      .values({ workspaceId: candidate.workspaceId, accountId: candidate.accountId, nextAt })
      .onConflictDoUpdate({
        target: [fanvueDmDispatchPacing.workspaceId, fanvueDmDispatchPacing.accountId],
        set: { nextAt },
      });
    return claimed;
  });
}

export async function renewClaimedFanvueDm(
  database: NodePgDatabase,
  input: { workspaceId: string; id: string; leaseOwner: string; leaseMs: number },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [renewed] = await tx
      .update(fanvueDmPendingIntents)
      .set({ leaseUntil: new Date(Date.now() + input.leaseMs), updatedAt: new Date() })
      .where(
        and(
          eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
          eq(fanvueDmPendingIntents.id, input.id),
          eq(fanvueDmPendingIntents.status, 'claimed'),
          eq(fanvueDmPendingIntents.leaseOwner, input.leaseOwner),
        ),
      )
      .returning({ id: fanvueDmPendingIntents.id });
    return Boolean(renewed);
  });
}

/** A pre-reservation failure may retry; a durable action must never be sent again. */
export async function finishClaimedFanvueDm(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    id: string;
    leaseOwner: string;
    state: 'confirmed' | 'failed' | 'unknown' | 'pending';
  },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [intent] = await tx
      .select({ clientActionId: fanvueDmPendingIntents.clientActionId })
      .from(fanvueDmPendingIntents)
      .where(
        and(
          eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
          eq(fanvueDmPendingIntents.id, input.id),
          eq(fanvueDmPendingIntents.status, 'claimed'),
          eq(fanvueDmPendingIntents.leaseOwner, input.leaseOwner),
        ),
      )
      .for('update');
    if (!intent) return false;
    if (input.state === 'pending') {
      const [action] = await tx
        .select({ id: fanvueActionIntents.id })
        .from(fanvueActionIntents)
        .where(
          and(
            eq(fanvueActionIntents.workspaceId, input.workspaceId),
            eq(fanvueActionIntents.clientActionId, intent.clientActionId),
          ),
        )
        .limit(1);
      if (action) throw new Error('Cannot retry Fanvue DM after action reservation');
    }
    const [settled] = await tx
      .update(fanvueDmPendingIntents)
      .set({
        status: input.state,
        leaseOwner: null,
        leaseUntil: null,
        dueAt: input.state === 'pending' ? new Date(Date.now() + 30_000) : undefined,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
          eq(fanvueDmPendingIntents.id, input.id),
          eq(fanvueDmPendingIntents.status, 'claimed'),
          eq(fanvueDmPendingIntents.leaseOwner, input.leaseOwner),
        ),
      )
      .returning({ id: fanvueDmPendingIntents.id });
    return Boolean(settled);
  });
}

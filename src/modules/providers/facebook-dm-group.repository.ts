import { createHash, randomInt, randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  facebookPageDmActions,
  facebookPageDmDispatchPacing,
  facebookPageDmPendingIntents,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  MessageGroupValidationError,
  validateMessageGroupBubbles,
} from '../engagement/message-group.js';
import {
  isPageConversationNoGoInTransaction,
  lockPageDmAccount,
} from './facebook-dm-no-go.repository.js';
import { PendingDmConflictError, PendingDmNoGoError } from './facebook-dm-pending.repository.js';
import { hasPageDmBioLinkMention } from './facebook-dm-bio-link.repository.js';
import {
  hasFreshInboundAfterFirstConfirmedDailyGroup,
  pageDmCivilDay,
} from './facebook-dm-active-days.repository.js';
import { getPageDmDailyGroupLimitInTransaction } from './facebook-page-engagement.service.js';
import { planPageDmRootPriority } from './facebook-dm-root-priority.js';

const MAX_PRIORITY_ROOTS = 1000;

interface GroupKey {
  workspaceId: string;
  accountId: string;
  conversationId: string;
}

interface GroupRequest extends GroupKey {
  dueAt?: string | undefined;
  clientActionId: string;
  texts: string[];
  finalExit?: boolean | undefined;
  bioLinkMention?: boolean | undefined;
  expectedLatestInboundMessageId: string;
  latestInboundAt?: Date | undefined;
  windowDeadline: Date;
  actor: { type: 'api-key' | 'delegated' | 'user'; id: string };
}

function fingerprint(input: Omit<GroupRequest, 'windowDeadline' | 'latestInboundAt'>) {
  if (input.dueAt !== undefined && !Number.isFinite(Date.parse(input.dueAt)))
    throw new PendingDmConflictError('Requested Page DM dueAt must be a valid future instant');
  return createHash('sha256')
    .update(
      JSON.stringify({
        accountId: input.accountId,
        conversationId: input.conversationId,
        texts: input.texts,
        ...(input.dueAt !== undefined ? { dueAt: new Date(input.dueAt).toISOString() } : {}),
        expectedLatestInboundMessageId: input.expectedLatestInboundMessageId,
        ...(input.finalExit ? { finalExit: true } : {}),
        ...(input.bioLinkMention ? { bioLinkMention: true } : {}),
      }),
    )
    .digest('hex');
}

/** Existing exact receipts remain replayable even if Meta is temporarily unavailable. */
export async function findPageDmGroupReplay(
  database: NodePgDatabase,
  input: Omit<GroupRequest, 'windowDeadline' | 'latestInboundAt'>,
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [row] = await tx
      .select({
        id: facebookPageDmPendingIntents.id,
        accountId: facebookPageDmPendingIntents.accountId,
        conversationId: facebookPageDmPendingIntents.conversationId,
        groupId: facebookPageDmPendingIntents.groupId,
        requestFingerprint: facebookPageDmPendingIntents.requestFingerprint,
        actorType: facebookPageDmPendingIntents.actorType,
        actorId: facebookPageDmPendingIntents.actorId,
        status: facebookPageDmPendingIntents.status,
        dueAt: facebookPageDmPendingIntents.dueAt,
      })
      .from(facebookPageDmPendingIntents)
      .where(
        and(
          eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageDmPendingIntents.clientActionId, input.clientActionId),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (
      !row.groupId ||
      row.accountId !== input.accountId ||
      row.conversationId !== input.conversationId ||
      row.requestFingerprint !== fingerprint(input) ||
      row.actorType !== (input.actor.type === 'api-key' ? 'api_key' : input.actor.type) ||
      row.actorId !== input.actor.id
    )
      throw new PendingDmConflictError();
    return { id: row.id, groupId: row.groupId, dueAt: row.dueAt, status: row.status };
  });
}

/** One Page-locked transaction owns the exact root and every waiting tail. */
export async function schedulePageDmGroup(database: NodePgDatabase, input: GroupRequest) {
  try {
    validateMessageGroupBubbles(input.texts, {
      maximumBubbles: 4,
      maximumTextLength: 2_000,
    });
  } catch (error) {
    if (error instanceof MessageGroupValidationError) {
      throw new PendingDmConflictError('A Page DM group requires 1–4 nonempty bubbles');
    }
    throw error;
  }
  return withTenantTransaction(database, input, async (tx) => {
    await lockPageDmAccount(tx, input);
    const actorType = input.actor.type === 'api-key' ? 'api_key' : input.actor.type;
    const requestFingerprint = fingerprint(input);
    const [prior] = await tx
      .select({
        id: facebookPageDmPendingIntents.id,
        groupId: facebookPageDmPendingIntents.groupId,
        dueAt: facebookPageDmPendingIntents.dueAt,
        requestFingerprint: facebookPageDmPendingIntents.requestFingerprint,
        actorType: facebookPageDmPendingIntents.actorType,
        actorId: facebookPageDmPendingIntents.actorId,
        status: facebookPageDmPendingIntents.status,
      })
      .from(facebookPageDmPendingIntents)
      .where(
        and(
          eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageDmPendingIntents.clientActionId, input.clientActionId),
        ),
      )
      .limit(1);
    if (prior) {
      if (
        !prior.groupId ||
        prior.requestFingerprint !== requestFingerprint ||
        prior.actorType !== actorType ||
        prior.actorId !== input.actor.id
      )
        throw new PendingDmConflictError();
      return { id: prior.id, groupId: prior.groupId, dueAt: prior.dueAt, status: prior.status };
    }
    const requestedAt = input.dueAt === undefined ? 0 : Date.parse(input.dueAt);
    if (!Number.isFinite(requestedAt) || (input.dueAt !== undefined && requestedAt <= Date.now()))
      throw new PendingDmConflictError('Requested Page DM dueAt must be a valid future instant');
    const [sent] = await tx
      .select({ id: facebookPageDmActions.id })
      .from(facebookPageDmActions)
      .where(
        and(
          eq(facebookPageDmActions.workspaceId, input.workspaceId),
          eq(facebookPageDmActions.clientActionId, input.clientActionId),
        ),
      )
      .limit(1);
    if (sent) throw new PendingDmConflictError();
    if (await isPageConversationNoGoInTransaction(tx, input)) throw new PendingDmNoGoError();
    if (input.bioLinkMention && (await hasPageDmBioLinkMention(tx, input)))
      throw new PendingDmConflictError(
        'A Page bio-link mention is already confirmed or unresolved',
      );
    const [active] = await tx
      .select({ id: facebookPageDmPendingIntents.id })
      .from(facebookPageDmPendingIntents)
      .where(
        and(
          eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageDmPendingIntents.accountId, input.accountId),
          eq(facebookPageDmPendingIntents.conversationId, input.conversationId),
          inArray(facebookPageDmPendingIntents.status, [
            'pending',
            'waiting',
            'claimed',
            'unknown',
          ]),
        ),
      )
      .limit(1);
    if (active) throw new PendingDmConflictError('Resolve the prior Page DM group first');
    const roots = await tx
      .select({
        id: facebookPageDmPendingIntents.id,
        dueAt: facebookPageDmPendingIntents.dueAt,
        windowDeadline: facebookPageDmPendingIntents.windowDeadline,
        status: facebookPageDmPendingIntents.status,
        preSendAttempts: facebookPageDmPendingIntents.preSendAttempts,
      })
      .from(facebookPageDmPendingIntents)
      .where(
        and(
          eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageDmPendingIntents.accountId, input.accountId),
          or(
            isNull(facebookPageDmPendingIntents.sequenceIndex),
            eq(facebookPageDmPendingIntents.sequenceIndex, 0),
          ),
          inArray(facebookPageDmPendingIntents.status, ['pending', 'claimed']),
        ),
      )
      .orderBy(desc(facebookPageDmPendingIntents.dueAt))
      .limit(MAX_PRIORITY_ROOTS + 1);
    if (roots.length > MAX_PRIORITY_ROOTS)
      throw new PendingDmConflictError('Page DM queue is too large to prioritize safely');
    const dailyLimit = await getPageDmDailyGroupLimitInTransaction(tx, input);
    const minimumGapMs = dailyLimit.pacingMinimumSeconds * 1000;
    const now = Date.now();
    const [cursor] = await tx
      .select({ nextRootAt: facebookPageDmDispatchPacing.nextRootAt })
      .from(facebookPageDmDispatchPacing)
      .where(
        and(
          eq(facebookPageDmDispatchPacing.workspaceId, input.workspaceId),
          eq(facebookPageDmDispatchPacing.accountId, input.accountId),
        ),
      )
      .limit(1);
    const claimedAt = roots
      .filter((root) => root.status === 'claimed')
      .reduce((latest, root) => Math.max(latest, root.dueAt.getTime() + minimumGapMs), 0);
    const earliestAt = new Date(
      Math.max(now + minimumGapMs, requestedAt, claimedAt, cursor?.nextRootAt.getTime() ?? 0),
    );
    const appendAt = new Date(
      Math.max(now, roots[0]?.dueAt.getTime() ?? 0, earliestAt.getTime() - minimumGapMs) +
        randomInt(dailyLimit.pacingMinimumSeconds, dailyLimit.pacingMaximumSeconds + 1) * 1000,
    );
    const plan = planPageDmRootPriority({
      pending: roots
        .filter((root) => root.status === 'pending')
        .map((root) => ({ ...root, immovable: root.preSendAttempts > 0 })),
      newDeadline: input.windowDeadline,
      earliestAt,
      appendAt,
      minimumGapMs,
    });
    if (!plan)
      throw new PendingDmConflictError(
        'The Messenger reply window cannot fit an eligible paced Page DM slot',
      );
    const dueAt = plan.dueAt;
    if (dailyLimit.enabled) {
      for (const change of plan.changes) {
        const original = roots.find((root) => root.id === change.id);
        if (original && pageDmCivilDay(original.dueAt) !== pageDmCivilDay(change.dueAt))
          throw new PendingDmConflictError(
            'Page DM priority would move an existing group to another Sofia day',
          );
      }
      // Page lock serializes all group creations, including separate machine callers.
      const [sameInbound] = await tx
        .select({ id: facebookPageDmPendingIntents.id })
        .from(facebookPageDmPendingIntents)
        .where(
          and(
            eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
            eq(facebookPageDmPendingIntents.accountId, input.accountId),
            eq(facebookPageDmPendingIntents.conversationId, input.conversationId),
            eq(facebookPageDmPendingIntents.sequenceIndex, 0),
            eq(
              facebookPageDmPendingIntents.expectedLatestInboundMessageId,
              input.expectedLatestInboundMessageId,
            ),
          ),
        )
        .limit(1);
      if (sameInbound) throw new PendingDmConflictError('This inbound already has a Page DM group');
      const day = pageDmCivilDay(dueAt);
      const usedDay = await tx
        .select({
          id: facebookPageDmPendingIntents.id,
          status: facebookPageDmPendingIntents.status,
        })
        .from(facebookPageDmPendingIntents)
        .where(
          and(
            eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
            eq(facebookPageDmPendingIntents.accountId, input.accountId),
            eq(facebookPageDmPendingIntents.conversationId, input.conversationId),
            eq(facebookPageDmPendingIntents.sequenceIndex, 0),
            inArray(facebookPageDmPendingIntents.status, [
              'pending',
              'claimed',
              'unknown',
              'confirmed',
            ]),
            sql`(${facebookPageDmPendingIntents.dueAt} AT TIME ZONE 'Europe/Sofia')::date = ${day}::date`,
          ),
        )
        .limit(3);
      if (usedDay.length >= dailyLimit.maximum)
        throw new PendingDmConflictError(
          dailyLimit.maximum === 1
            ? 'One Page DM group per Sofia day is already scheduled'
            : 'Two Page DM groups per Sofia day are already scheduled',
        );
      if (usedDay.length === 1 && dailyLimit.maximum === 2 && usedDay[0]?.status !== 'confirmed')
        throw new PendingDmConflictError(
          'A second Page DM group requires the first group to be confirmed',
        );
      if (
        usedDay.length === 1 &&
        dailyLimit.maximum === 2 &&
        (!input.latestInboundAt ||
          !(await hasFreshInboundAfterFirstConfirmedDailyGroup(tx, {
            ...input,
            dueAt,
            latestInboundAt: input.latestInboundAt,
          })))
      )
        throw new PendingDmConflictError(
          'A second Page DM group requires a fresh inbound after the first confirmed group',
        );
    }
    for (const change of plan.changes) {
      const moved = await tx
        .update(facebookPageDmPendingIntents)
        .set({ dueAt: change.dueAt, updatedAt: new Date() })
        .where(
          and(
            eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
            eq(facebookPageDmPendingIntents.id, change.id),
            eq(facebookPageDmPendingIntents.status, 'pending'),
            eq(facebookPageDmPendingIntents.preSendAttempts, 0),
          ),
        )
        .returning({ id: facebookPageDmPendingIntents.id });
      if (moved.length !== 1)
        throw new PendingDmConflictError('Page DM root changed during priority scheduling');
    }
    const groupId = randomUUID();
    const root = await tx
      .insert(facebookPageDmPendingIntents)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        clientActionId: input.clientActionId,
        requestFingerprint,
        actorType,
        actorId: input.actor.id,
        textBody: input.texts[0] ?? '',
        finalExit: Boolean(input.finalExit && input.texts.length === 1),
        bioLinkMention: Boolean(input.bioLinkMention && input.texts.length === 1),
        dueAt,
        windowDeadline: input.windowDeadline,
        groupId,
        sequenceIndex: 0,
        gapSeconds: 0,
        expectedLatestInboundMessageId: input.expectedLatestInboundMessageId,
      })
      .returning({ id: facebookPageDmPendingIntents.id });
    for (let index = 1; index < input.texts.length; index += 1) {
      await tx.insert(facebookPageDmPendingIntents).values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        clientActionId: randomUUID(),
        requestFingerprint: createHash('sha256')
          .update(`${requestFingerprint}:${String(index)}`)
          .digest('hex'),
        actorType,
        actorId: input.actor.id,
        textBody: input.texts[index] ?? '',
        finalExit: Boolean(input.finalExit && index === input.texts.length - 1),
        bioLinkMention: Boolean(input.bioLinkMention && index === input.texts.length - 1),
        dueAt,
        groupId,
        sequenceIndex: index,
        gapSeconds: randomInt(4, 11),
        expectedLatestInboundMessageId: input.expectedLatestInboundMessageId,
        status: 'waiting',
      });
    }
    if (!root[0]) throw new Error('Page DM group root insertion failed');
    return { id: root[0].id, groupId, dueAt, status: 'pending' };
  });
}

async function findGroup(tx: NodePgDatabase, input: GroupKey & { rootId: string }) {
  const [root] = await tx
    .select({ groupId: facebookPageDmPendingIntents.groupId })
    .from(facebookPageDmPendingIntents)
    .where(
      and(
        eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
        eq(facebookPageDmPendingIntents.accountId, input.accountId),
        eq(facebookPageDmPendingIntents.conversationId, input.conversationId),
        eq(facebookPageDmPendingIntents.id, input.rootId),
        eq(facebookPageDmPendingIntents.sequenceIndex, 0),
      ),
    )
    .limit(1);
  return root?.groupId ?? null;
}

export async function getPageDmGroupStatus(
  database: NodePgDatabase,
  input: GroupKey & { rootId: string },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const groupId = await findGroup(tx, input);
    if (!groupId) return null;
    const rows = await tx
      .select({
        sequenceIndex: facebookPageDmPendingIntents.sequenceIndex,
        status: facebookPageDmPendingIntents.status,
        dueAt: facebookPageDmPendingIntents.dueAt,
      })
      .from(facebookPageDmPendingIntents)
      .where(
        and(
          eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageDmPendingIntents.accountId, input.accountId),
          eq(facebookPageDmPendingIntents.conversationId, input.conversationId),
          eq(facebookPageDmPendingIntents.groupId, groupId),
        ),
      )
      .orderBy(facebookPageDmPendingIntents.sequenceIndex)
      .limit(4);
    return {
      id: input.rootId,
      bubbles: rows.map((row) => ({
        sequence: row.sequenceIndex,
        status: row.status,
        dueAt: row.dueAt.toISOString(),
      })),
    };
  });
}

export async function cancelPageDmGroup(
  database: NodePgDatabase,
  input: GroupKey & { rootId: string },
) {
  return withTenantTransaction(database, input, async (tx) => {
    await lockPageDmAccount(tx, input);
    const groupId = await findGroup(tx, input);
    if (!groupId) return null;
    const cancelled = await tx
      .update(facebookPageDmPendingIntents)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageDmPendingIntents.groupId, groupId),
          inArray(facebookPageDmPendingIntents.status, ['pending', 'waiting']),
        ),
      )
      .returning({ id: facebookPageDmPendingIntents.id });
    return { cancelled: cancelled.length };
  });
}

import { createHash, randomInt, randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { facebookPageDmActions, facebookPageDmPendingIntents } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  isPageConversationNoGoInTransaction,
  lockPageDmAccount,
} from './facebook-dm-no-go.repository.js';
import { PendingDmConflictError, PendingDmNoGoError } from './facebook-dm-pending.repository.js';
import { hasPageDmBioLinkMention } from './facebook-dm-bio-link.repository.js';
import { pageDmCivilDay } from './facebook-dm-active-days.repository.js';
import { isPageDmDailyGroupLimitEnabledInTransaction } from './facebook-page-engagement.service.js';

interface GroupKey {
  workspaceId: string;
  accountId: string;
  conversationId: string;
}

interface GroupRequest extends GroupKey {
  clientActionId: string;
  texts: string[];
  finalExit?: boolean | undefined;
  bioLinkMention?: boolean | undefined;
  expectedLatestInboundMessageId: string;
  windowDeadline: Date;
  actor: { type: 'api-key' | 'delegated' | 'user'; id: string };
}

function fingerprint(input: Omit<GroupRequest, 'windowDeadline'>) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        accountId: input.accountId,
        conversationId: input.conversationId,
        texts: input.texts,
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
  input: Omit<GroupRequest, 'windowDeadline'>,
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
  if (
    input.texts.length < 1 ||
    input.texts.length > 4 ||
    input.texts.some((text) => !text.trim() || text.length > 2000)
  )
    throw new PendingDmConflictError('A Page DM group requires 1–4 nonempty bubbles');
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
    const [lastRoot] = await tx
      .select({ dueAt: facebookPageDmPendingIntents.dueAt })
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
      .limit(1);
    const dueAt = new Date(
      Math.max(Date.now(), lastRoot?.dueAt.getTime() ?? 0) + randomInt(60, 121) * 1000,
    );
    if (dueAt > input.windowDeadline)
      throw new PendingDmConflictError(
        'The Messenger reply window cannot fit another Page DM group',
      );
    if (await isPageDmDailyGroupLimitEnabledInTransaction(tx, input)) {
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
      const [usedDay] = await tx
        .select({ id: facebookPageDmPendingIntents.id })
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
        .limit(1);
      if (usedDay)
        throw new PendingDmConflictError('One Page DM group per Sofia day is already scheduled');
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

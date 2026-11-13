import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  facebookPageDmActions,
  facebookPageDmActiveDays,
  facebookPageDmPendingIntents,
} from '../../database/schema.js';

const PAGE_TIME_ZONE = 'Europe/Sofia';
const dayFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: PAGE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function pageDmCivilDay(at: Date): string {
  return dayFormatter.format(at);
}

/** Caller holds the Page lock; the first confirmed root owns the fallback freshness boundary. */
export async function hasFreshInboundAfterFirstConfirmedDailyGroup(
  tx: NodePgDatabase,
  input: {
    workspaceId: string;
    accountId: string;
    conversationId: string;
    dueAt: Date;
    latestInboundAt: Date;
  },
): Promise<boolean> {
  const day = pageDmCivilDay(input.dueAt);
  const [first] = await tx
    .select({ outboundAt: facebookPageDmActions.updatedAt })
    .from(facebookPageDmPendingIntents)
    .innerJoin(
      facebookPageDmActions,
      and(
        eq(facebookPageDmActions.workspaceId, facebookPageDmPendingIntents.workspaceId),
        eq(facebookPageDmActions.accountId, facebookPageDmPendingIntents.accountId),
        eq(facebookPageDmActions.clientActionId, facebookPageDmPendingIntents.clientActionId),
        eq(facebookPageDmActions.state, 'confirmed'),
      ),
    )
    .where(
      and(
        eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
        eq(facebookPageDmPendingIntents.accountId, input.accountId),
        eq(facebookPageDmPendingIntents.conversationId, input.conversationId),
        eq(facebookPageDmPendingIntents.sequenceIndex, 0),
        eq(facebookPageDmPendingIntents.status, 'confirmed'),
        sql`(${facebookPageDmPendingIntents.dueAt} AT TIME ZONE 'Europe/Sofia')::date = ${day}::date`,
      ),
    )
    .orderBy(asc(facebookPageDmPendingIntents.dueAt), asc(facebookPageDmPendingIntents.id))
    .limit(1);
  return Boolean(first && input.latestInboundAt.getTime() > first.outboundAt.getTime());
}

function previousCivilDay(day: string): string {
  const at = new Date(`${day}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
}

export async function recordPageDmActiveDay(
  tx: NodePgDatabase,
  input: {
    workspaceId: string;
    accountId: string;
    conversationId: string;
    inboundMessageId: string;
    inboundAt: Date;
    outboundActionId: string;
    outboundMessageId: string;
    outboundAt: Date;
  },
): Promise<void> {
  const civilDay = pageDmCivilDay(input.outboundAt);
  if (pageDmCivilDay(input.inboundAt) !== civilDay) return;
  await tx
    .insert(facebookPageDmActiveDays)
    .values({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      civilDay,
      inboundMessageId: input.inboundMessageId,
      inboundAt: input.inboundAt,
      outboundActionId: input.outboundActionId,
      outboundMessageId: input.outboundMessageId,
      outboundAt: input.outboundAt,
    })
    .onConflictDoNothing();
}

export async function readPageDmActiveDayStreaks(
  tx: NodePgDatabase,
  input: { workspaceId: string; accountId: string; conversationIds: string[]; now: Date },
): Promise<Map<string, { activeDayStreak: number; lastActiveDay: string | null }>> {
  const today = pageDmCivilDay(input.now);
  const yesterday = previousCivilDay(today);
  const beforeYesterday = previousCivilDay(yesterday);
  const threeDaysAgo = previousCivilDay(beforeYesterday);
  const rows = await tx
    .select({
      conversationId: facebookPageDmActiveDays.conversationId,
      civilDay: facebookPageDmActiveDays.civilDay,
    })
    .from(facebookPageDmActiveDays)
    .where(
      and(
        eq(facebookPageDmActiveDays.workspaceId, input.workspaceId),
        eq(facebookPageDmActiveDays.accountId, input.accountId),
        inArray(facebookPageDmActiveDays.conversationId, input.conversationIds),
        inArray(facebookPageDmActiveDays.civilDay, [
          today,
          yesterday,
          beforeYesterday,
          threeDaysAgo,
        ]),
      ),
    )
    .limit(400);
  const byId = new Map<string, Set<string>>();
  for (const row of rows) {
    const days = byId.get(row.conversationId) ?? new Set<string>();
    days.add(row.civilDay);
    byId.set(row.conversationId, days);
  }
  return new Map(
    input.conversationIds.map((id) => {
      const days = byId.get(id) ?? new Set<string>();
      const lastActiveDay = days.has(today) ? today : days.has(yesterday) ? yesterday : null;
      let activeDayStreak = 0;
      for (
        let day = lastActiveDay;
        day && activeDayStreak < 3 && days.has(day);
        day = previousCivilDay(day)
      ) {
        activeDayStreak += 1;
      }
      return [id, { activeDayStreak, lastActiveDay }];
    }),
  );
}

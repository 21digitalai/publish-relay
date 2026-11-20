import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import {
  FanvueDmConversationStateUnavailableError,
  ingestFanvueDmHistoryPage,
  markFanvueDmHistoryBackfillIncomplete,
} from './fanvue-dm-conversation-state.repository.js';
import type { FanvueReadClient } from './fanvue-read-client.js';

const inputSchema = z.strictObject({
  workspaceId: z.uuid(),
  accountId: z.uuid(),
  fanUuid: z.uuid(),
  maxPages: z.number().int().min(1).max(100).default(20),
  pageSize: z.number().int().min(1).max(50).default(50),
  excludeMediaForMessageUuids: z.array(z.uuid()).max(20).default([]),
});

type MessagePage = Awaited<ReturnType<FanvueReadClient['listMessages']>>;

class InvalidHistoryMessageError extends Error {
  constructor(readonly code: 'invalid_message_direction' | 'invalid_message_timestamp') {
    super(code);
  }
}

function providerDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new InvalidHistoryMessageError('invalid_message_timestamp');
  return date;
}

export async function backfillFanvueDmHistory(
  database: NodePgDatabase,
  unparsed: z.input<typeof inputSchema>,
  loadPage: (page: number, size: number) => Promise<MessagePage>,
) {
  const input = inputSchema.parse(unparsed);
  const exclusions = new Set(input.excludeMediaForMessageUuids);
  let pagesIngested = 0;
  let messagesIngested = 0;
  let hasMore = true;
  for (let page = 1; page <= input.maxPages; page += 1) {
    const observedAt = new Date();
    let response: MessagePage;
    try {
      response = await loadPage(page, input.pageSize);
    } catch {
      await markFanvueDmHistoryBackfillIncomplete(database, {
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        fanUuid: input.fanUuid,
        failureCode: 'provider_read_failed',
        observedAt,
      });
      return {
        state: 'incomplete' as const,
        reason: 'provider_read_failed' as const,
        pagesIngested,
        messagesIngested,
      };
    }
    let messages;
    try {
      messages = response.data.map((message) => {
        const inbound =
          message.sender.uuid === input.fanUuid && message.recipient.uuid !== input.fanUuid;
        const outbound =
          message.recipient.uuid === input.fanUuid && message.sender.uuid !== input.fanUuid;
        if (!inbound && !outbound)
          throw new InvalidHistoryMessageError('invalid_message_direction');
        return {
          providerMessageUuid: message.uuid,
          direction: inbound ? ('inbound' as const) : ('outbound' as const),
          sentAt: providerDate(message.sentAt),
          mediaUuids: message.mediaUuids ?? [],
          priceCents: message.pricing?.USD.price ?? null,
          purchasedAt: message.purchasedAt ? providerDate(message.purchasedAt) : null,
          excludeMedia: exclusions.has(message.uuid),
        };
      });
    } catch (error) {
      const failureCode =
        error instanceof InvalidHistoryMessageError
          ? error.code
          : ('invalid_message_timestamp' as const);
      await markFanvueDmHistoryBackfillIncomplete(database, {
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        fanUuid: input.fanUuid,
        failureCode,
        observedAt,
      });
      return {
        state: 'incomplete' as const,
        reason: failureCode,
        pagesIngested,
        messagesIngested,
      };
    }
    let result;
    try {
      result = await ingestFanvueDmHistoryPage(database, {
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        fanUuid: input.fanUuid,
        messages,
        hasMore: response.pagination.hasMore,
        observedAt,
      });
    } catch (error) {
      if (error instanceof FanvueDmConversationStateUnavailableError) throw error;
      await markFanvueDmHistoryBackfillIncomplete(database, {
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        fanUuid: input.fanUuid,
        failureCode: 'page_ingest_failed',
        observedAt,
      });
      return {
        state: 'incomplete' as const,
        reason: 'page_ingest_failed' as const,
        pagesIngested,
        messagesIngested,
      };
    }
    pagesIngested += 1;
    messagesIngested += result.ingested;
    hasMore = response.pagination.hasMore;
    if (!hasMore)
      return {
        state: 'complete' as const,
        pagesIngested,
        messagesIngested,
        oldestAt: result.oldestAt,
      };
  }
  const observedAt = new Date();
  await markFanvueDmHistoryBackfillIncomplete(database, {
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    fanUuid: input.fanUuid,
    failureCode: 'page_limit_reached',
    observedAt,
  });
  return {
    state: 'incomplete' as const,
    reason: 'page_limit_reached' as const,
    pagesIngested,
    messagesIngested,
  };
}

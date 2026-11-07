import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { MasterKeyProvider } from '../credentials/envelope.js';
import type { FacebookHttpClient } from './facebook-http-client.js';
import { pageNoGoConversationIds } from './facebook-dm-no-go.repository.js';
import {
  PageReadUnavailableError,
  withPageReadToken,
} from './facebook-page-read-context.service.js';

export async function listAccountPageConversations(
  runtime: { database: NodePgDatabase; keys: MasterKeyProvider; client: FacebookHttpClient },
  input: { workspaceId: string; accountId: string; limit?: number; after?: string },
) {
  return withPageReadToken(runtime, { ...input, module: 'dms' }, async (pageId, accessToken) => {
    const result = await runtime.client.listPageConversations({
      pageId,
      accessToken,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
    });
    const blocked = await pageNoGoConversationIds(runtime.database, {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      conversationIds: result.conversations.map((item) => item.id),
    });
    return {
      ...result,
      conversations: result.conversations.map((item) => ({ ...item, noGo: blocked.has(item.id) })),
    };
  });
}

export async function listAccountConversationMessages(
  runtime: { database: NodePgDatabase; keys: MasterKeyProvider; client: FacebookHttpClient },
  input: {
    workspaceId: string;
    accountId: string;
    conversationId: string;
    limit?: number;
    after?: string;
  },
) {
  return withPageReadToken(runtime, { ...input, module: 'dms' }, async (pageId, accessToken) => {
    const conversation = await runtime.client.getConversationDetails(
      input.conversationId,
      accessToken,
    );
    const participants = conversation.participants;
    const fans = participants.filter((person) => person.id !== pageId);
    if (
      participants.filter((person) => person.id === pageId).length !== 1 ||
      fans.length !== 1 ||
      fans[0] === undefined
    )
      throw new PageReadUnavailableError();
    const result = await runtime.client.listConversationMessages({
      conversationId: input.conversationId,
      accessToken,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
    });
    return {
      participantId: fans[0].id,
      displayName: fans[0].name ?? null,
      link: conversation.link,
      ...result,
    };
  });
}

export async function getAccountConversationLink(
  runtime: { database: NodePgDatabase; keys: MasterKeyProvider; client: FacebookHttpClient },
  input: { workspaceId: string; accountId: string; conversationId: string },
): Promise<string | null> {
  return withPageReadToken(runtime, { ...input, module: 'dms' }, async (pageId, accessToken) => {
    const conversation = await runtime.client.getConversationDetails(
      input.conversationId,
      accessToken,
    );
    const participants = conversation.participants;
    if (
      participants.filter((person) => person.id === pageId).length !== 1 ||
      participants.filter((person) => person.id !== pageId).length !== 1
    )
      throw new PageReadUnavailableError();
    return conversation.link;
  });
}

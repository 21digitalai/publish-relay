import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import type { MasterKeyProvider } from '../credentials/envelope.js';
import type { FacebookHttpClient } from './facebook-http-client.js';
import { pageNoGoConversationIds } from './facebook-dm-no-go.repository.js';
import { terminalPageConversationIds } from './facebook-dm-memory.repository.js';
import {
  PageReadUnavailableError,
  withPageReadToken,
} from './facebook-page-read-context.service.js';

export async function listAccountPageConversations(
  runtime: { database: NodePgDatabase; keys: MasterKeyProvider; client: FacebookHttpClient },
  input: {
    workspaceId: string;
    accountId: string;
    limit?: number;
    after?: string;
    filter?: 'all' | 'eligible';
    updatedSince?: string;
  },
) {
  return withPageReadToken(runtime, { ...input, module: 'dms' }, async (pageId, accessToken) => {
    const result = await runtime.client.listPageConversations({
      pageId,
      accessToken,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
    });
    const selection = {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      conversationIds: result.conversations.map((item) => item.id),
    };
    const blocked = await pageNoGoConversationIds(runtime.database, selection);
    const terminal = await terminalPageConversationIds(runtime.database, selection);
    const cutoff = input.updatedSince === undefined ? undefined : Date.parse(input.updatedSince);
    // Unknown provider timestamps must remain candidates; this is not inbound eligibility.
    const candidates = result.conversations.filter((item) => {
      const normalized = item.updatedAt?.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
      const timestamp = z.iso.datetime({ offset: true }).safeParse(normalized);
      const updated = timestamp.success ? Date.parse(timestamp.data) : NaN;
      return cutoff === undefined || !Number.isFinite(updated) || updated >= cutoff;
    });
    const conversations = candidates.map((item) => ({
      ...item,
      noGo: blocked.has(item.id),
      terminal: terminal.has(item.id),
    }));
    return {
      ...result,
      conversations:
        input.filter === 'eligible'
          ? conversations.filter((item) => !item.noGo && !item.terminal)
          : conversations,
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

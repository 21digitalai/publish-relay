import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { MasterKeyProvider } from '../credentials/envelope.js';
import type { FacebookHttpClient } from './facebook-http-client.js';
import {
  PageReadUnavailableError,
  withPageReadToken,
} from './facebook-page-read-context.service.js';

export async function listAccountPageConversations(
  runtime: { database: NodePgDatabase; keys: MasterKeyProvider; client: FacebookHttpClient },
  input: { workspaceId: string; accountId: string; limit?: number; after?: string },
) {
  return withPageReadToken(runtime, { ...input, module: 'dms' }, (pageId, accessToken) =>
    runtime.client.listPageConversations({
      pageId,
      accessToken,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
    }),
  );
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
    const participants = await runtime.client.getConversationParticipants(
      input.conversationId,
      accessToken,
    );
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
    return { participantId: fans[0].id, displayName: fans[0].name ?? null, ...result };
  });
}

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
    const participantIds = await runtime.client.getConversationParticipantIds(
      input.conversationId,
      accessToken,
    );
    const fanIds = participantIds.filter((id) => id !== pageId);
    if (
      participantIds.filter((id) => id === pageId).length !== 1 ||
      fanIds.length !== 1 ||
      fanIds[0] === undefined
    )
      throw new PageReadUnavailableError();
    const result = await runtime.client.listConversationMessages({
      conversationId: input.conversationId,
      accessToken,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
    });
    return { participantId: fanIds[0], ...result };
  });
}

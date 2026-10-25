import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { MasterKeyProvider } from '../credentials/envelope.js';
import type { FacebookHttpClient } from './facebook-http-client.js';
import { withPageReadToken } from './facebook-page-read-context.service.js';

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

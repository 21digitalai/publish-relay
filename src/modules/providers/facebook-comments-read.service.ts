import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { MasterKeyProvider } from '../credentials/envelope.js';
import type { FacebookHttpClient } from './facebook-http-client.js';
import {
  PageReadUnavailableError,
  withPageReadToken,
} from './facebook-page-read-context.service.js';

export async function listAccountPagePosts(
  runtime: { database: NodePgDatabase; keys: MasterKeyProvider; client: FacebookHttpClient },
  input: { workspaceId: string; accountId: string; limit?: number; after?: string },
) {
  return withPageReadToken(runtime, { ...input, module: 'comments' }, (pageId, accessToken) =>
    runtime.client.listPagePosts({
      pageId,
      accessToken,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
    }),
  );
}

export async function listAccountPostComments(
  runtime: { database: NodePgDatabase; keys: MasterKeyProvider; client: FacebookHttpClient },
  input: { workspaceId: string; accountId: string; postId: string; limit?: number; after?: string },
) {
  return withPageReadToken(
    runtime,
    { ...input, module: 'comments', additionalScopes: ['pages_read_user_content'] },
    async (pageId, accessToken) => {
      const ownerPageId = await runtime.client.getPostOwner(input.postId, accessToken);
      if (ownerPageId !== pageId) throw new PageReadUnavailableError();
      return runtime.client.listPostComments({
        postId: input.postId,
        accessToken,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.after === undefined ? {} : { after: input.after }),
      });
    },
  );
}

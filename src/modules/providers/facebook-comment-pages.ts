import { FacebookRequestError, type FacebookHttpClient } from './facebook-http-client.js';

const MAX_COMMENT_BYTES = 1024 * 1024;
const MAX_COMMENT_PAGES = 10;

/** Invocation-local traversal after canonical Page and owner authorization. */
export async function readBoundedCommentPages(
  client: FacebookHttpClient,
  input: { postId: string; accessToken: string; limit?: number; after?: string; maxPages: number },
) {
  if (!Number.isInteger(input.maxPages) || input.maxPages < 1 || input.maxPages > MAX_COMMENT_PAGES)
    throw new FacebookRequestError({ kind: 'permanent', status: 400 });
  const comments: Awaited<ReturnType<FacebookHttpClient['listPostComments']>>['comments'] = [];
  const cursors = new Set<string>(input.after ? [input.after] : []);
  let after = input.after;
  let commentPageReads = 0;
  let responseBytes = 2;
  for (let index = 0; index < input.maxPages; index++) {
    const page = await client.listPostComments({
      postId: input.postId,
      accessToken: input.accessToken,
      limit: input.limit ?? 100,
      ...(after === undefined ? {} : { after }),
      requireCompleteCursor: true,
    });
    commentPageReads++;
    const bytes = Buffer.byteLength(JSON.stringify([...comments, ...page.comments]));
    if (bytes > MAX_COMMENT_BYTES) {
      // Nothing from this page is accepted; continuation refetches this exact page.
      if (comments.length === 0) throw new FacebookRequestError({ kind: 'permanent', status: 502 });
      return {
        comments,
        nextCursor: after ?? null,
        complete: false,
        stopReason: 'byte_limit',
        reads: { ownerReads: 1, commentPageReads, responseBytes },
      };
    }
    comments.push(...page.comments);
    responseBytes = bytes;
    if (page.nextCursor === null)
      return {
        comments,
        nextCursor: null,
        complete: true,
        stopReason: 'exhausted',
        reads: { ownerReads: 1, commentPageReads, responseBytes },
      };
    if (!page.nextCursor || cursors.has(page.nextCursor))
      throw new FacebookRequestError({ kind: 'permanent', status: 502 });
    cursors.add(page.nextCursor);
    after = page.nextCursor;
  }
  return {
    comments,
    nextCursor: after ?? null,
    complete: false,
    stopReason: 'page_limit',
    reads: { ownerReads: 1, commentPageReads, responseBytes },
  };
}

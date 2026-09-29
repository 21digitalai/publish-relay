import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { XClient } from './x-adapter.js';

export interface XThreadPart {
  text: string;
  mediaIds: string[];
}

interface ThreadRow extends Record<string, unknown> {
  position: number;
  state: string;
  externalPostId: string | null;
  replyToPostId: string | null;
}

export class XThreadOutcomeUnknown extends Error {
  public constructor(public readonly position: number) {
    super(`X thread part ${String(position)} requires manual reconciliation`);
  }
}

function rowsOf<T>(result: { rows?: T[] } | T[]): T[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

async function readPart(
  database: NodePgDatabase,
  workspaceId: string,
  jobId: string,
  position: number,
) {
  return withTenantTransaction(database, { workspaceId }, async (transaction) => {
    const result = await transaction.execute<ThreadRow>(sql`
      SELECT position, state, external_post_id AS "externalPostId",
        reply_to_post_id AS "replyToPostId"
      FROM x_thread_parts WHERE workspace_id = ${workspaceId} AND job_id = ${jobId}
        AND position = ${position}
    `);
    return rowsOf(result)[0] ?? null;
  });
}

async function reservePart(input: {
  database: NodePgDatabase;
  workspaceId: string;
  jobId: string;
  position: number;
  dispatchKey: string;
  replyToPostId: string | null;
  now: Date;
}): Promise<void> {
  await withTenantTransaction(
    input.database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      await transaction.execute(sql`
      INSERT INTO x_thread_parts
        (workspace_id, job_id, position, dispatch_key, state, dispatch_started_at, reply_to_post_id)
      VALUES (${input.workspaceId}, ${input.jobId}, ${input.position}, ${input.dispatchKey},
        'dispatching', ${input.now}, ${input.replyToPostId})
    `);
    },
  );
}

async function confirmPart(input: {
  database: NodePgDatabase;
  workspaceId: string;
  jobId: string;
  position: number;
  externalPostId: string;
  externalUrl: string;
  now: Date;
}): Promise<void> {
  await withTenantTransaction(
    input.database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      await transaction.execute(sql`
      UPDATE x_thread_parts SET state = 'published', external_post_id = ${input.externalPostId},
        external_url = ${input.externalUrl}, published_at = ${input.now}
      WHERE workspace_id = ${input.workspaceId} AND job_id = ${input.jobId}
        AND position = ${input.position} AND state = 'dispatching'
    `);
    },
  );
}

export async function publishXThread(input: {
  database: NodePgDatabase;
  client: XClient;
  workspaceId: string;
  jobId: string;
  idempotencyKey: string;
  parts: readonly XThreadPart[];
  now: Date;
}): Promise<{ externalPostId: string; externalUrl: string }> {
  if (input.parts.length < 2) throw new Error('X thread requires at least two parts');
  let replyToPostId: string | null = null;
  let root: { externalPostId: string; externalUrl: string } | null = null;
  for (const [position, part] of input.parts.entries()) {
    const existing = await readPart(input.database, input.workspaceId, input.jobId, position);
    if (existing) {
      if (
        existing.state !== 'published' ||
        !existing.externalPostId ||
        existing.replyToPostId !== replyToPostId
      )
        throw new XThreadOutcomeUnknown(position);
      const post = await input.client.getPost(existing.externalPostId);
      if (!post) throw new XThreadOutcomeUnknown(position);
      replyToPostId = existing.externalPostId;
      if (position === 0)
        root = {
          externalPostId: post.id,
          externalUrl: `https://x.com/${post.username}/status/${post.id}`,
        };
      continue;
    }
    await reservePart({
      ...input,
      position,
      dispatchKey: `${input.idempotencyKey}:${String(position)}`,
      replyToPostId,
    });
    let created: { id: string; username: string };
    try {
      created = await input.client.createPost({
        text: part.text,
        mediaIds: part.mediaIds,
        ...(replyToPostId ? { replyToPostId } : {}),
        idempotencyKey: `${input.idempotencyKey}:${String(position)}`,
      });
    } catch {
      // X does not honor our idempotency key. A request may have succeeded before the response failed.
      throw new XThreadOutcomeUnknown(position);
    }
    const externalUrl = `https://x.com/${created.username}/status/${created.id}`;
    await confirmPart({ ...input, position, externalPostId: created.id, externalUrl });
    replyToPostId = created.id;
    if (position === 0) root = { externalPostId: created.id, externalUrl };
  }
  if (!root) throw new Error('X thread produced no root result');
  return root;
}

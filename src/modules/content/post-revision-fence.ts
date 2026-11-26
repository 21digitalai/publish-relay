import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { posts, postRevisions, publicationJobs } from '../../database/schema.js';
import { PostNotFoundError, PostRevisionConflictError } from './post.errors.js';

/** Post lock serializes revisions; job locks serialize with both scheduler claim paths. */
export async function lockUnstartedPost(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    postId: string;
    expectedRevisionId?: string;
  },
) {
  const owner = await database
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.workspaceId, input.workspaceId), eq(posts.id, input.postId)))
    .for('update');
  if (!owner.length) throw new PostNotFoundError('Post not found in workspace');
  const [revision] = await database
    .select()
    .from(postRevisions)
    .where(
      and(eq(postRevisions.workspaceId, input.workspaceId), eq(postRevisions.postId, input.postId)),
    )
    .orderBy(desc(postRevisions.revisionNumber))
    .limit(1);
  if (!revision) throw new PostNotFoundError('Post revision not found');
  if (input.expectedRevisionId && revision.id !== input.expectedRevisionId)
    throw new PostRevisionConflictError('Post revision changed');
  const allJobs = await database
    .select()
    .from(publicationJobs)
    .where(
      and(
        eq(publicationJobs.workspaceId, input.workspaceId),
        eq(publicationJobs.postId, input.postId),
      ),
    )
    .orderBy(publicationJobs.id)
    .for('update');
  const jobs = allJobs.filter(
    (job) => job.revisionId === revision.id && job.state !== 'superseded',
  );
  const history = await database.execute(sql`
    select 1 from publication_jobs j
    where j.workspace_id = ${input.workspaceId} and j.post_id = ${input.postId}
      and (exists (select 1 from publication_attempts a where a.workspace_id = j.workspace_id and a.job_id = j.id)
        or exists (select 1 from publication_job_events e where e.workspace_id = j.workspace_id
          and e.job_id = j.id and (e.to_state not in ('scheduled', 'superseded')
            or e.from_state not in ('scheduled', 'superseded'))))
    limit 1
  `);
  if (
    !jobs.length ||
    new Set(jobs.map((job) => job.providerAccountId)).size !== jobs.length ||
    new Set(
      allJobs.filter((job) => job.revisionId === revision.id).map((job) => job.providerAccountId),
    ).size !== jobs.length ||
    allJobs.some(
      (job) =>
        job.attemptNumber !== 0 ||
        job.leaseOwner !== null ||
        job.leaseExpiresAt !== null ||
        job.reconciliationRequired ||
        job.nextAttemptAt !== null ||
        (job.state !== 'superseded' &&
          (job.revisionId !== revision.id || job.state !== 'scheduled')),
    ) ||
    history.rows.length
  )
    throw new PostRevisionConflictError('Post can only be changed before every target dispatches');
  return { revision, jobs };
}

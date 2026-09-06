import { sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { createPostInTransaction } from '../content/post.service.js';
import { normalizeStoredXContent } from './x-media-dispatch.service.js';
import type { RemediationJournal, RemediationSource } from './x-remediation.service.js';

function rows<T>(result: { rows?: T[] } | T[]): T[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

interface JournalRow extends Record<string, unknown> {
  phase: RemediationJournal['phase'];
  jobId: string;
  attemptId: string;
  externalPostId: string;
  revisionId: string;
  contentHash: string;
  media: RemediationSource['media'];
  replacementJobId: string | null;
  replacementAttemptId: string | null;
  replacementExternalPostId: string | null;
  replacementExternalUrl: string | null;
}

function journalFromRow(row: JournalRow, source: RemediationSource): RemediationJournal {
  return {
    phase: row.phase,
    source,
    contentHash: row.contentHash,
    ...(row.replacementJobId ? { replacementJobId: row.replacementJobId } : {}),
    ...(row.replacementAttemptId ? { replacementAttemptId: row.replacementAttemptId } : {}),
    ...(row.replacementExternalPostId
      ? { replacementExternalPostId: row.replacementExternalPostId }
      : {}),
    ...(row.replacementExternalUrl ? { replacementExternalUrl: row.replacementExternalUrl } : {}),
  };
}

export async function loadRemediationSource(
  database: NodePgDatabase,
  workspaceId: string,
  jobId: string,
  externalPostId: string,
): Promise<RemediationSource> {
  return withTenantTransaction(database, { workspaceId }, async (transaction) => {
    const result = await transaction.execute<{
      revisionId: string;
      content: Record<string, unknown>;
      attemptId: string;
      mediaId: string | null;
      sha256: string | null;
      providerAccountId: string;
      createdByUserId: string;
    }>(sql`
      SELECT revision.id AS "revisionId", revision.content,
      attempt.id AS "attemptId", media.id AS "mediaId", media.sha256
        , job.provider_account_id AS "providerAccountId", post.created_by_user_id AS "createdByUserId"
      FROM publication_jobs job
      JOIN post_revisions revision ON revision.workspace_id = job.workspace_id
        AND revision.id = job.revision_id
      JOIN posts post ON post.workspace_id = job.workspace_id AND post.id = job.post_id
      JOIN publication_attempts attempt ON attempt.workspace_id = job.workspace_id
        AND attempt.job_id = job.id AND attempt.external_post_id = ${externalPostId}
      LEFT JOIN revision_media link ON link.workspace_id = revision.workspace_id
        AND link.revision_id = revision.id
      LEFT JOIN media_objects media ON media.workspace_id = link.workspace_id
        AND media.id = link.media_id
      WHERE job.workspace_id = ${workspaceId} AND job.id = ${jobId}
      ORDER BY link.position
    `);
    const found = rows(result);
    const first = found[0];
    if (!first) throw new Error(`Remediation source ${jobId} was not found`);
    const normalized = normalizeStoredXContent(first.content);
    return {
      jobId,
      attemptId: first.attemptId,
      externalPostId,
      revisionId: first.revisionId,
      text: normalized.text,
      media: found.flatMap((item) =>
        item.mediaId && item.sha256 ? [{ id: item.mediaId, sha256: item.sha256 }] : [],
      ),
      providerAccountId: first.providerAccountId,
      createdByUserId: first.createdByUserId,
    };
  });
}

export class XRemediationJournalRepository {
  public constructor(
    private readonly database: NodePgDatabase,
    private readonly workspaceId: string,
  ) {}

  public async read(jobId: string): Promise<RemediationJournal | null> {
    const result = await withTenantTransaction(
      this.database,
      { workspaceId: this.workspaceId },
      (transaction) =>
        transaction.execute<JournalRow>(sql`
        SELECT phase, source_job_id AS "jobId", source_attempt_id AS "attemptId",
          source_external_post_id AS "externalPostId", source_revision_id AS "revisionId",
          source_content_hash AS "contentHash", source_media_hashes AS media,
          replacement_job_id AS "replacementJobId",
          replacement_attempt_id AS "replacementAttemptId",
          replacement_external_post_id AS "replacementExternalPostId",
          replacement_external_url AS "replacementExternalUrl"
        FROM x_remediation_journals
        WHERE workspace_id = ${this.workspaceId} AND source_job_id = ${jobId}
      `),
    );
    const row = rows(result)[0];
    if (!row) return null;
    const source = await loadRemediationSource(
      this.database,
      this.workspaceId,
      jobId,
      row.externalPostId,
    );
    return journalFromRow(row, source);
  }

  public async prepare(journal: RemediationJournal): Promise<RemediationJournal> {
    await withTenantTransaction(this.database, { workspaceId: this.workspaceId }, (transaction) =>
      transaction.execute(sql`
        INSERT INTO x_remediation_journals (
          workspace_id, source_job_id, source_attempt_id, source_external_post_id,
          source_revision_id, source_content_hash, source_media_hashes, phase
        ) VALUES (
          ${this.workspaceId}, ${journal.source.jobId}, ${journal.source.attemptId},
          ${journal.source.externalPostId}, ${journal.source.revisionId}, ${journal.contentHash},
          ${JSON.stringify(journal.source.media)}::jsonb, 'prepared'
        ) ON CONFLICT (source_job_id) DO NOTHING
      `),
    );
    return (await this.read(journal.source.jobId)) ?? journal;
  }

  public async markDeleted(jobId: string): Promise<RemediationJournal> {
    return this.transition(jobId, 'delete_started', 'deleted', sql`delete_confirmed_at = now()`);
  }

  public async markDeleteStarted(jobId: string): Promise<RemediationJournal> {
    return this.transition(jobId, 'prepared', 'delete_started', sql`delete_started_at = now()`);
  }

  public async markReplacementStarted(jobId: string): Promise<RemediationJournal> {
    return this.transition(
      jobId,
      'deleted',
      'replacement_started',
      sql`replacement_started_at = now()`,
    );
  }

  public async prepareReplacement(source: RemediationSource): Promise<RemediationJournal> {
    await withTenantTransaction(
      this.database,
      { workspaceId: this.workspaceId },
      async (transaction) => {
        const current = await transaction.execute<{
          phase: RemediationJournal['phase'];
          replacementJobId: string | null;
        }>(sql`
        SELECT phase, replacement_job_id AS "replacementJobId"
        FROM x_remediation_journals
        WHERE workspace_id = ${this.workspaceId} AND source_job_id = ${source.jobId}
        FOR UPDATE
      `);
        const locked = rows(current)[0];
        if (!locked) throw new Error(`Remediation journal ${source.jobId} was not found`);
        if (locked.replacementJobId || locked.phase !== 'replacement_started') return;
        if (!source.providerAccountId || !source.createdByUserId)
          throw new Error('Replacement source authority is incomplete');
        const created = await createPostInTransaction(transaction, {
          workspaceId: this.workspaceId,
          userId: source.createdByUserId,
          content: { kind: 'text', text: source.text },
          mediaIds: source.media.map((item) => item.id),
          providerAccountIds: [source.providerAccountId],
          scheduledAt: new Date(),
          idempotencyKey: `x-remediation:${source.jobId}`,
        });
        const replacementJobId = created.jobIds[0];
        if (!replacementJobId) throw new Error('Replacement job was not created');
        const updated = await transaction.execute<{ replacementJobId: string }>(sql`
        UPDATE x_remediation_journals
        SET replacement_job_id = ${replacementJobId}, updated_at = now()
        WHERE workspace_id = ${this.workspaceId} AND source_job_id = ${source.jobId}
          AND phase = 'replacement_started' AND replacement_job_id IS NULL
        RETURNING replacement_job_id AS "replacementJobId"
      `);
        if (rows(updated).length !== 1)
          throw new Error(`Remediation replacement ${source.jobId} was not persisted`);
      },
    );
    const journal = await this.read(source.jobId);
    if (!journal) throw new Error(`Remediation journal ${source.jobId} was not found`);
    return journal;
  }

  public async markReplaced(
    jobId: string,
    replacement: {
      jobId: string;
      attemptId: string;
      externalPostId: string;
      externalUrl: string;
    },
  ): Promise<RemediationJournal> {
    return this.transition(
      jobId,
      'replacement_started',
      'replaced',
      sql`
      replacement_job_id = ${replacement.jobId},
      replacement_attempt_id = ${replacement.attemptId},
      replacement_external_post_id = ${replacement.externalPostId},
      replacement_external_url = ${replacement.externalUrl}, replacement_confirmed_at = now()
    `,
    );
  }

  public async markVerified(jobId: string): Promise<RemediationJournal> {
    return this.transition(jobId, 'replaced', 'verified', sql`verified_at = now()`);
  }

  private async transition(
    jobId: string,
    expected: RemediationJournal['phase'],
    next: RemediationJournal['phase'],
    fields: SQL,
  ): Promise<RemediationJournal> {
    await withTenantTransaction(this.database, { workspaceId: this.workspaceId }, (transaction) =>
      transaction.execute(sql`
        UPDATE x_remediation_journals SET phase = ${next}, ${fields}, updated_at = now()
        WHERE workspace_id = ${this.workspaceId} AND source_job_id = ${jobId}
          AND phase = ${expected}
      `),
    );
    const journal = await this.read(jobId);
    if (!journal) throw new Error(`Remediation journal ${jobId} was not found`);
    return journal;
  }
}

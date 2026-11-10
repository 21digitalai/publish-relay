import { readFile, readdir } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scheduleApprovedPageComment } from '../src/modules/providers/facebook-comment-approval.service.js';
import {
  cancelScheduledProposalPageComment,
  claimDuePageComment,
  finishClaimedPageComment,
} from '../src/modules/providers/facebook-comment-pending.repository.js';

const mocks = vi.hoisted(() => ({ target: vi.fn(), policy: vi.fn() }));
vi.mock('../src/modules/providers/facebook-comments-read.service.js', () => ({
  readScheduledCommentTarget: mocks.target,
}));
vi.mock('../src/modules/policy/action-policy.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  enforceWorkspaceAction: mocks.policy,
}));

const workspaceId = '00000000-0000-4000-8000-000000000201';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000202';
const accountId = '00000000-0000-4000-8000-000000000203';
const userId = '00000000-0000-4000-8000-000000000209';
const proposalId = '00000000-0000-4000-8000-000000000210';
let postgres: PGlite;
let database: NodePgDatabase;

beforeEach(async () => {
  vi.clearAllMocks();
  postgres = new PGlite();
  const folder = new URL('../migrations/', import.meta.url);
  const names = (await readdir(folder)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const name of names) await postgres.exec(await readFile(new URL(name, folder), 'utf8'));
  await postgres.exec(`
    INSERT INTO workspaces (id, name, slug) VALUES ('${workspaceId}', 'Primary', 'primary'), ('${otherWorkspaceId}', 'Other', 'other');
    INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
      VALUES ('00000000-0000-4000-8000-000000000207', '${workspaceId}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
    INSERT INTO provider_connections (id, workspace_id, provider, credential_id, status, scopes)
      VALUES ('00000000-0000-4000-8000-000000000205', '${workspaceId}', 'meta', '00000000-0000-4000-8000-000000000207', 'active', '[]');
    INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id, destination_provider, remote_account_id, display_name)
      VALUES ('${accountId}', '${workspaceId}', '00000000-0000-4000-8000-000000000205', 'page-a', 'facebook_page', 'page-a', 'Page A');
    INSERT INTO engagement_proposals (id, workspace_id, account_id, client_action_id, provider, kind, target_id, source_context, content, proposer_type, proposer_id, planned_due_at)
      VALUES ('${proposalId}', '${workspaceId}', '${accountId}', '00000000-0000-4000-8000-000000000211', 'facebook_page', 'comment', '123_456_789', '{"postId":"123_456"}', '{"text":"Reply later"}', 'user', '${userId}', '2026-11-10T10:00:00Z');
  `);
  database = drizzle(postgres) as unknown as NodePgDatabase;
  mocks.target.mockResolvedValue({
    text: 'Visitor comment',
    createdAt: '2026-11-10T09:00:00+0000',
    threadFingerprint: 'a'.repeat(64),
    hasPageReply: false,
  });
});

afterEach(async () => postgres.close());

const input = { workspaceId, userId, proposalId, expectedRevision: 1 };

describe('reviewed Page comment scheduling', () => {
  it('atomically schedules one intent, preserves overdue timing and cancels only pending work', async () => {
    const runtime = { database, keys: {} as never, client: {} as never, policy: {} as never };
    const result = await scheduleApprovedPageComment(runtime, input);
    expect(result.status).toBe('scheduled');
    expect(new Date(result.dueAt).getTime()).toBeGreaterThan(Date.parse('2026-11-10T10:00:00Z'));
    const rows = await postgres.query<{ status: string }>(
      'SELECT status FROM facebook_page_comment_pending_intents',
    );
    expect(rows.rows).toEqual([{ status: 'pending' }]);
    await expect(scheduleApprovedPageComment(runtime, input)).rejects.toThrow('stale');
    expect(
      (await postgres.query('SELECT count(*) AS count FROM facebook_page_comment_pending_intents'))
        .rows,
    ).toEqual([{ count: 1 }]);
    expect(
      await cancelScheduledProposalPageComment(database, {
        workspaceId: otherWorkspaceId,
        proposalId,
      }),
    ).toBe(false);
    expect(await cancelScheduledProposalPageComment(database, { workspaceId, proposalId })).toBe(
      true,
    );
    expect(await cancelScheduledProposalPageComment(database, { workspaceId, proposalId })).toBe(
      false,
    );
    expect(
      (await postgres.query('SELECT status FROM facebook_page_comment_pending_intents')).rows,
    ).toEqual([{ status: 'cancelled' }]);
  });

  it('rolls back proposal status when intent insertion conflicts', async () => {
    const runtime = { database, keys: {} as never, client: {} as never, policy: {} as never };
    await postgres.exec(`INSERT INTO facebook_page_comment_actions
      (workspace_id, account_id, post_id, comment_id, client_action_id, request_fingerprint, actor_type, actor_id, text_body, state)
      VALUES ('${workspaceId}', '${accountId}', '123_456', '123_456_789', '00000000-0000-4000-8000-000000000211', repeat('b',64), 'user', '${userId}', 'Reply later', 'reserved')`);
    await expect(scheduleApprovedPageComment(runtime, input)).rejects.toThrow('conflicts');
    expect(
      (await postgres.query('SELECT status FROM engagement_proposals WHERE id = $1', [proposalId]))
        .rows,
    ).toEqual([{ status: 'pending' }]);
    expect(
      (await postgres.query('SELECT count(*) AS count FROM facebook_page_comment_pending_intents'))
        .rows,
    ).toEqual([{ count: 0 }]);
  });

  it('keeps a stale target pending and settles a claimed approval from worker truth', async () => {
    const runtime = { database, keys: {} as never, client: {} as never, policy: {} as never };
    mocks.target.mockResolvedValueOnce({ hasPageReply: true, threadFingerprint: null });
    await expect(scheduleApprovedPageComment(runtime, input)).rejects.toThrow('unavailable');
    expect(
      (await postgres.query('SELECT status FROM engagement_proposals WHERE id = $1', [proposalId]))
        .rows,
    ).toEqual([{ status: 'pending' }]);
    await scheduleApprovedPageComment(runtime, input);
    const claim = await claimDuePageComment(database, {
      workerId: 'worker',
      now: new Date(Date.now() + 180_000),
      leaseMs: 30_000,
    });
    expect(claim?.accountId).toBe(accountId);
    expect(
      await finishClaimedPageComment(database, {
        workspaceId,
        id: claim?.id ?? '',
        leaseOwner: claim?.leaseOwner ?? '',
        state: 'confirmed',
      }),
    ).toBe(true);
    expect(
      (await postgres.query('SELECT status FROM engagement_proposals WHERE id = $1', [proposalId]))
        .rows,
    ).toEqual([{ status: 'sent' }]);
  });
});

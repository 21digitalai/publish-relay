import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cancelPageCommentIntent,
  claimDuePageComment,
  finishClaimedPageComment,
  getPageCommentIntent,
  PendingCommentConflictError,
  renewClaimedPageComment,
  schedulePageComment,
} from '../src/modules/providers/facebook-comment-pending.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const foreignWorkspace = '00000000-0000-4000-8000-000000000009';
const accountId = '00000000-0000-4000-8000-000000000002';
const actorId = '00000000-0000-4000-8000-000000000003';
const input = {
  workspaceId,
  accountId,
  postId: '123_456',
  commentId: '123_456_789',
  clientActionId: '00000000-0000-4000-8000-000000000004',
  requestFingerprint: 'a'.repeat(64),
  actor: { type: 'api-key' as const, id: actorId },
  text: 'Reply later',
  targetText: 'Visitor comment',
  targetCreatedAt: '2026-11-10T10:00:00+0000',
  threadFingerprint: 'b'.repeat(64),
  dueAt: new Date('2026-11-10T10:01:00Z'),
};

let postgres: PGlite;
let database: NodePgDatabase;

beforeEach(async () => {
  postgres = new PGlite();
  await postgres.exec(`
    CREATE TYPE audit_actor_type AS ENUM ('user','api_key','delegated','system');
    CREATE TABLE provider_accounts (id uuid NOT NULL, workspace_id uuid NOT NULL, PRIMARY KEY (workspace_id,id));
    CREATE TABLE audit_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
      actor_type audit_actor_type NOT NULL, actor_id uuid, action text NOT NULL, target_type text NOT NULL,
      target_id uuid, request_id text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO provider_accounts VALUES ('${accountId}','${workspaceId}'), ('${accountId}','${foreignWorkspace}');
  `);
  await postgres.exec(
    readFileSync(
      new URL('../migrations/0094_facebook_page_comment_actions.sql', import.meta.url),
      'utf8',
    ),
  );
  await postgres.exec(
    readFileSync(
      new URL('../migrations/0107_facebook_comment_scheduled_intents.sql', import.meta.url),
      'utf8',
    ),
  );
  database = drizzle(postgres) as unknown as NodePgDatabase;
});

afterEach(async () => postgres.close());

describe('scheduled Page comment intents', () => {
  it('replays one action, rejects duplicate comment, and respects tenant account boundaries', async () => {
    const first = await schedulePageComment(database, input);
    expect((await schedulePageComment(database, input)).id).toBe(first.id);
    await expect(
      schedulePageComment(database, {
        ...input,
        clientActionId: '00000000-0000-4000-8000-000000000005',
      }),
    ).rejects.toBeInstanceOf(PendingCommentConflictError);
    expect(
      await getPageCommentIntent(database, {
        workspaceId: foreignWorkspace,
        accountId,
        id: first.id,
      }),
    ).toBeNull();
    expect(
      await cancelPageCommentIntent(database, {
        workspaceId: foreignWorkspace,
        accountId,
        id: first.id,
      }),
    ).toBe(false);
    expect(await cancelPageCommentIntent(database, { workspaceId, accountId, id: first.id })).toBe(
      true,
    );
    expect(await cancelPageCommentIntent(database, { workspaceId, accountId, id: first.id })).toBe(
      false,
    );
  });

  it('paces across comments, fences a restarted worker and freezes unknown outcomes', async () => {
    const now = new Date('2026-11-10T11:00:00Z');
    const first = await schedulePageComment(database, input);
    await schedulePageComment(database, {
      ...input,
      commentId: '123_456_790',
      clientActionId: '00000000-0000-4000-8000-000000000005',
      requestFingerprint: 'c'.repeat(64),
      dueAt: new Date('2026-11-10T10:02:00Z'),
    });
    const claim = await claimDuePageComment(database, { workerId: 'worker', now, leaseMs: 30_000 });
    expect(claim?.id).toBe(first.id);
    expect(
      await claimDuePageComment(database, { workerId: 'other', now, leaseMs: 30_000 }),
    ).toBeNull();
    expect(
      await renewClaimedPageComment(database, {
        workspaceId,
        id: first.id,
        leaseOwner: 'stale',
        leaseMs: 30_000,
      }),
    ).toBe(false);
    const restarted = await claimDuePageComment(database, {
      workerId: 'worker',
      now: new Date(now.getTime() + 31_000),
      leaseMs: 30_000,
    });
    expect(restarted?.id).toBe(first.id);
    expect(restarted?.leaseOwner).not.toBe(claim?.leaseOwner);
    expect(
      await finishClaimedPageComment(database, {
        workspaceId,
        id: first.id,
        leaseOwner: claim?.leaseOwner ?? '',
        state: 'confirmed',
      }),
    ).toBe(false);
    expect(
      await finishClaimedPageComment(database, {
        workspaceId,
        id: first.id,
        leaseOwner: restarted?.leaseOwner ?? '',
        state: 'unknown',
      }),
    ).toBe(true);
    expect(
      (await getPageCommentIntent(database, { workspaceId, accountId, id: first.id }))?.status,
    ).toBe('unknown');
    const later = await claimDuePageComment(database, {
      workerId: 'other',
      now: new Date(now.getTime() + 121_000),
      leaseMs: 30_000,
    });
    expect(later?.commentId).toBe('123_456_790');
  });
});

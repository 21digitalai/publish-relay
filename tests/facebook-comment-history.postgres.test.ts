import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { AuthService } from '../src/modules/identity/auth.service.js';
import { registerEngagementProposalRoutes } from '../src/modules/providers/engagement-proposal.routes.js';
import {
  listPageCommentHistory,
  pageCommentPostLink,
} from '../src/modules/providers/facebook-comment-history.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000002';
const accountId = '00000000-0000-4000-8000-000000000003';
const directActionId = '00000000-0000-4000-8000-000000000011';
const scheduledActionId = '00000000-0000-4000-8000-000000000012';

describe('Page comment reply history', () => {
  it('projects direct and scheduled truth through the HTTP allowlist without duplicate intents', async () => {
    const pg = new PGlite();
    const app = Fastify();
    try {
      await pg.exec(`
        CREATE TABLE provider_accounts (id uuid NOT NULL, workspace_id uuid NOT NULL, display_name text NOT NULL, PRIMARY KEY (workspace_id,id));
        CREATE TABLE facebook_page_comment_actions (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, account_id uuid NOT NULL,
          client_action_id uuid NOT NULL, post_id text, comment_id text NOT NULL, text_body text, state text NOT NULL,
          created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
        CREATE TABLE facebook_page_comment_pending_intents (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, account_id uuid NOT NULL,
          client_action_id uuid NOT NULL, post_id text NOT NULL, comment_id text NOT NULL, text_body text NOT NULL,
          target_text text NOT NULL, due_at timestamptz NOT NULL, status text NOT NULL,
          created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
        INSERT INTO provider_accounts VALUES ('${accountId}','${workspaceId}','Christina Page'), ('${accountId}','${otherWorkspaceId}','Private Page');
        INSERT INTO facebook_page_comment_actions VALUES
          ('00000000-0000-4000-8000-000000000021','${workspaceId}','${accountId}','${directActionId}','123_456','123_789','Exact direct reply','confirmed','2026-11-05 09:05Z','2026-11-05 09:06Z'),
          ('00000000-0000-4000-8000-000000000022','${otherWorkspaceId}','${accountId}','${directActionId}','999_888','999_777','Foreign private reply','confirmed','2026-11-05 09:09Z','2026-11-05 09:09Z');
        INSERT INTO facebook_page_comment_pending_intents VALUES
          ('00000000-0000-4000-8000-000000000031','${workspaceId}','${accountId}','${scheduledActionId}','123_456','123_888','Exact scheduled reply','Original visitor context','2026-11-05 10:00Z','pending','2026-11-05 09:07Z','2026-11-05 09:07Z'),
          ('00000000-0000-4000-8000-000000000032','${workspaceId}','${accountId}','${directActionId}','123_456','123_789','Duplicate stale intent','Do not repeat','2026-11-05 09:00Z','confirmed','2026-11-05 09:04Z','2026-11-05 09:06Z');
      `);
      const database = drizzle(pg) as unknown as NodePgDatabase;
      const rows = await listPageCommentHistory(database, { workspaceId, limit: 50 });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.status)).toEqual(['pending', 'confirmed']);
      expect(rows.map((row) => row.outboundText)).toEqual([
        'Exact scheduled reply',
        'Exact direct reply',
      ]);
      expect(JSON.stringify(rows)).not.toContain('Foreign private reply');
      expect(
        await listPageCommentHistory(database, { workspaceId, status: 'pending', limit: 50 }),
      ).toHaveLength(1);
      expect(pageCommentPostLink('123_456')).toBe('https://www.facebook.com/123_456');
      expect(pageCommentPostLink('https://evil.example/x')).toBeNull();

      await app.register(cookie);
      const auth = {
        authenticate: () => Promise.resolve({ userId: directActionId, workspaceId, role: 'owner' }),
      } as unknown as AuthService;
      registerEngagementProposalRoutes(app, { database, auth });
      const response = await app.inject({
        method: 'GET',
        url: '/api/facebook-page-comment-history?status=confirmed',
        headers: { cookie: `publish_relay_session=${workspaceId}.test-token` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ data: { items: Record<string, unknown>[] } }>();
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0]).toMatchObject({
        outboundText: 'Exact direct reply',
        status: 'confirmed',
        postUrl: 'https://www.facebook.com/123_456',
      });
      expect(JSON.stringify(body)).not.toMatch(
        /Foreign private|targetText|actorId|fingerprint|credential/,
      );
    } finally {
      await app.close();
      await pg.close();
    }
  });
});

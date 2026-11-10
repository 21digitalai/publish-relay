import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { AuthService } from '../src/modules/identity/auth.service.js';
import { registerEngagementProposalRoutes } from '../src/modules/providers/engagement-proposal.routes.js';
import { reserveFanvueAction } from '../src/modules/providers/fanvue-action-intent.repository.js';
import { listFanvueActionHistory } from '../src/modules/providers/fanvue-action-history.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000002';
const accountId = '00000000-0000-4000-8000-000000000003';
const targetUuid = '00000000-0000-4000-8000-000000000004';

describe('Fanvue action history', () => {
  it('retains bounded outbound facts at reservation and exposes direct actions through the HTTP allowlist', async () => {
    const pg = new PGlite();
    const app = Fastify();
    try {
      await pg.exec(`
        CREATE TABLE provider_accounts (id uuid NOT NULL, workspace_id uuid NOT NULL, display_name text NOT NULL, PRIMARY KEY (workspace_id,id));
        CREATE TABLE fanvue_action_intents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, account_id uuid NOT NULL,
          client_action_id uuid NOT NULL, action_kind text NOT NULL, target_uuid uuid NOT NULL, request_fingerprint text NOT NULL,
          state text NOT NULL DEFAULT 'reserved', provider_object_uuid uuid, failure_status integer,
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
        INSERT INTO provider_accounts VALUES ('${accountId}','${workspaceId}','Eli Fanvue'), ('${accountId}','${otherWorkspaceId}','Other creator');
      `);
      await pg.exec(
        await readFile(
          new URL('../migrations/0109_fanvue_action_history_payload.sql', import.meta.url),
          'utf8',
        ),
      );
      await pg.exec(
        await readFile(
          new URL('../migrations/0110_fanvue_action_target_context.sql', import.meta.url),
          'utf8',
        ),
      );
      const database = drizzle(pg) as unknown as NodePgDatabase;
      const result = await reserveFanvueAction(database, {
        workspaceId,
        accountId,
        clientActionId: '00000000-0000-4000-8000-000000000011',
        actionKind: 'message',
        targetUuid,
        requestFingerprint: 'a'.repeat(64),
        textBody: 'Exact agent DM',
        targetLabel: '@alexandra',
        mediaCount: 2,
        priceCents: 300,
      });
      expect(result.kind).toBe('new');
      await pg.exec(`
        UPDATE fanvue_action_intents SET state='confirmed', provider_object_uuid='00000000-0000-4000-8000-000000000019' WHERE workspace_id='${workspaceId}';
        INSERT INTO fanvue_action_intents
          (workspace_id, account_id, client_action_id, action_kind, target_uuid, request_fingerprint, state, text_body, target_label)
          VALUES
          ('${workspaceId}','${accountId}','00000000-0000-4000-8000-000000000013','comment','${targetUuid}','${'c'.repeat(64)}','failed','Exact direct comment','Media post · 2026-11-05'),
          ('${otherWorkspaceId}','${accountId}','00000000-0000-4000-8000-000000000012','comment','${targetUuid}','${'b'.repeat(64)}','confirmed','Foreign private comment','Private target');
      `);
      const rows = await listFanvueActionHistory(database, { workspaceId, limit: 50 });
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.kind === 'message')).toMatchObject({
        outboundText: 'Exact agent DM',
        targetLabel: '@alexandra',
        mediaCount: 2,
        priceCents: 300,
        status: 'confirmed',
      });
      expect(rows.find((row) => row.kind === 'comment')).toMatchObject({
        outboundText: 'Exact direct comment',
        targetLabel: 'Media post · 2026-11-05',
        status: 'failed',
      });
      expect(
        await listFanvueActionHistory(database, { workspaceId, kind: 'comment', limit: 50 }),
      ).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain('Foreign private comment');

      await app.register(cookie);
      const auth = {
        authenticate: () => Promise.resolve({ userId: targetUuid, workspaceId, role: 'owner' }),
      } as unknown as AuthService;
      registerEngagementProposalRoutes(app, { database, auth });
      const response = await app.inject({
        method: 'GET',
        url: '/api/fanvue-engagement-history?kind=message&status=confirmed',
        headers: { cookie: `publish_relay_session=${workspaceId}.test-token` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ data: { items: Record<string, unknown>[] } }>();
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0]).toMatchObject({
        outboundText: 'Exact agent DM',
        targetLabel: '@alexandra',
        mediaCount: 2,
        priceCents: 300,
        status: 'confirmed',
        destinationUrl: null,
      });
      expect(JSON.stringify(body)).not.toMatch(
        /Foreign private|fingerprint|credential|sourceContext|targetUuid/,
      );
      expect(Buffer.byteLength(response.body)).toBeLessThan(4096);
    } finally {
      await app.close();
      await pg.close();
    }
  });
});

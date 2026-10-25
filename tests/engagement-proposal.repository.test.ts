import { readFile, readdir } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import {
  createEngagementProposal,
  dismissEngagementProposal,
  listPendingEngagementProposals,
  reviseEngagementProposal,
} from '../src/modules/providers/engagement-proposal.repository.js';

const workspace = '00000000-0000-4000-8000-000000000201';
const otherWorkspace = '00000000-0000-4000-8000-000000000202';
const account = '00000000-0000-4000-8000-000000000203';
const otherAccount = '00000000-0000-4000-8000-000000000204';
const connection = '00000000-0000-4000-8000-000000000205';
const otherConnection = '00000000-0000-4000-8000-000000000206';
const credential = '00000000-0000-4000-8000-000000000207';
const otherCredential = '00000000-0000-4000-8000-000000000208';
const proposer = '00000000-0000-4000-8000-000000000209';
const action = '00000000-0000-4000-8000-000000000210';

describe('engagement proposal foundation', () => {
  it('binds the account and idempotency key, isolates the queue, and revises only pending rows', async () => {
    const client = new PGlite();
    try {
      const folder = new URL('../migrations/', import.meta.url);
      const names = (await readdir(folder)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
      for (const name of names) await client.exec(await readFile(new URL(name, folder), 'utf8'));
      await client.exec(`
        INSERT INTO workspaces (id, name, slug) VALUES
          ('${workspace}', 'Primary', 'primary'), ('${otherWorkspace}', 'Other', 'other');
        INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
          wrapped_key_tag, ciphertext, nonce, tag) VALUES
          ('${credential}', '${workspace}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06'),
          ('${otherCredential}', '${otherWorkspace}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
        INSERT INTO provider_connections (id, workspace_id, provider, credential_id, status, scopes) VALUES
          ('${connection}', '${workspace}', 'meta', '${credential}', 'active', '[]'),
          ('${otherConnection}', '${otherWorkspace}', 'meta', '${otherCredential}', 'active', '[]');
        INSERT INTO provider_accounts
          (id, workspace_id, connection_id, provider_account_id, destination_provider, remote_account_id, display_name) VALUES
          ('${account}', '${workspace}', '${connection}', 'page-a', 'facebook_page', 'page-a', 'Page A'),
          ('${otherAccount}', '${otherWorkspace}', '${otherConnection}', 'page-b', 'facebook_page', 'page-b', 'Page B');
      `);
      const database = drizzle(client) as unknown as NodePgDatabase;
      const input = {
        workspaceId: workspace,
        accountId: account,
        clientActionId: action,
        provider: 'facebook_page',
        kind: 'comment' as const,
        targetId: 'comment-1',
        sourceContext: { text: 'Original' },
        content: { text: 'Proposed reply' },
        proposerType: 'api_key' as const,
        proposerId: proposer,
      };
      const row = await createEngagementProposal(database, input);
      expect((await createEngagementProposal(database, input)).id).toBe(row.id);
      await client.exec(
        `UPDATE provider_connections SET status = 'revoked', revoked_at = now() WHERE id = '${connection}'`,
      );
      expect((await createEngagementProposal(database, input)).id).toBe(row.id);
      await expect(
        createEngagementProposal(database, {
          ...input,
          clientActionId: '00000000-0000-4000-8000-000000000212',
        }),
      ).rejects.toThrow('unavailable');
      await client.exec(
        `UPDATE provider_connections SET status = 'active', revoked_at = NULL WHERE id = '${connection}'`,
      );
      await expect(
        createEngagementProposal(database, { ...input, content: { text: 'Different' } }),
      ).rejects.toThrow('conflicts');
      await expect(
        createEngagementProposal(database, {
          ...input,
          clientActionId: '00000000-0000-4000-8000-000000000211',
          accountId: otherAccount,
        }),
      ).rejects.toThrow('unavailable');
      expect(await listPendingEngagementProposals(database, otherWorkspace)).toEqual([]);
      const revised = await reviseEngagementProposal(database, {
        workspaceId: workspace,
        id: row.id,
        expectedRevision: 1,
        content: { text: 'Edited reply' },
      });
      expect(revised.revision).toBe(2);
      await expect(
        reviseEngagementProposal(database, {
          workspaceId: workspace,
          id: row.id,
          expectedRevision: 1,
          content: { text: 'Lost edit' },
        }),
      ).rejects.toThrow('stale');
      await expect(
        dismissEngagementProposal(database, {
          workspaceId: otherWorkspace,
          id: row.id,
          expectedRevision: 2,
        }),
      ).rejects.toThrow('unavailable');
      await dismissEngagementProposal(database, {
        workspaceId: workspace,
        id: row.id,
        expectedRevision: 2,
      });
      expect(await listPendingEngagementProposals(database, workspace)).toEqual([]);
      await client.exec(`
        CREATE ROLE proposal_reader NOLOGIN NOBYPASSRLS;
        GRANT USAGE ON SCHEMA public TO proposal_reader;
        GRANT SELECT ON engagement_proposals TO proposal_reader;
        ALTER TABLE engagement_proposals OWNER TO proposal_reader;
        SELECT set_config('app.workspace_id', '${otherWorkspace}', false);
        SET ROLE proposal_reader;
      `);
      expect(
        (
          await client.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM engagement_proposals',
          )
        ).rows[0]?.count,
      ).toBe('0');
      await client.exec(`SELECT set_config('app.workspace_id', '${workspace}', false)`);
      expect(
        (
          await client.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM engagement_proposals',
          )
        ).rows[0]?.count,
      ).toBe('1');
    } finally {
      await client.close();
    }
  });
});

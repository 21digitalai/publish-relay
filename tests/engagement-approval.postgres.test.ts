import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { approveEngagementProposal } from '../src/modules/providers/engagement-approval.service.js';
import {
  createEngagementProposal,
  getEngagementProposal,
} from '../src/modules/providers/engagement-proposal.repository.js';
import { markFanvuePreSendError } from '../src/modules/providers/fanvue-pre-send-error.js';

const connectionString = process.env.POSTGRES_FANVUE_TEST_URL;

describe.skipIf(!connectionString)('Fanvue proposal approval on PostgreSQL', () => {
  it('admits one concurrent send and releases only a proven pre-send failure', async () => {
    const pool = new pg.Pool({ connectionString, max: 6 });
    const database = drizzle(pool);
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const accountId = randomUUID();
    const connectionId = randomUUID();
    const credentialId = randomUUID();
    const userId = randomUUID();
    const fanUuid = randomUUID();
    const messageUuid = randomUUID();
    try {
      for (const id of [workspaceId, otherWorkspaceId])
        await pool.query('INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)', [
          id,
          'Fanvue approval fixture',
          id,
        ]);
      await pool.query(
        `INSERT INTO credentials
         (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
         VALUES ($1, $2, 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06')`,
        [credentialId, workspaceId],
      );
      await pool.query(
        `INSERT INTO provider_connections
         (id, workspace_id, provider, credential_id, external_subject_id)
         VALUES ($1, $2, 'fanvue', $3, $4)`,
        [connectionId, workspaceId, credentialId, randomUUID()],
      );
      await pool.query(
        `INSERT INTO provider_accounts
         (id, workspace_id, connection_id, provider_account_id, display_name, destination_provider, remote_account_id)
         VALUES ($1, $2, $3, 'creator', 'Creator', 'fanvue', 'creator')`,
        [accountId, workspaceId, connectionId],
      );
      const proposal = await createEngagementProposal(database, {
        workspaceId,
        accountId,
        clientActionId: randomUUID(),
        provider: 'fanvue',
        kind: 'dm',
        targetId: fanUuid,
        content: { text: 'Approved reply' },
        proposerType: 'user',
        proposerId: userId,
      });
      const sendText = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { state: 'confirmed' as const, messageUuid };
      });
      const commands = { comments: { send: vi.fn() }, messages: { sendText } } as never;
      const input = { workspaceId, userId, proposalId: proposal.id, expectedRevision: 1 };
      await expect(
        approveEngagementProposal(database, commands, { ...input, workspaceId: otherWorkspaceId }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const results = await Promise.allSettled([
        approveEngagementProposal(database, commands, input),
        approveEngagementProposal(database, commands, input),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected).toMatchObject({ status: 'rejected', reason: { statusCode: 409 } });
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(await getEngagementProposal(database, workspaceId, proposal.id)).toMatchObject({
        status: 'sent',
        clientActionId: proposal.clientActionId,
      });

      const retryable = await createEngagementProposal(database, {
        workspaceId,
        accountId,
        clientActionId: randomUUID(),
        provider: 'fanvue',
        kind: 'dm',
        targetId: fanUuid,
        content: { text: 'Requires renewed consent' },
        proposerType: 'user',
        proposerId: userId,
      });
      sendText.mockRejectedValueOnce(markFanvuePreSendError(new Error('scope missing')));
      await expect(
        approveEngagementProposal(database, commands, {
          ...input,
          proposalId: retryable.id,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await getEngagementProposal(database, workspaceId, retryable.id)).toMatchObject({
        status: 'pending',
        revision: 1,
      });
    } finally {
      await pool.query('DELETE FROM engagement_proposals WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM provider_account_exposures WHERE workspace_id=$1', [
        workspaceId,
      ]);
      await pool.query('DELETE FROM provider_accounts WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM provider_connections WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM credentials WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM workspaces WHERE id IN ($1, $2)', [
        workspaceId,
        otherWorkspaceId,
      ]);
      await pool.end();
    }
  });
});

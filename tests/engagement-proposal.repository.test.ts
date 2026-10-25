import { readFile, readdir } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it, vi } from 'vitest';
import {
  ApiKeyAuthorizationError,
  type ApiKeyService,
} from '../src/modules/identity/api-key.service.js';
import type { AuthService } from '../src/modules/identity/auth.service.js';
import { registerEngagementProposalRoutes } from '../src/modules/providers/engagement-proposal.routes.js';
import { registerEngagementApprovalRoutes } from '../src/modules/providers/engagement-approval.routes.js';

import {
  claimEngagementProposal,
  createEngagementProposal,
  dismissEngagementProposal,
  getEngagementProposal,
  listEngagementReviewQueue,
  reviseEngagementProposal,
  settleEngagementProposal,
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
const fanvueAccount = '00000000-0000-4000-8000-000000000216';
const fanvueConnection = '00000000-0000-4000-8000-000000000217';
const fanvueCredential = '00000000-0000-4000-8000-000000000218';
const fanvuePost = '00000000-0000-4000-8000-000000000219';

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
          ('${fanvueCredential}', '${workspace}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06'),
          ('${otherCredential}', '${otherWorkspace}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
        INSERT INTO provider_connections (id, workspace_id, provider, credential_id, status, scopes) VALUES
          ('${connection}', '${workspace}', 'meta', '${credential}', 'active', '[]'),
          ('${fanvueConnection}', '${workspace}', 'fanvue', '${fanvueCredential}', 'active', '[]'),
          ('${otherConnection}', '${otherWorkspace}', 'meta', '${otherCredential}', 'active', '[]');
        INSERT INTO provider_accounts
          (id, workspace_id, connection_id, provider_account_id, destination_provider, remote_account_id, display_name) VALUES
          ('${account}', '${workspace}', '${connection}', 'page-a', 'facebook_page', 'page-a', 'Page A'),
          ('${fanvueAccount}', '${workspace}', '${fanvueConnection}', 'creator-a', 'fanvue', 'creator-a', 'Creator A'),
          ('${otherAccount}', '${otherWorkspace}', '${otherConnection}', 'page-b', 'facebook_page', 'page-b', 'Page B');
      `);
      const database = drizzle(client) as unknown as NodePgDatabase;
      const app = Fastify();
      await app.register(cookie);
      const auth = {
        authenticate: (selectedWorkspace: string) =>
          Promise.resolve({ userId: proposer, workspaceId: selectedWorkspace, role: 'owner' }),
      } as unknown as AuthService;
      const sendComment = vi
        .fn()
        .mockResolvedValue({ state: 'confirmed', commentUuid: fanvuePost });
      const sendText = vi.fn().mockResolvedValue({ state: 'unknown' });
      registerEngagementProposalRoutes(app, {
        database,
        auth,
        apiKeys: {
          authenticate: (_workspaceId: string, token: string) =>
            Promise.resolve({
              id: proposer,
              workspaceId: workspace,
              capabilities: token === 'blocked-key' ? [] : ['engagement:propose'],
            }),
          requireCapability: (principal: { capabilities: string[] }, capability: string) =>
            principal.capabilities.includes(capability)
              ? Promise.resolve()
              : Promise.reject(new ApiKeyAuthorizationError('missing capability')),
        } as unknown as ApiKeyService,
      });
      registerEngagementApprovalRoutes(app, {
        database,
        auth,
        comments: { send: sendComment },
        messages: { sendText },
      });
      const headers = {
        authorization: 'Bearer test-key',
        'x-publish-relay-workspace': workspace,
      };
      const proposalBody = {
        accountId: account,
        clientActionId: '00000000-0000-4000-8000-000000000213',
        provider: 'facebook_page',
        kind: 'comment',
        targetId: 'comment-2',
        sourceContext: { text: 'Source' },
        content: { text: 'Draft' },
      };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/engagement-proposals',
            payload: proposalBody,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/engagement-proposals',
            headers: { ...headers, authorization: 'Bearer blocked-key' },
            payload: proposalBody,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/engagement-proposals',
            headers,
            payload: { ...proposalBody, content: { text: '' } },
          })
        ).statusCode,
      ).toBe(400);
      const createdResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/engagement-proposals',
        headers,
        payload: proposalBody,
      });
      expect(createdResponse.statusCode).toBe(201);
      const createdBody = createdResponse.json<{
        data: { id: string; accountId: string; status: string; content: { text: string } };
      }>();
      expect(createdBody.data).toMatchObject({
        accountId: account,
        status: 'pending',
        content: { text: 'Draft' },
      });
      expect(createdBody.data).not.toHaveProperty('proposerId');
      expect(createdBody.data).not.toHaveProperty('workspaceId');
      const browserHeaders = { cookie: `publish_relay_session=${workspace}.test-token` };
      const listResponse = await app.inject({
        method: 'GET',
        url: '/api/engagement-proposals',
        headers: browserHeaders,
      });
      expect(listResponse.statusCode).toBe(200);
      expect(
        listResponse.json<{ data: { items: { id: string }[]; nextCursor: string | null } }>().data
          .items[0]?.id,
      ).toBe(createdBody.data.id);
      expect(
        listResponse.json<{ data: { items: { accountDisplayName: string }[] } }>().data.items[0]
          ?.accountDisplayName,
      ).toBe('Page A');
      expect(listResponse.body).not.toContain('proposerId');
      expect(listResponse.body).not.toContain('credentialId');
      expect(listResponse.body).not.toContain('targetId');
      expect(Buffer.byteLength(listResponse.body)).toBeLessThan(1000);
      const pageFixtureIds = Array.from(
        { length: 52 },
        (_, index) => `00000000-0000-4000-8000-${String(300 + index).padStart(12, '0')}`,
      );
      for (const [index, id] of pageFixtureIds.entries()) {
        const micros = index % 2 === 0 ? '123900' : '123800';
        await client.exec(`
          INSERT INTO engagement_proposals
            (id, workspace_id, account_id, client_action_id, provider, kind, target_id,
             content, proposer_type, proposer_id, created_at)
          VALUES ('${id}', '${workspace}', '${account}', '${id}', 'facebook_page',
            'comment', 'comment-${String(index)}', '{"text":"Draft"}', 'api_key', '${proposer}',
            '2026-10-25 12:00:00.${micros}+00');
        `);
      }
      const seenIds: string[] = [];
      let nextCursor: string | null = null;
      for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
        const url: string = nextCursor
          ? `/api/engagement-proposals?cursor=${encodeURIComponent(nextCursor)}`
          : '/api/engagement-proposals';
        const pageResponse = await app.inject({
          method: 'GET',
          url,
          headers: browserHeaders,
        });
        expect(pageResponse.statusCode).toBe(200);
        const page = pageResponse.json<{
          data: { items: { id: string }[]; nextCursor: string | null };
        }>().data;
        seenIds.push(...page.items.map((item) => item.id));
        nextCursor = page.nextCursor;
        expect(seenIds.length).toBeLessThanOrEqual(53);
        if (!nextCursor) break;
      }
      expect(nextCursor).toBeNull();
      expect(seenIds).toHaveLength(53);
      expect(new Set(seenIds).size).toBe(53);
      expect(seenIds).toEqual(expect.arrayContaining([createdBody.data.id, ...pageFixtureIds]));
      await client.exec(
        `DELETE FROM engagement_proposals WHERE id IN (${pageFixtureIds.map((id) => `'${id}'`).join(',')})`,
      );
      const detail = await app.inject({
        method: 'GET',
        url: `/api/engagement-proposals/${createdBody.data.id}`,
        headers: browserHeaders,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json<{ data: { targetId: string } }>().data.targetId).toBe('comment-2');
      expect(detail.json<{ data: { accountDisplayName: string } }>().data.accountDisplayName).toBe(
        'Page A',
      );
      expect(detail.json<{ data: { canApprove: boolean } }>().data.canApprove).toBe(true);
      const foreignDetail = await app.inject({
        method: 'GET',
        url: `/api/engagement-proposals/${createdBody.data.id}`,
        headers: { cookie: `publish_relay_session=${otherWorkspace}.test-token` },
      });
      expect(foreignDetail.statusCode).toBe(404);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/engagement-proposals?cursor=invalid',
            headers: browserHeaders,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/engagement-proposals',
            headers: browserHeaders,
            payload: proposalBody,
          })
        ).statusCode,
      ).toBe(403);
      const foreignResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/engagement-proposals',
        headers,
        payload: {
          ...proposalBody,
          clientActionId: '00000000-0000-4000-8000-000000000214',
          accountId: otherAccount,
        },
      });
      expect(foreignResponse.statusCode).toBe(409);
      const reviewed = await createEngagementProposal(database, {
        workspaceId: workspace,
        accountId: fanvueAccount,
        clientActionId: '00000000-0000-4000-8000-000000000220',
        provider: 'fanvue',
        kind: 'comment',
        targetId: fanvuePost,
        content: { text: 'Approved reply' },
        proposerType: 'api_key',
        proposerId: proposer,
      });
      const approveUrl = `/api/engagement-proposals/${reviewed.id}/approve`;
      const approvalPayload = { expectedRevision: 1 };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: approveUrl,
            headers: browserHeaders,
            payload: approvalPayload,
          })
        ).statusCode,
      ).toBe(403);
      const approvedHeaders = {
        cookie: `${browserHeaders.cookie}; publish_relay_csrf=fixture-csrf`,
        'x-csrf-token': 'fixture-csrf',
      };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: approveUrl,
            headers: {
              ...approvedHeaders,
              cookie: `publish_relay_session=${otherWorkspace}.test-token; publish_relay_csrf=fixture-csrf`,
            },
            payload: approvalPayload,
          })
        ).statusCode,
      ).toBe(409);
      const approved = await app.inject({
        method: 'POST',
        url: approveUrl,
        headers: approvedHeaders,
        payload: approvalPayload,
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({
        data: { id: reviewed.id, status: 'sent', providerObjectId: fanvuePost },
      });
      expect(sendComment).toHaveBeenCalledTimes(1);
      expect(sendComment).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: workspace,
          accountId: fanvueAccount,
          postUuid: fanvuePost,
          clientActionId: reviewed.clientActionId,
          text: 'Approved reply',
        }),
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: approveUrl,
            headers: approvedHeaders,
            payload: approvalPayload,
          })
        ).statusCode,
      ).toBe(409);
      expect(sendComment).toHaveBeenCalledTimes(1);
      const unsupported = await createEngagementProposal(database, {
        workspaceId: workspace,
        accountId: fanvueAccount,
        clientActionId: '00000000-0000-4000-8000-000000000221',
        provider: 'fanvue',
        kind: 'dm',
        targetId: fanvuePost,
        content: { text: 'With media', mediaIds: [fanvuePost] },
        proposerType: 'api_key',
        proposerId: proposer,
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/engagement-proposals/${unsupported.id}/approve`,
            headers: approvedHeaders,
            payload: approvalPayload,
          })
        ).statusCode,
      ).toBe(409);
      expect((await getEngagementProposal(database, workspace, unsupported.id))?.status).toBe(
        'pending',
      );
      expect(sendText).not.toHaveBeenCalled();
      const messageProposal = await createEngagementProposal(database, {
        workspaceId: workspace,
        accountId: fanvueAccount,
        clientActionId: '00000000-0000-4000-8000-000000000222',
        provider: 'fanvue',
        kind: 'dm',
        targetId: fanvuePost,
        content: { text: 'Hello' },
        proposerType: 'api_key',
        proposerId: proposer,
      });
      const unknown = await app.inject({
        method: 'POST',
        url: `/api/engagement-proposals/${messageProposal.id}/approve`,
        headers: approvedHeaders,
        payload: approvalPayload,
      });
      expect(unknown.statusCode).toBe(202);
      expect(unknown.json()).toMatchObject({ data: { status: 'unknown' } });
      expect(sendText).toHaveBeenCalledTimes(1);
      expect((await getEngagementProposal(database, workspace, messageProposal.id))?.status).toBe(
        'unknown',
      );
      await dismissEngagementProposal(database, {
        workspaceId: workspace,
        id: createdBody.data.id,
        expectedRevision: 1,
      });
      await app.close();
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
      expect(await listEngagementReviewQueue(database, otherWorkspace)).toEqual([]);
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
      expect((await listEngagementReviewQueue(database, workspace)).map((item) => item.id)).toEqual(
        expect.arrayContaining([unsupported.id, messageProposal.id]),
      );
      const approval = await createEngagementProposal(database, {
        ...input,
        clientActionId: '00000000-0000-4000-8000-000000000215',
      });
      await expect(
        claimEngagementProposal(database, {
          workspaceId: otherWorkspace,
          id: approval.id,
          expectedRevision: 1,
        }),
      ).rejects.toThrow('unavailable');
      await client.exec(
        `UPDATE provider_connections SET status = 'revoked', revoked_at = now() WHERE id = '${connection}'`,
      );
      await expect(
        claimEngagementProposal(database, {
          workspaceId: workspace,
          id: approval.id,
          expectedRevision: 1,
        }),
      ).rejects.toThrow('destination is unavailable');
      await client.exec(
        `UPDATE provider_connections SET status = 'active', revoked_at = NULL WHERE id = '${connection}'`,
      );
      const claimed = await claimEngagementProposal(database, {
        workspaceId: workspace,
        id: approval.id,
        expectedRevision: 1,
      });
      expect(claimed.status).toBe('sending');
      await expect(
        claimEngagementProposal(database, {
          workspaceId: workspace,
          id: approval.id,
          expectedRevision: 1,
        }),
      ).rejects.toThrow('stale');
      await expect(
        reviseEngagementProposal(database, {
          workspaceId: workspace,
          id: approval.id,
          expectedRevision: 1,
          content: { text: 'Too late' },
        }),
      ).rejects.toThrow('stale');
      await expect(
        settleEngagementProposal(database, {
          workspaceId: workspace,
          id: approval.id,
          clientActionId: action,
          expectedRevision: 1,
          status: 'sent',
        }),
      ).rejects.toThrow('stale');
      const settled = await settleEngagementProposal(database, {
        workspaceId: workspace,
        id: approval.id,
        clientActionId: approval.clientActionId,
        expectedRevision: 1,
        status: 'unknown',
      });
      expect(settled.status).toBe('unknown');
      expect((await listEngagementReviewQueue(database, workspace)).map((item) => item.id)).toEqual(
        expect.arrayContaining([unsupported.id, approval.id]),
      );
      await expect(
        settleEngagementProposal(database, {
          workspaceId: workspace,
          id: approval.id,
          clientActionId: approval.clientActionId,
          expectedRevision: 1,
          status: 'sent',
        }),
      ).rejects.toThrow('stale');
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
      ).toBe('6');
    } finally {
      await client.close();
    }
  });
});

import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import type { ApiKeyService } from '../src/modules/identity/api-key.service.js';
import { allowAllActionPolicy } from '../src/modules/policy/action-policy.js';
import {
  claimDueFanvueDm,
  finishClaimedFanvueDm,
} from '../src/modules/providers/fanvue-dm-pending.repository.js';
import { dispatchDueFanvueDms } from '../src/modules/providers/fanvue-dm-pending.worker.js';
import { registerFanvueMessageRoutes } from '../src/modules/providers/fanvue-message.routes.js';
import { FanvueMessageService } from '../src/modules/providers/fanvue-message.service.js';
import { registerFanvueReadRoutes } from '../src/modules/providers/fanvue-read.routes.js';
import { listFanvueDmCheckpoints } from '../src/modules/providers/fanvue-dm-checkpoint.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000101';
const accountId = '00000000-0000-4000-8000-000000000102';
const fanUuid = '00000000-0000-4000-8000-000000000103';
const groupFanUuid = '00000000-0000-4000-8000-000000000107';
const staleFanUuid = '00000000-0000-4000-8000-000000000108';
const actorId = '00000000-0000-4000-8000-000000000104';
const mediaUuid = '00000000-0000-4000-8000-000000000105';
const otherMediaUuid = '00000000-0000-4000-8000-000000000106';
const headers = {
  authorization: 'Bearer pr_test.secret',
  'x-publish-relay-workspace': workspaceId,
};
const messageUrl = `/api/v1/fanvue/accounts/${accountId}/chats/${fanUuid}/messages`;
const checkpointUrl = `/api/v1/fanvue/accounts/${accountId}/chats/${fanUuid}/checkpoints`;

const migrationNames = [
  '0079_fanvue_action_intents.sql',
  '0089_fanvue_chat_create_intent.sql',
  '0109_fanvue_action_history_payload.sql',
  '0110_fanvue_action_target_context.sql',
  '0111_fanvue_dm_pending_intents.sql',
  '0112_fanvue_dm_pending_media_preview.sql',
  '0113_fanvue_pending_target_label.sql',
  '0115_fanvue_comment_pending_intents.sql',
  '0126_fanvue_dm_groups.sql',
  '0127_fanvue_dm_conversation_facts.sql',
  '0130_fanvue_dm_checkpoint_action_ownership.sql',
];

async function setup() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TYPE audit_actor_type AS ENUM ('user', 'api_key', 'delegated', 'system');
    CREATE TABLE provider_accounts (
      id uuid NOT NULL,
      workspace_id uuid NOT NULL,
      destination_provider text NOT NULL,
      connection_id uuid,
      disconnected_at timestamptz,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE TABLE provider_connections (
      id uuid NOT NULL,
      workspace_id uuid NOT NULL,
      provider text NOT NULL,
      status text NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE TABLE media_objects (
      workspace_id uuid NOT NULL,
      byte_size bigint NOT NULL DEFAULT 0,
      state text NOT NULL,
      deleted_at timestamptz
    );
    CREATE TABLE publication_jobs (
      workspace_id uuid NOT NULL,
      state text NOT NULL,
      scheduled_at timestamptz
    );
    CREATE TABLE engagement_proposals (
      workspace_id uuid NOT NULL,
      client_action_id uuid NOT NULL,
      provider text NOT NULL,
      kind text NOT NULL,
      status text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE memberships (
      workspace_id uuid NOT NULL,
      user_id uuid NOT NULL,
      role text NOT NULL
    );
    CREATE TABLE api_keys (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL,
      capabilities text[] NOT NULL,
      revoked_at timestamptz,
      expires_at timestamptz
    );
    CREATE TABLE registered_clients (
      id text PRIMARY KEY,
      allowed_scopes text[] NOT NULL
    );
    CREATE TABLE delegated_grants (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL,
      client_id text NOT NULL,
      scopes text[] NOT NULL,
      revoked_at timestamptz
    );
    INSERT INTO provider_accounts VALUES ('${accountId}', '${workspaceId}', 'fanvue');
    INSERT INTO api_keys VALUES (
      '${actorId}', '${workspaceId}', ARRAY['fanvue:chats:send', 'fanvue:chats:read'], NULL, NULL
    );
  `);
  for (const name of migrationNames)
    await pg.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const database = drizzle(pg) as unknown as NodePgDatabase;
  let providerFailure = false;
  let providerMessageOrdinal = 0;
  const sendMessage = vi.fn(() => {
    if (providerFailure) throw new Error('provider outcome unknown');
    providerMessageOrdinal += 1;
    return Promise.resolve({
      messageUuid:
        providerMessageOrdinal === 1
          ? '00000000-0000-4000-8000-000000000111'
          : '00000000-0000-4000-8000-000000000112',
    });
  });
  let latestInbound = {
    latestInboundMessageUuid: '00000000-0000-4000-8000-000000000121',
    latestInboundAt: new Date('2026-11-21T07:00:00Z'),
  };
  let preflightFailure = false;
  const reads = {
    getExistingChatForMessage: vi
      .fn()
      .mockResolvedValue({ accessToken: 'fixture', targetLabel: null }),
    getMediaStatus: vi.fn((input: { mediaUuid: string }) =>
      Promise.resolve({ uuid: input.mediaUuid, status: 'ready' }),
    ),
    getLatestRecipientMessageForSendBoundary: vi.fn(() => {
      if (preflightFailure) throw new Error('provider unavailable');
      return Promise.resolve(latestInbound);
    }),
  };
  const messages = new FanvueMessageService(
    database,
    reads as never,
    { sendMessage } as never,
    allowAllActionPolicy,
  );
  const principal = {
    id: actorId,
    actorId,
    workspaceId,
    capabilities: ['fanvue:chats:send', 'fanvue:chats:read'],
  };
  const apiKeys = {
    authenticate: vi.fn().mockResolvedValue(principal),
    requireCapability: vi.fn(),
  } as unknown as ApiKeyService;
  const rateLimiter = new ApiRateLimiter({
    workspace: 100,
    key: 100,
    mutationWorkspace: 100,
    mutationKey: 100,
    windowMs: 60_000,
  });
  const application = Fastify();
  registerFanvueMessageRoutes(application, messages, apiKeys, rateLimiter);
  registerFanvueReadRoutes(
    application,
    {
      listDmConversationCheckpoints: (input: {
        workspaceId: string;
        accountId: string;
        fanUuid: string;
      }) => listFanvueDmCheckpoints(database, input),
    } as never,
    apiKeys,
    rateLimiter,
  );
  return {
    pg,
    database,
    application,
    messages,
    sendMessage,
    setLatestInbound(value: typeof latestInbound) {
      latestInbound = value;
    },
    setPreflightFailure(value: boolean) {
      preflightFailure = value;
    },
    setProviderFailure(value: boolean) {
      providerFailure = value;
    },
  };
}

const open = new Set<PGlite>();
afterEach(async () => {
  await Promise.all([...open].map((pg) => pg.close()));
  open.clear();
});

describe('Fanvue checkpoint public lifecycle integration', () => {
  it('runs immediate route through real action/checkpoint repositories and fences replay conflicts', async () => {
    const context = await setup();
    open.add(context.pg);
    const clientActionId = '00000000-0000-4000-8000-000000000131';
    const payload = {
      clientActionId,
      text: 'A gift',
      mediaUuids: [mediaUuid],
      checkpoint: { kind: 'free_gift', ordinal: 1, providerMediaUuid: mediaUuid },
    };
    const sent = await context.application.inject({
      method: 'POST',
      url: messageUrl,
      headers,
      payload,
    });
    expect(sent.statusCode, sent.body).toBe(201);
    expect(context.sendMessage).toHaveBeenCalledTimes(1);
    const receipt = await context.application.inject({
      method: 'GET',
      url: checkpointUrl,
      headers,
    });
    expect(receipt.json()).toMatchObject({
      data: [{ kind: 'free_gift', ordinal: 1, state: 'confirmed', providerMediaUuid: mediaUuid }],
    });

    expect(
      (await context.application.inject({ method: 'POST', url: messageUrl, headers, payload }))
        .statusCode,
    ).toBe(201);
    expect(context.sendMessage).toHaveBeenCalledTimes(1);

    const secondMeaning = await context.application.inject({
      method: 'POST',
      url: messageUrl,
      headers,
      payload: {
        ...payload,
        checkpoint: { ...payload.checkpoint, kind: 'paid_offer', ordinal: 2 },
      },
    });
    expect(secondMeaning.statusCode).toBe(409);
    const mediaMismatch = await context.application.inject({
      method: 'POST',
      url: messageUrl,
      headers,
      payload: { ...payload, mediaUuids: [otherMediaUuid] },
    });
    expect(mediaMismatch.statusCode).toBe(409);
    expect(context.sendMessage).toHaveBeenCalledTimes(1);

    const confirmedMediaReuse = await context.application.inject({
      method: 'POST',
      url: messageUrl,
      headers,
      payload: {
        ...payload,
        clientActionId: '00000000-0000-4000-8000-000000000132',
        checkpoint: { ...payload.checkpoint, ordinal: 2 },
      },
    });
    expect(confirmedMediaReuse.statusCode).toBe(500);
    expect(context.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('runs scheduled route through worker settlement and exposes confirmed, cancelled and unknown receipts', async () => {
    const context = await setup();
    open.add(context.pg);
    const schedule = async (clientActionId: string, ordinal: number) =>
      context.application.inject({
        method: 'POST',
        url: `${messageUrl}/scheduled`,
        headers,
        payload: {
          clientActionId,
          text: `Scheduled ${String(ordinal)}`,
          dueAt: '2026-11-21T07:01:00.000Z',
          checkpoint: { kind: 'silent_followup', ordinal },
        },
      });
    const runtime = {
      database: context.database,
      messages: context.messages,
      workerId: 'checkpoint-integration',
      leaseMs: 30_000,
    };

    const confirmedId = '00000000-0000-4000-8000-000000000141';
    const scheduled = await schedule(confirmedId, 1);
    expect(scheduled.statusCode, scheduled.body).toBe(201);
    expect(await dispatchDueFanvueDms(runtime, new Date('2026-11-21T07:02:00Z'))).toMatchObject({
      state: 'confirmed',
      settled: true,
    });

    const cancelledId = '00000000-0000-4000-8000-000000000142';
    expect((await schedule(cancelledId, 2)).statusCode).toBe(201);
    const cancelled = await context.application.inject({
      method: 'DELETE',
      url: `${messageUrl}/scheduled/${cancelledId}`,
      headers,
    });
    expect(cancelled.json()).toMatchObject({ data: { cancelled: true } });

    const unknownId = '00000000-0000-4000-8000-000000000143';
    expect((await schedule(unknownId, 3)).statusCode).toBe(201);
    context.setProviderFailure(true);
    expect(await dispatchDueFanvueDms(runtime, new Date('2026-11-21T09:00:00Z'))).toMatchObject({
      state: 'unknown',
      settled: true,
    });

    const receipts = await context.application.inject({
      method: 'GET',
      url: checkpointUrl,
      headers,
    });
    expect(receipts.json()).toMatchObject({
      data: [
        { kind: 'silent_followup', ordinal: 1, state: 'confirmed' },
        { kind: 'silent_followup', ordinal: 2, state: 'cancelled' },
        { kind: 'silent_followup', ordinal: 3, state: 'unknown' },
      ],
    });
    expect(context.sendMessage).toHaveBeenCalledTimes(2);
    expect((await schedule(confirmedId, 1)).statusCode).toBe(201);
    expect(context.sendMessage).toHaveBeenCalledTimes(2);

    context.setProviderFailure(false);
    context.setLatestInbound({
      latestInboundMessageUuid: '00000000-0000-4000-8000-000000000122',
      latestInboundAt: new Date('2026-11-21T07:00:00Z'),
    });
    const cancelledGroupId = '00000000-0000-4000-8000-000000000151';
    const groupPayload = {
      clientActionId: cancelledGroupId,
      bubbles: ['Guarded root'],
      expectedLatestInboundMessageUuid: '00000000-0000-4000-8000-000000000121',
      expectedLatestInboundAt: '2026-11-21T07:00:00.000Z',
      earliestAt: '2026-11-21T10:00:00.000Z',
      latestAt: '2026-11-21T10:05:00.000Z',
    };
    const cancelledGroupSchedule = await context.application.inject({
      method: 'POST',
      url: `/api/v1/fanvue/accounts/${accountId}/chats/${groupFanUuid}/messages/scheduled-groups`,
      headers,
      payload: groupPayload,
    });
    expect(cancelledGroupSchedule.statusCode, cancelledGroupSchedule.body).toBe(201);
    expect(await dispatchDueFanvueDms(runtime, new Date('2026-11-21T11:00:00Z'))).toMatchObject({
      state: 'cancelled',
      settled: true,
    });
    const cancelledGroup = await context.application.inject({
      method: 'GET',
      url: `/api/v1/fanvue/accounts/${accountId}/chats/${groupFanUuid}/messages/scheduled-groups/${cancelledGroupId}`,
      headers,
    });
    expect(cancelledGroup.json()).toMatchObject({ data: { bubbles: [{ status: 'cancelled' }] } });

    const frozenGroupId = '00000000-0000-4000-8000-000000000152';
    context.setPreflightFailure(true);
    expect(
      (
        await context.application.inject({
          method: 'POST',
          url: `/api/v1/fanvue/accounts/${accountId}/chats/${groupFanUuid}/messages/scheduled-groups`,
          headers,
          payload: { ...groupPayload, clientActionId: frozenGroupId },
        })
      ).statusCode,
    ).toBe(201);
    expect(await dispatchDueFanvueDms(runtime, new Date('2026-11-21T12:00:00Z'))).toMatchObject({
      state: 'unknown',
      settled: true,
    });

    context.setPreflightFailure(false);
    const staleId = '00000000-0000-4000-8000-000000000153';
    const staleSchedule = await context.application.inject({
      method: 'POST',
      url: `/api/v1/fanvue/accounts/${accountId}/chats/${staleFanUuid}/messages/scheduled`,
      headers,
      payload: {
        clientActionId: staleId,
        text: 'Stale lease proof',
        dueAt: '2026-11-21T07:01:00.000Z',
        checkpoint: { kind: 'silent_followup', ordinal: 1 },
      },
    });
    expect(staleSchedule.statusCode, staleSchedule.body).toBe(201);
    const claim = await claimDueFanvueDm(context.database, {
      workerId: 'current-owner',
      now: new Date('2026-11-21T13:00:00Z'),
      leaseMs: 30_000,
    });
    expect(claim?.clientActionId).toBe(staleId);
    expect(
      await finishClaimedFanvueDm(context.database, {
        workspaceId,
        id: claim?.id ?? '',
        leaseOwner: 'stale-owner',
        state: 'confirmed',
      }),
    ).toBe(false);
    expect(
      await finishClaimedFanvueDm(context.database, {
        workspaceId,
        id: claim?.id ?? '',
        leaseOwner: claim?.leaseOwner ?? '',
        state: 'pending',
      }),
    ).toBe(true);
  });
});

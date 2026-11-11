import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import { registerFacebookPageDmSendRoute } from '../src/modules/providers/facebook-messenger-send.routes.js';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  send: vi.fn(),
  scheduled: vi.fn(),
  cancel: vi.fn(),
  hasPending: vi.fn(),
  groupReplay: vi.fn(),
  groupSchedule: vi.fn(),
  groupStatus: vi.fn(),
  groupCancel: vi.fn(),
  approvalWindow: vi.fn(),
}));
vi.mock('../src/modules/providers/facebook-dm-group.repository.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  findPageDmGroupReplay: mocks.groupReplay,
  schedulePageDmGroup: mocks.groupSchedule,
  getPageDmGroupStatus: mocks.groupStatus,
  cancelPageDmGroup: mocks.groupCancel,
}));
vi.mock('../src/modules/providers/facebook-dm-pending.repository.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  schedulePageDm: mocks.scheduled,
  cancelPendingPageDm: mocks.cancel,
  hasPendingPageDmAction: mocks.hasPending,
}));
vi.mock('../src/modules/identity/machine-auth.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  authorizePageEngagementRequest: mocks.authorize,
}));
vi.mock('../src/modules/providers/facebook-messenger-send.service.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  sendAccountPageConversationMessage: mocks.send,
  getPageDmApprovalWindow: mocks.approvalWindow,
}));

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const clientActionId = '00000000-0000-4000-8000-000000000003';
const path = `/api/v1/destinations/${accountId}/facebook-conversations/t_123/messages`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasPending.mockResolvedValue(false);
  mocks.groupReplay.mockResolvedValue(null);
});

async function appForTest() {
  const app = Fastify();
  registerFacebookPageDmSendRoute(
    app,
    { database: {} as never, keys: {} as never, client: {} as never, policy: {} as never },
    {} as never,
    new ApiRateLimiter({
      workspace: 100,
      key: 100,
      mutationWorkspace: 100,
      mutationKey: 100,
      windowMs: 60_000,
    }),
  );
  await app.ready();
  return app;
}

describe('Facebook Page DM send machine route', () => {
  it('forwards explicit final-exit intent without changing the ordinary send response', async () => {
    const app = await appForTest();
    try {
      mocks.authorize.mockResolvedValue({ workspaceId, actorId: clientActionId, kind: 'api-key' });
      mocks.send.mockResolvedValue({ state: 'confirmed', messageId: 'mid_final' });
      const response = await app.inject({
        method: 'POST',
        url: path,
        payload: { clientActionId, text: 'I will stop replying here', finalExit: true },
      });
      expect(response.statusCode).toBe(201);
      expect(mocks.send).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ finalExit: true, conversationId: 't_123' }),
      );
      expect(response.body).not.toContain('finalExit');
    } finally {
      await app.close();
    }
  });
  it('accepts one guarded bubble but rejects an empty group', async () => {
    const app = await appForTest();
    const base = `/api/v1/destinations/${accountId}/facebook-conversations/t_123/scheduled-groups`;
    try {
      mocks.authorize.mockResolvedValue({ workspaceId, actorId: clientActionId, kind: 'api-key' });
      mocks.approvalWindow.mockResolvedValue({
        latestInboundMessageId: 'mid-1',
        windowDeadline: new Date(Date.now() + 3600_000),
      });
      mocks.groupSchedule.mockResolvedValue({
        id: clientActionId,
        status: 'pending',
        dueAt: new Date(Date.now() + 60_000),
      });
      const body = {
        clientActionId,
        texts: ['Brief reply'],
        expectedLatestInboundMessageId: 'mid-1',
      };
      const accepted = await app.inject({ method: 'POST', url: base, payload: body });
      expect(accepted.statusCode).toBe(202);
      expect(mocks.groupSchedule).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ texts: ['Brief reply'] }),
      );
      expect(mocks.send).not.toHaveBeenCalled();
      const rejected = await app.inject({
        method: 'POST',
        url: base,
        payload: { ...body, texts: [] },
      });
      expect(rejected.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('schedules a guarded multi-bubble group without a provider call and exposes only bounded state', async () => {
    const app = await appForTest();
    const rootId = '00000000-0000-4000-8000-000000000006';
    const base = `/api/v1/destinations/${accountId}/facebook-conversations/t_123/scheduled-groups`;
    try {
      mocks.authorize.mockResolvedValue({ workspaceId, actorId: clientActionId, kind: 'api-key' });
      mocks.approvalWindow.mockResolvedValue({
        latestInboundMessageId: 'mid-1',
        windowDeadline: new Date(Date.now() + 3600_000),
      });
      mocks.groupSchedule.mockResolvedValue({
        id: rootId,
        status: 'pending',
        dueAt: new Date(Date.now() + 60_000),
      });
      const response = await app.inject({
        method: 'POST',
        url: base,
        payload: {
          clientActionId,
          texts: ['First', 'Second'],
          finalExit: true,
          expectedLatestInboundMessageId: 'mid-1',
        },
      });
      expect(response.statusCode).toBe(202);
      expect(mocks.groupSchedule).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          workspaceId,
          accountId,
          conversationId: 't_123',
          texts: ['First', 'Second'],
          finalExit: true,
          expectedLatestInboundMessageId: 'mid-1',
        }),
      );
      expect(mocks.send).not.toHaveBeenCalled();
      mocks.groupStatus.mockResolvedValue({
        id: rootId,
        bubbles: [{ sequence: 0, status: 'pending', dueAt: new Date().toISOString() }],
      });
      const status = await app.inject({ method: 'GET', url: `${base}/${rootId}` });
      expect(status.statusCode).toBe(200);
      expect(status.body).not.toContain('First');
      mocks.groupCancel.mockResolvedValue({ cancelled: 2 });
      const cancelled = await app.inject({ method: 'DELETE', url: `${base}/${rootId}` });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toMatchObject({ data: { cancelled: 2 } });
    } finally {
      await app.close();
    }
  });
  it('refuses a group when the latest inbound changed before scheduling', async () => {
    const app = await appForTest();
    try {
      mocks.authorize.mockResolvedValue({ workspaceId, actorId: clientActionId, kind: 'api-key' });
      mocks.approvalWindow.mockResolvedValue({
        latestInboundMessageId: 'mid-new',
        windowDeadline: new Date(Date.now() + 3600_000),
      });
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/destinations/${accountId}/facebook-conversations/t_123/scheduled-groups`,
        payload: {
          clientActionId,
          texts: ['First', 'Second'],
          expectedLatestInboundMessageId: 'mid-old',
        },
      });
      expect(response.statusCode).toBe(409);
      expect(mocks.groupSchedule).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('persists a jittered intent without sending and exposes bounded cancellation', async () => {
    const app = await appForTest();
    try {
      mocks.authorize.mockResolvedValue({ workspaceId, actorId: clientActionId, kind: 'api-key' });
      mocks.scheduled.mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000006',
        status: 'pending',
        dueAt: new Date('2026-11-05T11:00:00.000Z'),
      });
      const response = await app.inject({
        method: 'POST',
        url: path,
        payload: {
          clientActionId,
          text: 'Hello',
          schedule: { earliestDelaySeconds: 300, latestDelaySeconds: 300 },
        },
      });
      expect(response.statusCode).toBe(202);
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.scheduled).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ clientActionId }),
      );
      mocks.cancel.mockResolvedValue(true);
      const cancelled = await app.inject({
        method: 'DELETE',
        url: `/api/v1/destinations/${accountId}/facebook-conversations/t_123/scheduled/00000000-0000-4000-8000-000000000006`,
      });
      expect(cancelled.statusCode).toBe(200);
      expect(mocks.cancel).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ workspaceId, conversationId: 't_123' }),
      );
    } finally {
      await app.close();
    }
  });
  it('requires exact dms:send and projects only an outcome receipt', async () => {
    const app = await appForTest();
    try {
      mocks.authorize.mockResolvedValue({
        workspaceId,
        actorId: '00000000-0000-4000-8000-000000000004',
        kind: 'api-key',
      });
      mocks.send.mockResolvedValue({ state: 'confirmed', messageId: 'mid_9' });
      const response = await app.inject({
        method: 'POST',
        url: path,
        payload: { clientActionId, text: 'Hello' },
      });
      expect(response.statusCode).toBe(201);
      expect(mocks.authorize).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        undefined,
        expect.anything(),
        accountId,
        'dms:send',
      );
      expect(mocks.send).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          workspaceId,
          accountId,
          conversationId: 't_123',
          clientActionId,
          text: 'Hello',
        }),
      );
      expect(response.json()).toEqual(
        expect.objectContaining({
          data: { state: 'confirmed', messageId: 'mid_9' },
        }),
      );
      expect(response.body).not.toMatch(/accessToken|recipientId|credentialId|server-token/);
    } finally {
      await app.close();
    }
  });

  it('does not reach the service without authentication or valid input', async () => {
    const app = await appForTest();
    try {
      mocks.authorize.mockResolvedValue(null);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: path,
            payload: { clientActionId, text: 'Hello' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: path,
            payload: { clientActionId, text: '' },
          })
        ).statusCode,
      ).toBe(400);
      expect(mocks.send).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

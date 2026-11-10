import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import {
  ApiKeyAuthorizationError,
  type ApiKeyService,
} from '../src/modules/identity/api-key.service.js';
import {
  FanvueMessageActionConflictError,
  FanvueSelectedFanUnavailableError,
  type FanvueMessageService,
} from '../src/modules/providers/fanvue-message.service.js';
import { registerFanvueMessageRoutes } from '../src/modules/providers/fanvue-message.routes.js';
import { FanvueReadUnavailableError } from '../src/modules/providers/fanvue-read.service.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const fanUuid = '00000000-0000-4000-8000-000000000003';
const clientActionId = '00000000-0000-4000-8000-000000000004';
const messageUuid = '00000000-0000-4000-8000-000000000005';
const actorId = '00000000-0000-4000-8000-000000000006';
const mediaUuid = '00000000-0000-4000-8000-000000000008';
const localMediaId = '00000000-0000-4000-8000-000000000009';
const url = `/api/v1/fanvue/accounts/${accountId}/chats/${fanUuid}/messages`;
const headers = {
  authorization: 'Bearer pr_test.secret',
  'x-publish-relay-workspace': workspaceId,
};

function fixture(allowed = true) {
  const sendMessage = vi.fn().mockResolvedValue({ state: 'confirmed', messageUuid });
  const createChat = vi.fn().mockResolvedValue({ state: 'confirmed', fanUuid });
  const scheduleMessage = vi.fn().mockResolvedValue({
    clientActionId,
    status: 'pending',
    dueAt: new Date('2026-11-11T10:00:00Z'),
  });
  const scheduledMessageStatus = vi
    .fn()
    .mockResolvedValue({ clientActionId, status: 'pending', dueAt: '2026-11-11T10:00:00.000Z' });
  const cancelScheduledMessage = vi.fn().mockResolvedValue(true);
  const requireCapability = vi.fn().mockImplementation(() => {
    if (!allowed) throw new ApiKeyAuthorizationError('missing capability');
  });
  const apiKeys = {
    authenticate: vi.fn().mockImplementation((requestedWorkspace: string) =>
      requestedWorkspace === workspaceId
        ? Promise.resolve({
            id: actorId,
            workspaceId,
            capabilities: allowed ? ['fanvue:chats:send'] : ['fanvue:chats:read'],
          })
        : Promise.resolve(null),
    ),
    requireCapability,
  } as unknown as ApiKeyService;
  const application = Fastify();
  registerFanvueMessageRoutes(
    application,
    {
      sendMessage,
      createChat,
      scheduleMessage,
      scheduledMessageStatus,
      cancelScheduledMessage,
    } as unknown as FanvueMessageService,
    apiKeys,
    new ApiRateLimiter({
      workspace: 100,
      key: 100,
      mutationWorkspace: 100,
      mutationKey: 100,
      windowMs: 60_000,
    }),
  );
  return {
    application,
    sendMessage,
    createChat,
    scheduleMessage,
    scheduledMessageStatus,
    cancelScheduledMessage,
    requireCapability,
  };
}

describe('Fanvue scheduled DM machine routes', () => {
  const scheduledUrl = `${url}/scheduled`;
  const receiptUrl = `${scheduledUrl}/${clientActionId}`;
  it('schedules without sending and exposes only a bounded receipt', async () => {
    const context = fixture();
    const response = await context.application.inject({
      method: 'POST',
      url: scheduledUrl,
      headers,
      payload: { clientActionId, text: 'Later', dueAt: '2026-11-11T10:00:00Z' },
    });
    expect(response.statusCode).toBe(201);
    expect(context.scheduleMessage).toHaveBeenCalledWith({
      workspaceId,
      accountId,
      fanUuid,
      clientActionId,
      text: 'Later',
      dueAt: new Date('2026-11-11T10:00:00Z'),
      actor: { type: 'api-key', id: actorId },
    });
    expect(context.sendMessage).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      data: {
        clientActionId,
        status: 'pending',
        dueAt: '2026-11-11T10:00:00.000Z',
      },
    });
    expect(response.body).not.toMatch(/actorId|accessToken|mediaIds|price|fingerprint/);
    expect(Buffer.byteLength(response.body)).toBeLessThan(512);
    const status = await context.application.inject({ method: 'GET', url: receiptUrl, headers });
    expect(status.statusCode).toBe(200);
    expect(context.scheduledMessageStatus).toHaveBeenCalledWith({
      workspaceId,
      accountId,
      fanUuid,
      clientActionId,
    });
    const cancel = await context.application.inject({ method: 'DELETE', url: receiptUrl, headers });
    expect(cancel.json()).toMatchObject({ data: { cancelled: true } });
  });

  it('rejects read-only keys and provider media UUIDs before scheduling', async () => {
    const denied = fixture(false);
    expect(
      (
        await denied.application.inject({
          method: 'POST',
          url: scheduledUrl,
          headers,
          payload: { clientActionId, text: 'Later', dueAt: '2026-11-11T10:00:00Z' },
        })
      ).statusCode,
    ).toBe(403);
    expect(denied.scheduleMessage).not.toHaveBeenCalled();
    const context = fixture();
    expect(
      (
        await context.application.inject({
          method: 'POST',
          url: scheduledUrl,
          headers,
          payload: { clientActionId, mediaUuids: [mediaUuid], dueAt: '2026-11-11T10:00:00Z' },
        })
      ).statusCode,
    ).toBe(400);
    expect(context.scheduleMessage).not.toHaveBeenCalled();
  });
});

describe('Fanvue selected-fan chat creation route', () => {
  const chatUrl = `/api/v1/fanvue/accounts/${accountId}/chats`;
  const payload = { fanUuid, clientActionId, audience: 'followers', page: 1 };

  it('binds account, fan and actor without sending a message', async () => {
    const context = fixture();
    const response = await context.application.inject({
      method: 'POST',
      url: chatUrl,
      headers,
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ data: { state: 'confirmed', fanUuid } });
    expect(context.createChat).toHaveBeenCalledWith({
      workspaceId,
      accountId,
      ...payload,
      size: 15,
      actor: { type: 'api-key', id: actorId },
    });
    expect(context.sendMessage).not.toHaveBeenCalled();
  });

  it('denies read-only keys and maps contactability and uncertain outcomes', async () => {
    const denied = fixture(false);
    expect(
      (await denied.application.inject({ method: 'POST', url: chatUrl, headers, payload }))
        .statusCode,
    ).toBe(403);
    expect(denied.createChat).not.toHaveBeenCalled();
    const context = fixture();
    context.createChat.mockResolvedValueOnce({ state: 'failed', failureStatus: 400 });
    const contactability = await context.application.inject({
      method: 'POST',
      url: chatUrl,
      headers,
      payload,
    });
    expect(contactability.statusCode).toBe(400);
    expect(contactability.json()).toMatchObject({ error: { code: 'fanvue_chat_rejected' } });
    context.createChat.mockResolvedValueOnce({ state: 'unknown' });
    expect(
      (await context.application.inject({ method: 'POST', url: chatUrl, headers, payload }))
        .statusCode,
    ).toBe(202);
  });

  it('rejects a different workspace header before account command', async () => {
    const context = fixture();
    const response = await context.application.inject({
      method: 'POST',
      url: chatUrl,
      headers: { ...headers, 'x-publish-relay-workspace': '00000000-0000-4000-8000-000000000999' },
      payload,
    });
    expect(response.statusCode).toBe(401);
    expect(context.createChat).not.toHaveBeenCalled();
  });

  it('rejects stale selection and malformed Audience selectors', async () => {
    const context = fixture();
    context.createChat.mockRejectedValueOnce(new FanvueSelectedFanUnavailableError());
    const stale = await context.application.inject({
      method: 'POST',
      url: chatUrl,
      headers,
      payload,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'selected_fan_unavailable' } });
    const malformed = await context.application.inject({
      method: 'POST',
      url: chatUrl,
      headers,
      payload: { ...payload, cursor: 'unexpected' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(context.createChat).toHaveBeenCalledTimes(1);
    const badSize = await context.application.inject({
      method: 'POST',
      url: chatUrl,
      headers,
      payload: { ...payload, size: 51 },
    });
    expect(badSize.statusCode).toBe(400);
    expect(context.createChat).toHaveBeenCalledTimes(1);
  });
});

describe('Fanvue account-scoped machine text send', () => {
  it('requires a distinct send scope and derives actor/workspace from the credential', async () => {
    const context = fixture();
    const response = await context.application.inject({
      method: 'POST',
      url,
      headers,
      payload: { text: 'Hello', clientActionId },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ data: { state: 'confirmed', messageUuid } });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toMatch(/accessToken|credentialId|requestFingerprint|fanEmail/);
    expect(Buffer.byteLength(response.body)).toBeLessThan(1024);
    expect(context.requireCapability).toHaveBeenCalledWith(
      expect.anything(),
      'fanvue:chats:send',
      expect.any(String),
    );
    expect(context.sendMessage).toHaveBeenCalledWith({
      workspaceId,
      accountId,
      fanUuid,
      clientActionId,
      text: 'Hello',
      actor: { type: 'api-key', id: actorId },
    });
  });

  it('denies read-only or invalid requests before the send command', async () => {
    const denied = fixture(false);
    const scope = await denied.application.inject({
      method: 'POST',
      url,
      headers,
      payload: { text: 'Hello', clientActionId },
    });
    expect(scope.statusCode).toBe(403);
    expect(denied.sendMessage).not.toHaveBeenCalled();
    const invalid = fixture();
    const response = await invalid.application.inject({
      method: 'POST',
      url,
      headers,
      payload: { text: '', clientActionId },
    });
    expect(response.statusCode).toBe(400);
    expect(invalid.sendMessage).not.toHaveBeenCalled();
  });

  it('exposes unknown outcome and hides an unavailable account', async () => {
    const context = fixture();
    context.sendMessage.mockResolvedValueOnce({ state: 'unknown' });
    const unknown = await context.application.inject({
      method: 'POST',
      url,
      headers,
      payload: { text: 'Hello', clientActionId },
    });
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toMatchObject({ data: { state: 'unknown' } });
    context.sendMessage.mockRejectedValueOnce(new FanvueReadUnavailableError('account_not_found'));
    const missing = await context.application.inject({
      method: 'POST',
      url,
      headers,
      payload: { text: 'Hello', clientActionId },
    });
    expect(missing.statusCode).toBe(404);
    context.sendMessage.mockRejectedValueOnce(new FanvueMessageActionConflictError());
    const conflict = await context.application.inject({
      method: 'POST',
      url,
      headers,
      payload: { text: 'Hello', clientActionId },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it('forwards free and priced provider media to the same scoped command', async () => {
    const context = fixture();
    const free = await context.application.inject({
      method: 'POST',
      url,
      headers,
      payload: { clientActionId, mediaUuids: [mediaUuid] },
    });
    expect(free.statusCode).toBe(201);
    expect(context.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUuids: [mediaUuid], actor: { type: 'api-key', id: actorId } }),
    );
    const paid = await context.application.inject({
      method: 'POST',
      url,
      headers,
      payload: {
        clientActionId,
        text: 'Unlock',
        mediaUuids: [mediaUuid],
        price: 300,
        mediaPreviewUuid: mediaUuid,
      },
    });
    expect(paid.statusCode).toBe(201);
    expect(context.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ price: 300, mediaPreviewUuid: mediaUuid }),
    );
    const belowMinimum = await context.application.inject({
      method: 'POST',
      url,
      headers,
      payload: { clientActionId, mediaUuids: [mediaUuid], price: 299 },
    });
    expect(belowMinimum.statusCode).toBe(400);
    expect(context.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('forwards selected local media and preview to the canonical command without exposing it back', async () => {
    const context = fixture();
    const response = await context.application.inject({
      method: 'POST',
      url,
      headers,
      payload: {
        clientActionId,
        mediaIds: [localMediaId],
        mediaPreviewId: localMediaId,
        price: 300,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(context.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        accountId,
        clientActionId,
        mediaIds: [localMediaId],
        mediaPreviewId: localMediaId,
        price: 300,
      }),
    );
    expect(response.body).not.toMatch(/mediaIds|mediaPreviewId|providerMediaUuid|credential/);
  });
});

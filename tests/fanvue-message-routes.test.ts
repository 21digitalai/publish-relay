import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import {
  ApiKeyAuthorizationError,
  type ApiKeyService,
} from '../src/modules/identity/api-key.service.js';
import {
  FanvueMessageActionConflictError,
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
  const requireCapability = vi.fn().mockImplementation(() => {
    if (!allowed) throw new ApiKeyAuthorizationError('missing capability');
  });
  const apiKeys = {
    authenticate: vi.fn().mockResolvedValue({
      id: actorId,
      workspaceId,
      capabilities: allowed ? ['fanvue:chats:send'] : ['fanvue:chats:read'],
    }),
    requireCapability,
  } as unknown as ApiKeyService;
  const application = Fastify();
  registerFanvueMessageRoutes(
    application,
    { sendMessage } as unknown as FanvueMessageService,
    apiKeys,
    new ApiRateLimiter({
      workspace: 100,
      key: 100,
      mutationWorkspace: 100,
      mutationKey: 100,
      windowMs: 60_000,
    }),
  );
  return { application, sendMessage, requireCapability };
}

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

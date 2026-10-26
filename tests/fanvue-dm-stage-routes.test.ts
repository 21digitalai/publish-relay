import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import {
  ApiKeyAuthorizationError,
  type ApiKeyService,
} from '../src/modules/identity/api-key.service.js';
import { registerFanvueDmStageRoutes } from '../src/modules/providers/fanvue-dm-stage.routes.js';
import { FanvueReadUnavailableError } from '../src/modules/providers/fanvue-read.service.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const mediaId = '00000000-0000-4000-8000-000000000003';
const clientActionId = '00000000-0000-4000-8000-000000000004';
const url = `/api/v1/fanvue/accounts/${accountId}/dm-media/stage`;
const headers = {
  authorization: 'Bearer pr_test.secret',
  'x-publish-relay-workspace': workspaceId,
};
const body = { mediaId, clientActionId };

function fixture(allowed = true) {
  const stage = vi.fn().mockResolvedValue('uploading');
  const requireCapability = vi.fn().mockImplementation(() => {
    if (!allowed) throw new ApiKeyAuthorizationError('missing capability');
  });
  const apiKeys = {
    authenticate: vi.fn().mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000005',
      workspaceId,
      capabilities: allowed ? ['fanvue:media:upload'] : ['fanvue:chats:send'],
    }),
    requireCapability,
  } as unknown as ApiKeyService;
  const application = Fastify();
  registerFanvueDmStageRoutes(
    application,
    stage,
    apiKeys,
    new ApiRateLimiter({
      workspace: 100,
      key: 100,
      mutationWorkspace: 100,
      mutationKey: 100,
      windowMs: 60_000,
    }),
  );
  return { application, stage, requireCapability };
}

describe('Fanvue account-scoped DM media stage', () => {
  it('uses a separate upload capability and credential-derived tenant', async () => {
    const context = fixture();
    const response = await context.application.inject({
      method: 'POST',
      url,
      headers,
      payload: body,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ data: { state: 'uploading' } });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(context.requireCapability).toHaveBeenCalledWith(
      expect.anything(),
      'fanvue:media:upload',
      expect.any(String),
    );
    expect(context.stage).toHaveBeenCalledWith({ workspaceId, accountId, ...body });
    expect(response.body).not.toMatch(/accessToken|uploadId|storageKey|credential|providerUuid/);
    expect(Buffer.byteLength(response.body)).toBeLessThan(512);
  });

  it('denies send-only keys and malformed or caller-supplied tenant fields', async () => {
    const denied = fixture(false);
    expect(
      (await denied.application.inject({ method: 'POST', url, headers, payload: body })).statusCode,
    ).toBe(403);
    expect(denied.stage).not.toHaveBeenCalled();
    const context = fixture();
    expect(
      (
        await context.application.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...body, workspaceId: accountId },
        })
      ).statusCode,
    ).toBe(400);
    expect(context.stage).not.toHaveBeenCalled();
  });

  it('exposes terminal states without retry and hides a foreign or disconnected account', async () => {
    const context = fixture();
    context.stage
      .mockResolvedValueOnce('unknown')
      .mockResolvedValueOnce('ready')
      .mockRejectedValueOnce(new FanvueReadUnavailableError('account_not_found'));
    const unknown = await context.application.inject({
      method: 'POST',
      url,
      headers,
      payload: body,
    });
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toMatchObject({ data: { state: 'unknown' } });
    const ready = await context.application.inject({ method: 'POST', url, headers, payload: body });
    expect(ready.statusCode).toBe(200);
    const missing = await context.application.inject({
      method: 'POST',
      url,
      headers,
      payload: body,
    });
    expect(missing.statusCode).toBe(404);
  });
});

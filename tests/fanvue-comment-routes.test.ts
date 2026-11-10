import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import {
  ApiKeyAuthorizationError,
  type ApiKeyService,
} from '../src/modules/identity/api-key.service.js';
import { FanvueReadUnavailableError } from '../src/modules/providers/fanvue-read.service.js';
import { registerFanvueCommentRoutes } from '../src/modules/providers/fanvue-comment.routes.js';
import type { FanvueCommentService } from '../src/modules/providers/fanvue-comment.service.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const postUuid = '00000000-0000-4000-8000-000000000003';
const clientActionId = '00000000-0000-4000-8000-000000000004';
const commentUuid = '00000000-0000-4000-8000-000000000005';
const url = `/api/v1/fanvue/accounts/${accountId}/posts/${postUuid}/comments`;
const headers = {
  authorization: 'Bearer pr_test.secret',
  'x-publish-relay-workspace': workspaceId,
};

function fixture(allowed = true) {
  const send = vi.fn().mockResolvedValue({ state: 'confirmed', commentUuid });
  const schedule = vi
    .fn()
    .mockResolvedValue({ clientActionId, status: 'pending', dueAt: '2026-11-11T10:00:00.000Z' });
  const requireCapability = vi.fn().mockImplementation(() => {
    if (!allowed) throw new ApiKeyAuthorizationError('missing capability');
  });
  const apiKeys = {
    authenticate: vi.fn().mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000006',
      workspaceId,
      capabilities: allowed ? ['fanvue:comments:send'] : ['fanvue:posts:read'],
    }),
    requireCapability,
  } as unknown as ApiKeyService;
  const application = Fastify();
  registerFanvueCommentRoutes(
    application,
    { send, schedule } as unknown as FanvueCommentService,
    apiKeys,
    new ApiRateLimiter({
      workspace: 100,
      key: 100,
      mutationWorkspace: 100,
      mutationKey: 100,
      windowMs: 60_000,
    }),
  );
  return { application, send, schedule, requireCapability };
}

describe('Fanvue account-scoped machine comment send', () => {
  it('schedules only with comment send authority and never calls the immediate sender', async () => {
    const context = fixture();
    const response = await context.application.inject({
      method: 'POST',
      url: `${url}/scheduled`,
      headers,
      payload: { text: 'Later', clientActionId, dueAt: '2026-11-11T10:00:00Z' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ data: { clientActionId, status: 'pending' } });
    expect(context.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        accountId,
        postUuid,
        text: 'Later',
        actor: { type: 'api-key', id: '00000000-0000-4000-8000-000000000006' },
      }),
    );
    expect(context.send).not.toHaveBeenCalled();
    expect(
      (
        await fixture(false).application.inject({
          method: 'POST',
          url: `${url}/scheduled`,
          headers,
          payload: { text: 'Later', clientActionId, dueAt: '2026-11-11T10:00:00Z' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('requires distinct send scope and derives actor/workspace from the credential', async () => {
    const context = fixture();
    const response = await context.application.inject({
      method: 'POST',
      url,
      headers,
      payload: { text: 'Thanks', clientActionId },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ data: { state: 'confirmed', commentUuid } });
    expect(response.body).not.toMatch(/accessToken|credentialId|requestFingerprint|postBody/);
    expect(Buffer.byteLength(response.body)).toBeLessThan(1024);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(context.requireCapability).toHaveBeenCalledWith(
      expect.anything(),
      'fanvue:comments:send',
      expect.any(String),
    );
    expect(context.send).toHaveBeenCalledWith({
      workspaceId,
      accountId,
      postUuid,
      clientActionId,
      text: 'Thanks',
      actor: { type: 'api-key', id: '00000000-0000-4000-8000-000000000006' },
    });
  });

  it('does not send with read-only scope or invalid request', async () => {
    const denied = fixture(false);
    const scope = await denied.application.inject({
      method: 'POST',
      url,
      headers,
      payload: { text: 'Thanks', clientActionId },
    });
    expect(scope.statusCode).toBe(403);
    expect(denied.send).not.toHaveBeenCalled();
    const invalid = fixture();
    const response = await invalid.application.inject({
      method: 'POST',
      url,
      headers,
      payload: { text: '', clientActionId },
    });
    expect(response.statusCode).toBe(400);
    expect(invalid.send).not.toHaveBeenCalled();
  });

  it('keeps unknown outcome explicit and hides an unavailable account', async () => {
    const context = fixture();
    context.send.mockResolvedValueOnce({ state: 'unknown' });
    const unknown = await context.application.inject({
      method: 'POST',
      url,
      headers,
      payload: { text: 'Thanks', clientActionId },
    });
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toMatchObject({ data: { state: 'unknown' } });
    context.send.mockRejectedValueOnce(new FanvueReadUnavailableError('account_not_found'));
    const missing = await context.application.inject({
      method: 'POST',
      url,
      headers,
      payload: { text: 'Thanks', clientActionId },
    });
    expect(missing.statusCode).toBe(404);
  });
});

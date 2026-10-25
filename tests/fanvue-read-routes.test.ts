import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it, vi } from 'vitest';

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import {
  ApiKeyAuthorizationError,
  type ApiKeyService,
} from '../src/modules/identity/api-key.service.js';
import type { AuthService } from '../src/modules/identity/auth.service.js';
import {
  registerFanvueBrowserReadRoutes,
  registerFanvueReadRoutes,
} from '../src/modules/providers/fanvue-read.routes.js';
import type { FanvueReadService } from '../src/modules/providers/fanvue-read.service.js';

const workspaceId = '00000000-0000-4000-8000-000000000201';
const accountId = '00000000-0000-4000-8000-000000000202';
const fanUuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const headers = {
  authorization: 'Bearer pr_test.secret',
  'x-publish-relay-workspace': workspaceId,
};

function fixture(capabilities: string[]) {
  const authenticate = vi.fn().mockResolvedValue({ id: 'key-1', workspaceId, capabilities });
  const requireCapability = vi.fn().mockImplementation((_principal, capability: string) => {
    if (!capabilities.includes(capability))
      throw new ApiKeyAuthorizationError('missing capability');
  });
  const listMessages = vi.fn().mockResolvedValue({ data: [{ uuid: fanUuid, text: 'hello' }] });
  const listMedia = vi.fn().mockResolvedValue({ data: [{ uuid: fanUuid, status: 'ready' }] });
  const listComments = vi.fn().mockResolvedValue({ data: [], nextCursor: null });
  const service = {
    listMessages,
    listMedia,
    listComments,
    listPosts: vi.fn(),
    getPost: vi.fn(),
    listChats: vi.fn(),
    getMediaStatus: vi.fn(),
  } as unknown as FanvueReadService;
  const rateLimiter = new ApiRateLimiter({
    workspace: 100,
    key: 100,
    mutationWorkspace: 100,
    mutationKey: 100,
    windowMs: 60_000,
  });
  const application = Fastify();
  registerFanvueReadRoutes(
    application,
    service,
    { authenticate, requireCapability } as unknown as ApiKeyService,
    rateLimiter,
  );
  return { application, authenticate, requireCapability, listMessages, listMedia, listComments };
}

describe('Fanvue agent read boundary', () => {
  it('uses workspace-bound authentication, chat capability and account ID', async () => {
    const context = fixture(['fanvue:chats:read']);
    const response = await context.application.inject({
      method: 'GET',
      url: `/api/v1/fanvue/accounts/${accountId}/chats/${fanUuid}/messages?page=2`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(context.requireCapability).toHaveBeenCalledWith(
      expect.anything(),
      'fanvue:chats:read',
      expect.any(String),
    );
    expect(context.listMessages).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, accountId, fanUuid, page: 2 }),
    );
    expect(response.json()).not.toHaveProperty('accessToken');
  });

  it('does not permit media read using chat capability', async () => {
    const context = fixture(['fanvue:chats:read']);
    const response = await context.application.inject({
      method: 'GET',
      url: `/api/v1/fanvue/accounts/${accountId}/media`,
      headers,
    });
    expect(response.statusCode).toBe(403);
    expect(context.listMedia).not.toHaveBeenCalled();
  });

  it('rejects absent workspace preflight before any read', async () => {
    const context = fixture(['fanvue:chats:read']);
    const response = await context.application.inject({
      method: 'GET',
      url: `/api/v1/fanvue/accounts/${accountId}/chats`,
      headers: { authorization: headers.authorization },
    });
    expect(response.statusCode).toBe(401);
    expect(context.authenticate).not.toHaveBeenCalled();
  });

  it('requires post-read capability for comment pagination', async () => {
    const context = fixture(['fanvue:posts:read']);
    const response = await context.application.inject({
      method: 'GET',
      url: `/api/v1/fanvue/accounts/${accountId}/posts/${fanUuid}/comments?cursor=opaque`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(context.listComments).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, accountId, postUuid: fanUuid, cursor: 'opaque' }),
    );
    expect(context.requireCapability).toHaveBeenCalledWith(
      expect.anything(),
      'fanvue:posts:read',
      expect.any(String),
    );
  });

  it('uses authenticated browser workspace through the same read service', async () => {
    const context = fixture([]);
    const application = Fastify();
    await application.register(cookie);
    registerFanvueBrowserReadRoutes(
      application,
      { listComments: context.listComments } as unknown as FanvueReadService,
      {
        authenticate: vi.fn().mockResolvedValue({ workspaceId, userId: 'user-1', role: 'viewer' }),
      } as unknown as AuthService,
      new ApiRateLimiter({
        workspace: 100,
        key: 100,
        mutationWorkspace: 100,
        mutationKey: 100,
        windowMs: 60_000,
      }),
    );
    const response = await application.inject({
      method: 'GET',
      url: `/api/fanvue/accounts/${accountId}/posts/${fanUuid}/comments`,
      headers: { cookie: `publish_relay_session=${workspaceId}.session` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(context.listComments).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, accountId, postUuid: fanUuid }),
    );
  });
});

import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import type { AuthService } from '../src/modules/identity/auth.service.js';
import type { ApiKeyService } from '../src/modules/identity/api-key.service.js';
import type { FanvueReadService } from '../src/modules/providers/fanvue-read.service.js';
import type { FanvueVaultCatalogService } from '../src/modules/providers/fanvue-vault-catalog.service.js';
import { registerFanvueVaultCatalogRoutes } from '../src/modules/providers/fanvue-vault-catalog.routes.js';

const workspaceId = '00000000-0000-4000-8000-000000000301';
const accountId = '00000000-0000-4000-8000-000000000302';
const mediaUuid = '00000000-0000-4000-8000-000000000303';
const rateLimiter = () =>
  new ApiRateLimiter({
    workspace: 100,
    key: 100,
    mutationWorkspace: 100,
    mutationKey: 100,
    windowMs: 60_000,
  });

function apiKeys(capabilities: string[]) {
  return {
    authenticate: vi.fn().mockResolvedValue({ id: 'key-1', workspaceId, capabilities }),
    requireCapability: vi.fn().mockImplementation((_principal, capability: string) => {
      if (!capabilities.includes(capability)) throw new Error('capability denied');
    }),
  } as unknown as ApiKeyService;
}

describe('Fanvue vault catalog routes', () => {
  it('uses the shared catalog service with bounded machine media-read input', async () => {
    const listFolderMedia = vi.fn().mockResolvedValue({ data: [], pagination: { hasMore: false } });
    const application = Fastify();
    registerFanvueVaultCatalogRoutes(application, {
      database: {} as never,
      reads: {} as FanvueReadService,
      apiKeys: apiKeys(['fanvue:media:read']),
      rateLimiter: rateLimiter(),
      catalog: { listFolderMedia } as unknown as FanvueVaultCatalogService,
    });
    const response = await application.inject({
      method: 'GET',
      url: `/api/v1/fanvue/accounts/${accountId}/vault/catalog/${encodeURIComponent('DMs / BG')}?page=2&size=50`,
      headers: {
        authorization: 'Bearer pr_test.secret',
        'x-publish-relay-workspace': workspaceId,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(listFolderMedia).toHaveBeenCalledWith({
      workspaceId,
      accountId,
      folderName: 'DMs / BG',
      page: 2,
      size: 50,
    });
    expect(response.body).not.toContain('accessToken');
  });

  it('streams only allowlisted no-store image previews without forwarding authorization', async () => {
    const fetchPreview = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
      }),
    );
    const application = Fastify();
    await application.register(cookie);
    registerFanvueVaultCatalogRoutes(application, {
      database: {} as never,
      reads: {
        getMediaThumbnail: vi.fn().mockResolvedValue({
          status: 'ready',
          url: 'https://media.fanvue.com/thumb/private.jpg?signature=secret',
        }),
      } as unknown as FanvueReadService,
      apiKeys: apiKeys([]),
      rateLimiter: rateLimiter(),
      auth: {
        authenticate: vi.fn().mockResolvedValue({ workspaceId, userId: 'user-1', role: 'owner' }),
      } as unknown as AuthService,
      fetch: fetchPreview,
      catalog: {} as FanvueVaultCatalogService,
    });
    const response = await application.inject({
      method: 'GET',
      url: `/api/fanvue/accounts/${accountId}/vault/media/${mediaUuid}/preview`,
      headers: { cookie: `publish_relay_session=${workspaceId}.session` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(fetchPreview).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'media.fanvue.com' }),
      expect.objectContaining({ redirect: 'error' }),
    );
    expect(fetchPreview.mock.calls[0]?.[1]).not.toHaveProperty('headers');
    expect(response.body).not.toContain('signature');
  });

  it('rejects a signed preview on any non-Fanvue host before fetching it', async () => {
    const fetchPreview = vi.fn<typeof fetch>();
    const application = Fastify();
    await application.register(cookie);
    registerFanvueVaultCatalogRoutes(application, {
      database: {} as never,
      reads: {
        getMediaThumbnail: vi.fn().mockResolvedValue({
          status: 'ready',
          url: 'https://attacker.example/private.jpg',
        }),
      } as unknown as FanvueReadService,
      apiKeys: apiKeys([]),
      rateLimiter: rateLimiter(),
      auth: {
        authenticate: vi.fn().mockResolvedValue({ workspaceId, userId: 'user-1', role: 'owner' }),
      } as unknown as AuthService,
      fetch: fetchPreview,
      catalog: {} as FanvueVaultCatalogService,
    });
    const response = await application.inject({
      method: 'GET',
      url: `/api/fanvue/accounts/${accountId}/vault/media/${mediaUuid}/preview`,
      headers: { cookie: `publish_relay_session=${workspaceId}.session` },
    });
    expect(response.statusCode).toBe(502);
    expect(fetchPreview).not.toHaveBeenCalled();
  });
});

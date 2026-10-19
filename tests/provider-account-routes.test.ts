import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccountSummary } from '../src/modules/credentials/provider-account.service.js';

vi.mock('../src/modules/identity/auth.routes.js', () => ({
  authorizeRequest: vi.fn(),
  CSRF_COOKIE: 'publish_relay_csrf',
}));
vi.mock('../src/modules/credentials/provider-account.service.js', () => ({
  disconnectProviderAccount: vi.fn(),
  listProviderAccounts: vi.fn(() => Promise.resolve([])),
  listProviderAccountsPage: vi.fn(() => Promise.resolve({ accounts: [], nextCursor: null })),
  availableWithTikTokRuntime: vi.fn((account: ProviderAccountSummary, enabled: boolean) =>
    account.destinationProvider === 'tiktok' && !enabled
      ? { ...account, availability: 'publishing_unavailable' }
      : account,
  ),
  InvalidAccountPageCursorError: class extends Error {},
  updateYouTubeAccountDefaults: vi.fn(() => Promise.resolve('updated')),
  updateXLongPostDeclaration: vi.fn(() => Promise.resolve('updated')),
}));
vi.mock('../src/modules/credentials/provider-account-exposure.service.js', () => ({
  editFacebookPageExposure: vi.fn(() => Promise.resolve('updated')),
  listFacebookPageExposureTargets: vi.fn(() =>
    Promise.resolve({ workspaceIds: [], nextCursor: null }),
  ),
  setExposedPageCalendarVisibility: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../src/modules/providers/tiktok-capabilities.service.js', () => ({
  fetchTikTokCapabilitySnapshot: vi.fn(),
  TikTokCapabilityUnavailableError: class extends Error {},
}));

import { authorizeRequest } from '../src/modules/identity/auth.routes.js';
import {
  listProviderAccountsPage,
  updateYouTubeAccountDefaults,
  updateXLongPostDeclaration,
} from '../src/modules/credentials/provider-account.service.js';
import { registerProviderAccountRoutes } from '../src/modules/credentials/provider-account.routes.js';
import {
  editFacebookPageExposure,
  listFacebookPageExposureTargets,
  setExposedPageCalendarVisibility,
} from '../src/modules/credentials/provider-account-exposure.service.js';
import { fetchTikTokCapabilitySnapshot } from '../src/modules/providers/tiktok-capabilities.service.js';

const accountId = '00000000-0000-4000-8000-000000000204';
const targetWorkspaceId = '00000000-0000-4000-8000-000000000205';
const identity = { workspaceId: 'workspace-1', userId: 'user-1' };

async function application(withTikTok = false) {
  const app = Fastify();
  await app.register(cookie);
  registerProviderAccountRoutes(app, {
    auth: {} as never,
    database: {} as never,
    ...(withTikTok ? { tiktok: { keys: {} as never, client: {} as never } } : {}),
  });
  return app;
}

describe('provider account routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authorizeRequest).mockResolvedValue(identity as never);
    vi.mocked(updateYouTubeAccountDefaults).mockResolvedValue('updated');
  });

  it('keeps the account list allowlisted and requests read authorization', async () => {
    vi.mocked(listProviderAccountsPage).mockResolvedValue({
      accounts: [
        {
          id: accountId,
          provider: 'youtube',
          destinationProvider: 'youtube',
          displayName: 'Channel',
          status: 'active',
          availability: 'active',
          remoteParentAccountId: null,
          capabilitySnapshot: { schemaVersion: 1, contentKinds: ['video'], media: {} },
          capabilitiesCheckedAt: new Date('2026-09-01T00:00:00Z'),
          capabilityFreshness: 'fresh',
          adapterDefaults: { madeForKids: false },
          xLongPosts: null,
          updatedAt: new Date('2026-09-01T00:00:00Z'),
        },
      ],
      nextCursor: null,
    });
    const response = await (
      await application()
    ).inject({ method: 'GET', url: '/api/provider-accounts' });
    expect(response.statusCode).toBe(200);
    expect(authorizeRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'content:read',
    );
    expect(response.body).toContain('adapterDefaults');
    expect(response.body).not.toContain('credentialId');
    expect(response.body).not.toContain('connectionId');
  });

  it('does not offer a connected TikTok destination without enabled runtime', async () => {
    vi.mocked(listProviderAccountsPage).mockResolvedValue({
      accounts: [
        {
          id: accountId,
          provider: 'tiktok',
          destinationProvider: 'tiktok',
          displayName: 'Creator',
          status: 'active',
          availability: 'active',
          remoteParentAccountId: null,
          capabilitySnapshot: { schemaVersion: 1, contentKinds: [], media: {} },
          capabilitiesCheckedAt: null,
          capabilityFreshness: 'unknown',
          adapterDefaults: null,
          xLongPosts: null,
          updatedAt: new Date('2026-10-20T00:00:00Z'),
        },
      ],
      nextCursor: null,
    });
    const disabled = await (
      await application()
    ).inject({ method: 'GET', url: '/api/provider-accounts' });
    expect(
      disabled.json<{ data: { accounts: ProviderAccountSummary[] } }>().data.accounts[0]
        ?.availability,
    ).toBe('publishing_unavailable');
    const enabled = await (
      await application(true)
    ).inject({ method: 'GET', url: '/api/provider-accounts' });
    expect(
      enabled.json<{ data: { accounts: ProviderAccountSummary[] } }>().data.accounts[0]
        ?.availability,
    ).toBe('active');
  });

  it('requires owner capability and CSRF for the Page exposure checkbox mutation', async () => {
    const app = await application();
    const url = `/api/provider-accounts/${accountId}/exposures/${targetWorkspaceId}`;
    vi.mocked(authorizeRequest).mockResolvedValueOnce(null);
    expect((await app.inject({ method: 'PATCH', url, payload: { expose: true } })).statusCode).toBe(
      401,
    );
    expect((await app.inject({ method: 'PATCH', url, payload: { expose: true } })).statusCode).toBe(
      403,
    );
    const headers = { cookie: 'publish_relay_csrf=token', 'x-csrf-token': 'token' };
    expect(
      (await app.inject({ method: 'PATCH', url, headers, payload: { expose: 'true' } })).statusCode,
    ).toBe(400);
    const updated = await app.inject({ method: 'PATCH', url, headers, payload: { expose: true } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ data: { exposed: true } });
    const exposureInput = vi.mocked(editFacebookPageExposure).mock.calls[0]?.[1];
    expect(exposureInput).toMatchObject({
      originWorkspaceId: identity.workspaceId,
      targetWorkspaceId,
      accountId,
      userId: identity.userId,
      expose: true,
    });
    expect(typeof exposureInput?.requestId).toBe('string');
    vi.mocked(editFacebookPageExposure).mockResolvedValueOnce('active_jobs');
    expect(
      (await app.inject({ method: 'PATCH', url, headers, payload: { expose: false } })).statusCode,
    ).toBe(409);
  });

  it('lists only authorized Page exposure target IDs with a bounded cursor', async () => {
    const app = await application();
    const url = `/api/provider-accounts/${accountId}/exposures`;
    vi.mocked(listFacebookPageExposureTargets).mockResolvedValueOnce({
      workspaceIds: [targetWorkspaceId],
      nextCursor: targetWorkspaceId,
    });
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        workspaceIds: [targetWorkspaceId],
        nextCursor: targetWorkspaceId,
      },
    });
    expect((await app.inject({ method: 'GET', url: `${url}?cursor=bad` })).statusCode).toBe(400);
    vi.mocked(authorizeRequest).mockResolvedValueOnce(null);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });

  it('requires target-owner auth, CSRF, and a boolean for calendar visibility', async () => {
    const app = await application();
    const url = `/api/provider-accounts/${accountId}/calendar-visibility`;
    vi.mocked(authorizeRequest).mockResolvedValueOnce(null);
    expect(
      (await app.inject({ method: 'PATCH', url, payload: { showPosts: false } })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'PATCH', url, payload: { showPosts: false } })).statusCode,
    ).toBe(403);
    const headers = { cookie: 'publish_relay_csrf=token', 'x-csrf-token': 'token' };
    expect(
      (await app.inject({ method: 'PATCH', url, headers, payload: { showPosts: 'false' } }))
        .statusCode,
    ).toBe(400);
    const updated = await app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { showPosts: false },
    });
    expect(updated.json()).toMatchObject({ data: { showPosts: false } });
    expect(setExposedPageCalendarVisibility).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: identity.workspaceId,
      userId: identity.userId,
      accountId,
      showPosts: false,
    });
    vi.mocked(setExposedPageCalendarVisibility).mockResolvedValueOnce(false);
    expect(
      (await app.inject({ method: 'PATCH', url, headers, payload: { showPosts: true } }))
        .statusCode,
    ).toBe(404);
  });

  it('requires owner permission, CSRF, and a strict boolean for X declaration', async () => {
    const app = await application();
    const url = `/api/provider-accounts/${accountId}/x-long-posts`;
    vi.mocked(authorizeRequest).mockResolvedValueOnce(null);
    expect(
      (await app.inject({ method: 'PATCH', url, payload: { allowed: true } })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'PATCH', url, payload: { allowed: true } })).statusCode,
    ).toBe(403);
    const headers = { cookie: 'publish_relay_csrf=token', 'x-csrf-token': 'token' };
    expect(
      (await app.inject({ method: 'PATCH', url, headers, payload: { allowed: 'true' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url,
          headers,
          payload: { allowed: true, verified: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(updateXLongPostDeclaration).not.toHaveBeenCalled();
    const accepted = await app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { allowed: true },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<{ data: { xLongPosts: unknown } }>().data.xLongPosts).toEqual({
      allowed: true,
      source: 'self_declared',
      verified: false,
    });
    expect(updateXLongPostDeclaration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        accountId,
        allowed: true,
      }),
    );
    expect(authorizeRequest).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      'workspace:manage',
    );
    vi.mocked(updateXLongPostDeclaration).mockResolvedValueOnce('missing');
    expect(
      (await app.inject({ method: 'PATCH', url, headers, payload: { allowed: false } })).statusCode,
    ).toBe(404);
  });

  it('requires management authorization and CSRF for strict YouTube defaults', async () => {
    const app = await application();
    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/provider-accounts/${accountId}/youtube-defaults`,
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(updateYouTubeAccountDefaults).not.toHaveBeenCalled();
    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/provider-accounts/${accountId}/youtube-defaults`,
      headers: { cookie: 'publish_relay_csrf=token', 'x-csrf-token': 'token' },
      payload: { madeForKids: false, internal: 'forbidden' },
    });
    expect(invalid.statusCode).toBe(400);
    const accepted = await app.inject({
      method: 'PATCH',
      url: `/api/provider-accounts/${accountId}/youtube-defaults`,
      headers: { cookie: 'publish_relay_csrf=token', 'x-csrf-token': 'token' },
      payload: { privacyStatus: 'public', madeForKids: false },
    });
    expect(accepted.statusCode).toBe(200);
    expect(authorizeRequest).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      'workspace:manage',
    );
    expect(updateYouTubeAccountDefaults).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        accountId,
      }),
    );
  });

  it('returns authentication and scoped-account failures without mutating', async () => {
    const app = await application();
    vi.mocked(authorizeRequest).mockResolvedValueOnce(null);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/provider-accounts/${accountId}/youtube-defaults`,
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    vi.mocked(updateYouTubeAccountDefaults).mockResolvedValueOnce('missing');
    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/provider-accounts/${accountId}/youtube-defaults`,
      headers: { cookie: 'publish_relay_csrf=token', 'x-csrf-token': 'token' },
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
  });

  it('serves a no-store, session-scoped TikTok creator snapshot to the Composer', async () => {
    const snapshot = {
      id: '00000000-0000-4000-8000-000000000399',
      accountId,
      nickname: 'Fresh Creator',
      privacyOptions: ['PUBLIC_TO_EVERYONE'],
      commentDisabled: false,
      duetDisabled: true,
      stitchDisabled: true,
      maxVideoDurationSeconds: 60,
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    } as const;
    vi.mocked(fetchTikTokCapabilitySnapshot).mockResolvedValueOnce(snapshot as never);
    const response = await (
      await application(true)
    ).inject({
      method: 'GET',
      url: `/api/provider-accounts/${accountId}/tiktok-capabilities`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ data: snapshot, error: null });
    expect(response.body).not.toContain('credentialVersion');
    expect(response.body).not.toContain('connectionId');
    expect(fetchTikTokCapabilitySnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ workspaceId: identity.workspaceId, accountId }),
    );
  });
});

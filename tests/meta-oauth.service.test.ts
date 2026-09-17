import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/tenant-transaction.js', () => ({
  withTenantTransaction: vi.fn(
    (_database: unknown, _tenant: unknown, callback: (transaction: unknown) => unknown) =>
      callback({}),
  ),
}));
vi.mock('../src/modules/credentials/oauth.service.js', () => ({
  consumeOauthCallback: vi.fn(),
  issueOauthTransaction: vi.fn(),
}));
vi.mock('../src/modules/policy/action-policy.js', () => ({
  allowAllActionPolicy: {},
  enforceWorkspaceAction: vi.fn(),
}));
vi.mock('../src/modules/credentials/provider-connection.repository.js', () => ({
  assertActiveMembership: vi.fn(),
  markProviderDestinationsUnavailable: vi.fn(),
  replaceProviderConnection: vi.fn(),
}));

import {
  consumeOauthCallback,
  issueOauthTransaction,
} from '../src/modules/credentials/oauth.service.js';
import { enforceWorkspaceAction } from '../src/modules/policy/action-policy.js';
import {
  beginMetaOauthConnection,
  completeMetaOauthConnection,
  revokeRemoteMetaGrant,
} from '../src/modules/providers/meta-oauth.service.js';
import { MetaRequestError } from '../src/modules/providers/meta-http-client.js';

describe('Meta OAuth service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enforces policy before issuing server-owned state and callback', async () => {
    vi.mocked(enforceWorkspaceAction).mockRejectedValueOnce(new Error('denied'));
    const client = { authorizationUrl: vi.fn() };
    await expect(
      beginMetaOauthConnection({} as never, {} as never, client as never, {
        workspaceId: 'w1',
        userId: 'u1',
        callbackUrl: 'https://relay.test/api/oauth/meta/callback',
        requestId: 'r1',
      }),
    ).rejects.toThrow('denied');
    expect(issueOauthTransaction).not.toHaveBeenCalled();
    expect(client.authorizationUrl).not.toHaveBeenCalled();
  });

  it('binds callback state to the same workspace, user, and Meta provider before exchange', async () => {
    vi.mocked(consumeOauthCallback).mockResolvedValueOnce(null);
    const client = { exchangeCode: vi.fn(), discoverPages: vi.fn() };
    await expect(
      completeMetaOauthConnection({} as never, {} as never, client as never, {
        workspaceId: 'w1',
        userId: 'u1',
        state: 'state',
        code: 'code',
        requestId: 'r1',
      }),
    ).resolves.toBeNull();
    expect(consumeOauthCallback).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      workspaceId: 'w1',
      state: 'state',
      userId: 'u1',
      provider: 'meta',
    });
    expect(client.exchangeCode).not.toHaveBeenCalled();
  });

  it.each(['auth', 'permission'] as const)(
    'treats an already-invalid remote grant (%s) as revoked so local cleanup can continue',
    async (kind) => {
      const client = { revoke: vi.fn().mockRejectedValue(new MetaRequestError(401, kind)) };

      await expect(
        revokeRemoteMetaGrant(client as never, 'expired-token'),
      ).resolves.toBeUndefined();
      expect(client.revoke).toHaveBeenCalledWith('expired-token');
    },
  );

  it('fails closed when remote revoke has a transient unknown outcome', async () => {
    const client = {
      revoke: vi.fn().mockRejectedValue(new MetaRequestError(503, 'transient')),
    };

    await expect(revokeRemoteMetaGrant(client as never, 'token')).rejects.toMatchObject({
      kind: 'transient',
    });
  });
});

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
} from '../src/modules/providers/meta-oauth.service.js';

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
});

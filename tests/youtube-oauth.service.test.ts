import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/tenant-transaction.js', () => ({
  withTenantTransaction: vi.fn(
    (_db: unknown, _tenant: unknown, callback: (transaction: unknown) => unknown) => callback({}),
  ),
}));
vi.mock('../src/modules/credentials/oauth.service.js', () => ({
  consumeOauthCallback: vi.fn(),
  issueOauthTransaction: vi.fn(),
}));
vi.mock('../src/modules/credentials/provider-connection.service.js', () => ({ connectProvider: vi.fn() }));
vi.mock('../src/modules/policy/action-policy.js', () => ({
  allowAllActionPolicy: {},
  enforceWorkspaceAction: vi.fn(),
}));

import { consumeOauthCallback, issueOauthTransaction } from '../src/modules/credentials/oauth.service.js';
import { connectProvider } from '../src/modules/credentials/provider-connection.service.js';
import { enforceWorkspaceAction } from '../src/modules/policy/action-policy.js';
import { beginYouTubeOauthConnection, completeYouTubeOauthConnection } from '../src/modules/providers/youtube-oauth.service.js';

const input = { workspaceId: 'w1', userId: 'u1', state: 'state', code: 'code', requestId: 'r1' };

describe('YouTube OAuth service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('binds callback consumption to initiating user and provider before Google side effects', async () => {
    vi.mocked(consumeOauthCallback).mockResolvedValueOnce(null).mockResolvedValueOnce({
      userId: 'u1', provider: 'youtube', redirectUri: 'https://relay/callback', codeVerifier: 'verifier',
    });
    vi.mocked(connectProvider).mockResolvedValue({ accounts: [] } as never);
    const client = { exchangeCode: vi.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresAt: '2026-09-09T00:00:00.000Z' }) };
    await expect(completeYouTubeOauthConnection({} as never, {} as never, client as never, { ...input, userId: 'wrong' })).resolves.toBeNull();
    expect(client.exchangeCode).not.toHaveBeenCalled();
    await completeYouTubeOauthConnection({} as never, {} as never, client as never, input);
    expect(consumeOauthCallback).toHaveBeenNthCalledWith(2, expect.anything(), expect.anything(), {
      workspaceId: 'w1', state: 'state', userId: 'u1', provider: 'youtube',
    });
    expect(client.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('passes the full credential to encrypted connection persistence and allowlists channel fields', async () => {
    vi.mocked(consumeOauthCallback).mockResolvedValue({ userId: 'u1', provider: 'youtube', redirectUri: 'https://relay/callback', codeVerifier: 'verifier' });
    const credential = { accessToken: 'access', refreshToken: 'refresh', expiresAt: '2026-09-09T00:00:00.000Z', scope: 'youtube.upload' };
    const client = { exchangeCode: vi.fn().mockResolvedValue(credential), discoverChannels: vi.fn().mockResolvedValue([{ id: 'channel', displayName: 'Channel', privateField: 'drop' }]) };
    vi.mocked(connectProvider).mockImplementation(async (_db, _keys, adapter, connectionInput) => {
      expect(JSON.parse(connectionInput.accessToken)).toEqual(credential);
      await expect(adapter.discoverAccounts(connectionInput.accessToken)).resolves.toEqual([{ providerAccountId: 'channel', displayName: 'Channel' }]);
      return { accounts: [] } as never;
    });
    await completeYouTubeOauthConnection({} as never, {} as never, client as never, input);
  });

  it('enforces policy before issuing a transaction or provider URL', async () => {
    vi.mocked(enforceWorkspaceAction).mockRejectedValue(new Error('denied'));
    const client = { authorizationUrl: vi.fn() };
    await expect(beginYouTubeOauthConnection({} as never, {} as never, client as never, {
      workspaceId: 'w1', userId: 'u1', callbackUrl: 'https://relay/callback', requestId: 'r1',
    })).rejects.toThrow('denied');
    expect(issueOauthTransaction).not.toHaveBeenCalled();
    expect(client.authorizationUrl).not.toHaveBeenCalled();
  });
});

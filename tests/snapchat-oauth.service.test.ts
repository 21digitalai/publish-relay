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
vi.mock('../src/modules/credentials/provider-connection.service.js', () => ({
  connectProvider: vi.fn(),
}));
vi.mock('../src/modules/policy/action-policy.js', () => ({
  allowAllActionPolicy: {},
  enforceWorkspaceAction: vi.fn(),
}));

import {
  consumeOauthCallback,
  issueOauthTransaction,
} from '../src/modules/credentials/oauth.service.js';
import { connectProvider } from '../src/modules/credentials/provider-connection.service.js';
import { enforceWorkspaceAction } from '../src/modules/policy/action-policy.js';
import {
  beginSnapchatOauthConnection,
  completeSnapchatOauthConnection,
} from '../src/modules/providers/snapchat-oauth.service.js';

const input = {
  workspaceId: 'workspace',
  userId: 'user',
  state: 'state',
  code: 'code',
  requestId: 'request',
};
const token = {
  access_token: 'access-secret',
  refresh_token: 'refresh-secret',
  scope: 'snapchat-profile-api',
  token_type: 'Bearer',
  expires_in: 3600,
};
const profile = { id: 'd6ed1cac-e0cd-4109-bf04-539cb8591838', display_name: 'Owned profile' };

describe('Snapchat owner-bound OAuth service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('authorizes before issuing one-use workspace state', async () => {
    vi.mocked(issueOauthTransaction).mockResolvedValue({
      state: 'state',
      codeChallenge: 'unused',
      expiresAt: new Date('2026-10-19'),
    });
    const client = {
      authorizationUrl: vi.fn().mockReturnValue('https://accounts.snapchat.com/authorize'),
    };
    await beginSnapchatOauthConnection({} as never, {} as never, client as never, {
      ...input,
      callbackUrl: 'https://publishrelay.app/api/oauth/snapchat/callback',
    });
    expect(issueOauthTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        provider: 'snapchat',
        workspaceId: input.workspaceId,
        userId: input.userId,
      }),
    );
    expect(client.authorizationUrl).toHaveBeenCalledWith({
      redirectUri: 'https://publishrelay.app/api/oauth/snapchat/callback',
      state: 'state',
    });
    vi.mocked(enforceWorkspaceAction).mockRejectedValueOnce(new Error('denied'));
    await expect(
      beginSnapchatOauthConnection({} as never, {} as never, client as never, {
        ...input,
        callbackUrl: 'https://publishrelay.app/callback',
      }),
    ).rejects.toThrow('denied');
    expect(issueOauthTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects replay before exchange and stores only verified owner profile subject', async () => {
    const client = {
      exchangeCode: vi.fn().mockResolvedValue(token),
      discoverOwnerProfile: vi.fn().mockResolvedValue(profile),
    };
    vi.mocked(consumeOauthCallback).mockResolvedValueOnce(null).mockResolvedValue({
      userId: input.userId,
      provider: 'snapchat',
      redirectUri: 'https://publishrelay.app/callback',
      codeVerifier: 'unused',
    });
    expect(
      await completeSnapchatOauthConnection({} as never, {} as never, client as never, input),
    ).toBeNull();
    expect(client.exchangeCode).not.toHaveBeenCalled();
    vi.mocked(connectProvider).mockImplementation(async (_db, _keys, adapter, connection) => {
      expect(connection.externalSubjectId).toBe(profile.id);
      expect(connection.provider).toBe('snapchat');
      expect(connection.scopes).toEqual(['snapchat-profile-api']);
      expect(await adapter.discoverAccounts('ignored')).toEqual([
        { providerAccountId: profile.id, displayName: profile.display_name },
      ]);
      return { connectionId: 'connection', accounts: [] };
    });
    await completeSnapchatOauthConnection({} as never, {} as never, client as never, input);
    expect(client.discoverOwnerProfile).toHaveBeenCalledWith(token.access_token);
    expect(consumeOauthCallback).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ provider: 'snapchat', state: 'state', userId: 'user' }),
    );
  });
});

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
  beginTikTokOauthConnection,
  completeTikTokOauthConnection,
} from '../src/modules/providers/tiktok-oauth.service.js';

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
  open_id: 'verified-open-id',
  scope: 'user.info.basic,video.publish',
  token_type: 'Bearer' as const,
  expires_in: 3600,
  refresh_expires_in: 86400,
};

describe('TikTok subject-keyed OAuth service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enforces policy before issuing hashed state and uses exact PKCE callback material', async () => {
    vi.mocked(issueOauthTransaction).mockResolvedValue({
      state: 'state',
      codeChallenge: 'challenge',
      expiresAt: new Date('2026-10-02'),
    });
    const client = {
      authorizationUrl: vi.fn().mockReturnValue('https://www.tiktok.com/v2/auth/authorize/'),
    };
    await beginTikTokOauthConnection({} as never, {} as never, client as never, {
      ...input,
      callbackUrl: 'https://relay.test/api/oauth/tiktok/callback',
    });
    expect(issueOauthTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ provider: 'tiktok' }),
    );
    expect(client.authorizationUrl).toHaveBeenCalledWith({
      redirectUri: 'https://relay.test/api/oauth/tiktok/callback',
      state: 'state',
      codeChallenge: 'challenge',
    });
    vi.mocked(enforceWorkspaceAction).mockRejectedValueOnce(new Error('denied'));
    await expect(
      beginTikTokOauthConnection({} as never, {} as never, client as never, {
        ...input,
        callbackUrl: 'https://relay.test/cb',
      }),
    ).rejects.toThrow('denied');
    expect(issueOauthTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid or replayed state before token exchange and persists verified open_id only', async () => {
    const client = {
      exchangeCode: vi.fn().mockResolvedValue(token),
      discoverAccount: vi.fn().mockResolvedValue({ openId: token.open_id, displayName: 'Creator' }),
    };
    vi.mocked(consumeOauthCallback).mockResolvedValueOnce(null).mockResolvedValue({
      userId: input.userId,
      provider: 'tiktok',
      redirectUri: 'https://relay.test/cb',
      codeVerifier: 'verifier',
    });
    expect(
      await completeTikTokOauthConnection({} as never, {} as never, client as never, input),
    ).toBeNull();
    expect(client.exchangeCode).not.toHaveBeenCalled();
    vi.mocked(connectProvider).mockImplementation(async (_db, _keys, adapter, connection) => {
      expect(connection.externalSubjectId).toBe(token.open_id);
      expect(connection.scopes).toEqual(['user.info.basic', 'video.publish']);
      expect(connection.accessExpiresAt).toEqual(new Date('2026-10-01T01:00:00Z'));
      expect(JSON.parse(connection.accessToken)).toEqual(token);
      expect(await adapter.discoverAccounts(connection.accessToken)).toEqual([
        { providerAccountId: token.open_id, displayName: 'Creator' },
      ]);
      return { connectionId: 'connection', accounts: [] };
    });
    const result = await completeTikTokOauthConnection(
      {} as never,
      {} as never,
      client as never,
      input,
      new Date('2026-10-01T00:00:00Z'),
    );
    expect(result?.connectionId).toBe('connection');
    expect(client.exchangeCode).toHaveBeenCalledWith({
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'https://relay.test/cb',
    });
  });

  it('refuses a changed account identity or missing publication permission without persisting', async () => {
    vi.mocked(consumeOauthCallback).mockResolvedValue({
      userId: input.userId,
      provider: 'tiktok',
      redirectUri: 'https://relay.test/cb',
      codeVerifier: 'verifier',
    });
    const client = {
      exchangeCode: vi.fn().mockResolvedValue(token),
      discoverAccount: vi.fn().mockResolvedValue({ openId: 'other', displayName: 'Creator' }),
    };
    await expect(
      completeTikTokOauthConnection({} as never, {} as never, client as never, input),
    ).rejects.toThrow('does not match');
    client.exchangeCode.mockResolvedValue({ ...token, scope: 'user.info.basic' });
    await expect(
      completeTikTokOauthConnection({} as never, {} as never, client as never, input),
    ).rejects.toThrow('missing required scopes');
    expect(connectProvider).not.toHaveBeenCalled();
  });
});

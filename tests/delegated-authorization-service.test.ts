import { createHash } from 'node:crypto';

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */

import { describe, expect, it, vi } from 'vitest';

import {
  DelegatedAuthorizationService,
  DelegatedTokenError,
  type DelegatedAuthorizationStore,
} from '../src/modules/delegated-authorization/delegated-authorization.service.js';

const now = new Date('2026-09-10T11:00:00Z');
const verifier = 'a'.repeat(43);
const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');

function harness() {
  const store: DelegatedAuthorizationStore = {
    findClient: vi.fn().mockResolvedValue({
      id: 'open-clips-dev',
      redirectUris: ['http://127.0.0.1:43123/callback'],
      allowedScopes: ['destinations:read', 'schedules:write'],
    }),
    createGrantAndCode: vi.fn().mockResolvedValue(undefined),
    exchangeCode: vi.fn().mockResolvedValue({
      grantId: 'grant-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      clientId: 'open-clips-dev',
      scopes: ['destinations:read'],
    }),
    rotateRefreshToken: vi.fn().mockResolvedValue({
      tokenId: 'token-1',
      grantId: 'grant-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      clientId: 'open-clips-dev',
      scopes: ['destinations:read'],
    }),
    authenticateAccessToken: vi.fn().mockResolvedValue(null),
    listGrants: vi.fn().mockResolvedValue([]),
    revokeGrant: vi.fn().mockResolvedValue(true),
  };
  return { store, service: new DelegatedAuthorizationService(store, () => now) };
}

describe('delegated authorization service', () => {
  it('approves only a registered exact redirect and persists no plaintext code', async () => {
    const { store, service } = harness();
    const result = await service.approve({
      requestId: 'request-1',
      grantId: 'grant-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      clientId: 'open-clips-dev',
      redirectUri: 'http://127.0.0.1:43123/callback',
      state: 'client-state',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      requestedScopes: ['destinations:read'],
      scopes: ['destinations:read'],
    });
    expect(result.code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(store.createGrantAndCode).toHaveBeenCalledWith(
      expect.objectContaining({
        codeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        expiresAt: new Date('2026-09-10T11:05:00Z'),
      }),
    );
    expect(JSON.stringify(vi.mocked(store.createGrantAndCode).mock.calls)).not.toContain(
      result.code,
    );
  });

  it('atomically consumes a code and stores only token hashes', async () => {
    const { store, service } = harness();
    const pair = await service.exchangeCode({
      code: 'code-value',
      clientId: 'open-clips-dev',
      redirectUri: 'http://127.0.0.1:43123/callback',
      codeVerifier: verifier,
    });
    expect(store.exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({
        codeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        codeChallenge: challenge,
        now,
        replacement: expect.objectContaining({
          accessTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          refreshTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
    expect(JSON.stringify(vi.mocked(store.exchangeCode).mock.calls)).not.toContain(
      pair.accessToken,
    );
    expect(pair).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
  });

  it('rejects a consumed/invalid code and never mints durable tokens', async () => {
    const { store, service } = harness();
    vi.mocked(store.exchangeCode).mockResolvedValue(null);
    await expect(
      service.exchangeCode({
        code: 'used',
        clientId: 'open-clips-dev',
        redirectUri: 'http://127.0.0.1:43123/callback',
        codeVerifier: verifier,
      }),
    ).rejects.toBeInstanceOf(DelegatedTokenError);
    expect(store.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('rotates refresh credentials through one atomic store operation', async () => {
    const { store, service } = harness();
    const pair = await service.refresh('refresh-value');
    expect(store.rotateRefreshToken).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        now,
        replacement: expect.objectContaining({
          refreshTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
    expect(JSON.stringify(vi.mocked(store.rotateRefreshToken).mock.calls)).not.toContain(
      pair.refreshToken,
    );
  });
});

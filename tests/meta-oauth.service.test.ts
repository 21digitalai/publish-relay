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
vi.mock('../src/modules/credentials/credential.repository.js', () => ({
  createCredential: vi.fn(),
  getActiveCredential: vi.fn(),
  revokeCredential: vi.fn(),
}));
vi.mock('../src/modules/credentials/envelope.js', () => ({
  decryptCredential: vi.fn(),
  encryptCredential: vi.fn(),
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
import {
  getActiveCredential,
  revokeCredential,
} from '../src/modules/credentials/credential.repository.js';
import { decryptCredential } from '../src/modules/credentials/envelope.js';
import { enforceWorkspaceAction } from '../src/modules/policy/action-policy.js';
import {
  beginMetaOauthConnection,
  completeMetaOauthConnection,
  revokeMetaConnection,
  revokeRemoteMetaGrant,
} from '../src/modules/providers/meta-oauth.service.js';
import { MetaRequestError } from '../src/modules/providers/meta-http-client.js';

interface RevokeHarness {
  transaction: unknown;
  updates: Record<string, unknown>[];
  audits: Record<string, unknown>[];
}

function createRevokeHarness(): RevokeHarness {
  const updates: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  let selected = 0;
  const transaction = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve(
                ++selected % 2 === 1 ? [{ id: 'connection', credentialId: 'authority' }] : [],
              ),
          }),
        }),
        where: () =>
          Promise.resolve([
            { credentialId: 'page-credential' },
            { credentialId: 'page-credential' },
          ]),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updates.push(values);
          return Promise.resolve();
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        audits.push(values);
        return Promise.resolve();
      },
    }),
  };
  return { transaction, updates, audits };
}

describe('Meta OAuth service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(revokeCredential).mockResolvedValue(true);
  });

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

  it.each(['auth', 'permission'] as const)(
    'finishes the atomic local revoke lifecycle after remote %s invalidation',
    async (kind) => {
      const harness = createRevokeHarness();
      const { withTenantTransaction } = await import('../src/database/tenant-transaction.js');
      vi.mocked(withTenantTransaction).mockImplementation(async (_database, _tenant, work) =>
        work(harness.transaction as never),
      );
      vi.mocked(getActiveCredential).mockResolvedValue({ id: 'authority' } as never);
      vi.mocked(decryptCredential).mockResolvedValue(
        Buffer.from(JSON.stringify({ accessToken: 'expired-token' })),
      );
      const client = {
        revoke: vi.fn().mockRejectedValue(new MetaRequestError(401, kind)),
      };

      await expect(
        revokeMetaConnection({} as never, {} as never, client as never, {
          workspaceId: 'workspace',
          userId: 'user',
          accountId: 'account',
          requestId: 'request',
        }),
      ).resolves.toBe(true);

      expect(harness.updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ availability: 'reauth_required' }),
          expect.objectContaining({ status: 'revoked' }),
        ]),
      );
      expect(revokeCredential).toHaveBeenCalledTimes(2);
      expect(revokeCredential).toHaveBeenCalledWith(
        harness.transaction,
        'workspace',
        'authority',
        expect.any(Date),
      );
      expect(revokeCredential).toHaveBeenCalledWith(
        harness.transaction,
        'workspace',
        'page-credential',
        expect.any(Date),
      );
      expect(harness.audits).toContainEqual(
        expect.objectContaining({
          action: 'meta.connection.revoked',
          targetId: 'connection',
          requestId: 'request',
          metadata: { destinationCount: 2 },
        }),
      );
    },
  );

  it('replays local revoke safely without another remote call after credentials are revoked', async () => {
    const harness = createRevokeHarness();
    const { withTenantTransaction } = await import('../src/database/tenant-transaction.js');
    vi.mocked(withTenantTransaction).mockImplementation(async (_database, _tenant, work) =>
      work(harness.transaction as never),
    );
    vi.mocked(getActiveCredential)
      .mockResolvedValueOnce({ id: 'authority' } as never)
      .mockResolvedValueOnce(null);
    vi.mocked(decryptCredential).mockResolvedValue(
      Buffer.from(JSON.stringify({ accessToken: 'active-token' })),
    );
    const client = { revoke: vi.fn().mockResolvedValue(undefined) };
    const input = {
      workspaceId: 'workspace',
      userId: 'user',
      accountId: 'account',
      requestId: 'request',
    };

    await expect(
      revokeMetaConnection({} as never, {} as never, client as never, input),
    ).resolves.toBe(true);
    await expect(
      revokeMetaConnection({} as never, {} as never, client as never, input),
    ).resolves.toBe(true);

    expect(client.revoke).toHaveBeenCalledTimes(1);
    expect(harness.updates.filter((update) => update.status === 'revoked')).toHaveLength(2);
    expect(
      harness.audits.filter((audit) => audit.action === 'meta.connection.revoked'),
    ).toHaveLength(2);
  });

  it('does not mutate local lifecycle state after a transient remote revoke failure', async () => {
    const harness = createRevokeHarness();
    const { withTenantTransaction } = await import('../src/database/tenant-transaction.js');
    vi.mocked(withTenantTransaction).mockImplementation(async (_database, _tenant, work) =>
      work(harness.transaction as never),
    );
    vi.mocked(getActiveCredential).mockResolvedValue({ id: 'authority' } as never);
    vi.mocked(decryptCredential).mockResolvedValue(
      Buffer.from(JSON.stringify({ accessToken: 'active-token' })),
    );
    const client = {
      revoke: vi.fn().mockRejectedValue(new MetaRequestError(503, 'transient')),
    };

    await expect(
      revokeMetaConnection({} as never, {} as never, client as never, {
        workspaceId: 'workspace',
        userId: 'user',
        accountId: 'account',
        requestId: 'request',
      }),
    ).rejects.toMatchObject({ kind: 'transient' });

    expect(harness.updates).toHaveLength(0);
    expect(revokeCredential).not.toHaveBeenCalled();
    expect(harness.audits).toHaveLength(0);
  });
});

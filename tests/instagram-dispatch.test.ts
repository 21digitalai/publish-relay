import { beforeEach, describe, expect, it, vi } from 'vitest';

const stage = vi.fn();
const publish = vi.fn();
const adapterClients: unknown[] = [];

vi.mock('../src/modules/providers/instagram-adapter.js', () => ({
  InstagramPublishingAdapter: class {
    public constructor(runtime: { client: unknown }) {
      adapterClients.push(runtime.client);
    }
    public stage = stage;
    public publish = publish;
  },
}));
vi.mock('../src/modules/providers/instagram-artifact-store.js', () => ({
  PostgresInstagramArtifactStore: class {
    public constructor(...input: unknown[]) {
      void input;
    }

    public readonly mocked = true;
  },
}));
vi.mock('../src/modules/credentials/envelope.js', () => ({
  decryptCredential: vi.fn(() => Promise.resolve(Buffer.from('{"accessToken":"token"}'))),
}));
vi.mock('../src/modules/credentials/credential.repository.js', () => ({
  getActiveCredential: vi.fn(() => Promise.resolve({ id: 'credential-1' })),
}));
vi.mock('../src/modules/providers/instagram-login-credential.service.js', () => ({
  getFreshInstagramLoginToken: vi.fn(() => Promise.resolve('instagram-user-token')),
}));
vi.mock('../src/modules/scheduler/job.repository.js', () => ({
  claimDueJobs: vi.fn(),
  claimReconciliationJobs: vi.fn(() => Promise.resolve([])),
  deriveJobIdempotencyKey: vi.fn(() => 'job-key'),
  finishDispatchAttempt: vi.fn(),
  recoverExpiredDispatches: vi.fn(() => Promise.resolve([])),
  resolveReconciliation: vi.fn(() => Promise.resolve(true)),
  startDispatchAttempt: vi.fn(),
}));
vi.mock('../src/database/tenant-transaction.js', () => ({
  withTenantTransaction: vi.fn(
    (_database: unknown, _input: unknown, work: (transaction: unknown) => unknown) =>
      work(databaseQuery),
  ),
}));

import {
  dispatchDueInstagramJobs,
  reconcileInstagramJobs,
} from '../src/modules/providers/instagram-dispatch.service.js';
import { getFreshInstagramLoginToken } from '../src/modules/providers/instagram-login-credential.service.js';
import {
  claimDueJobs,
  finishDispatchAttempt,
  startDispatchAttempt,
} from '../src/modules/scheduler/job.repository.js';
import {
  claimReconciliationJobs,
  resolveReconciliation,
} from '../src/modules/scheduler/job.repository.js';

const job = {
  id: 'job-1',
  workspaceId: 'workspace-1',
  revisionId: 'revision-1',
  providerAccountId: 'account-1',
};
const contextRows = [
  {
    accountRemoteId: 'ig-1',
    availability: 'active',
    credentialId: 'credential-1',
    connectionProvider: 'meta',
    connectionStatus: 'active',
    connectionSubject: 'facebook-subject',
    connectionScopes: [] as string[],
    connectionCredentialId: 'credential-1',
    connectionRevokedAt: null,
    content: { text: 'Caption' },
    mediaId: 'media-1',
    mimeType: 'image/jpeg',
  },
];
const contextRow = contextRows[0];
if (!contextRow) throw new Error('Missing Instagram context fixture');
const databaseQuery = {
  select: vi.fn(() => databaseQuery),
  from: vi.fn(() => databaseQuery),
  innerJoin: vi.fn(() => databaseQuery),
  where: vi.fn(() => databaseQuery),
  orderBy: vi.fn(() => Promise.resolve(contextRows)),
  limit: vi.fn(() => Promise.resolve([job])),
};
const runtime = {
  database: databaseQuery as never,
  keys: {} as never,
  client: {} as never,
  loginClient: { transport: 'instagram' } as never,
  loginTokenClient: {} as never,
  tokenCodec: { issue: vi.fn(() => 'opaque') } as never,
  publicOrigin: 'https://relay.example',
  workerId: 'worker-1',
  leaseMs: 30_000,
};

describe('Instagram reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterClients.length = 0;
    databaseQuery.limit.mockResolvedValue([job]);
    databaseQuery.orderBy.mockResolvedValue(contextRows);
    stage.mockResolvedValue({ stageId: 'instagram:job-key' });
  });

  it('resumes durable adapter state and resolves authoritative publication evidence', async () => {
    vi.mocked(claimReconciliationJobs).mockResolvedValue(['job-1']);
    publish.mockResolvedValue({
      status: 'published',
      externalPostId: 'media-1',
      externalUrl: 'https://instagram.com/p/1',
    });

    await expect(reconcileInstagramJobs(runtime, new Date('2026-09-17T17:00:00Z'))).resolves.toBe(
      1,
    );
    expect(claimReconciliationJobs).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ destinationProvider: 'instagram' }),
    );
    expect(resolveReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        jobId: 'job-1',
        outcome: 'published',
        externalPostId: 'media-1',
      }),
    );
    expect(adapterClients).toEqual([runtime.client]);
  });

  it('keeps ambiguous publication held without replay or resolution', async () => {
    vi.mocked(claimReconciliationJobs).mockResolvedValue(['job-1']);
    publish.mockResolvedValue({
      status: 'unknown',
      reconciliationKey: 'instagram:job-key:publish',
    });

    await expect(reconcileInstagramJobs(runtime, new Date('2026-09-17T17:00:00Z'))).resolves.toBe(
      0,
    );
    expect(resolveReconciliation).not.toHaveBeenCalled();
  });

  it('selects the Instagram Login transport and refreshed user token from the connection family', async () => {
    databaseQuery.orderBy.mockResolvedValue([
      {
        ...contextRow,
        connectionProvider: 'instagram_login',
        connectionSubject: 'app-user',
        connectionScopes: ['instagram_business_basic', 'instagram_business_content_publish'],
      },
    ]);
    vi.mocked(claimDueJobs).mockResolvedValue([job] as never);
    vi.mocked(startDispatchAttempt).mockResolvedValue({ attemptId: 'attempt-1' } as never);
    publish.mockResolvedValue({
      status: 'published',
      externalPostId: 'media-1',
      externalUrl: 'https://instagram.com/p/1',
    });

    await expect(dispatchDueInstagramJobs(runtime, new Date('2026-10-18T00:00:00Z'))).resolves.toBe(
      1,
    );
    expect(getFreshInstagramLoginToken).toHaveBeenCalledWith(
      runtime.database,
      runtime.keys,
      runtime.loginTokenClient,
      expect.objectContaining({ workspaceId: job.workspaceId, appScopedUserId: 'app-user' }),
    );
    expect(adapterClients).toEqual([runtime.loginClient]);
    expect(finishDispatchAttempt).toHaveBeenCalled();
  });

  it('uses the shared Meta credential path for Unified Login connections', async () => {
    databaseQuery.orderBy.mockResolvedValue([
      { ...contextRow, connectionProvider: 'instagram_unified_login' },
    ]);
    vi.mocked(claimDueJobs).mockResolvedValue([job] as never);
    vi.mocked(startDispatchAttempt).mockResolvedValue({ attemptId: 'attempt-1' } as never);
    publish.mockResolvedValue({
      status: 'published',
      externalPostId: 'media-1',
      externalUrl: 'https://instagram.com/p/1',
    });

    await expect(dispatchDueInstagramJobs(runtime, new Date('2026-10-18T00:00:00Z'))).resolves.toBe(
      1,
    );
    expect(adapterClients).toEqual([runtime.client]);
    expect(getFreshInstagramLoginToken).not.toHaveBeenCalled();
    expect(finishDispatchAttempt).toHaveBeenCalled();
  });

  it('refuses partial grants and PNG before sending to the adapter', async () => {
    vi.mocked(claimDueJobs).mockResolvedValue([job] as never);
    databaseQuery.orderBy.mockResolvedValue([
      {
        ...contextRow,
        connectionProvider: 'instagram_login',
        connectionScopes: ['instagram_business_basic'],
      },
    ]);
    await expect(dispatchDueInstagramJobs(runtime)).rejects.toThrow('grant or JPEG');
    databaseQuery.orderBy.mockResolvedValue([
      {
        ...contextRow,
        connectionProvider: 'instagram_login',
        connectionScopes: ['instagram_business_basic', 'instagram_business_content_publish'],
        mimeType: 'image/png',
      },
    ]);
    await expect(dispatchDueInstagramJobs(runtime)).rejects.toThrow('grant or JPEG');
    expect(startDispatchAttempt).not.toHaveBeenCalled();
    expect(getFreshInstagramLoginToken).not.toHaveBeenCalled();
  });
});

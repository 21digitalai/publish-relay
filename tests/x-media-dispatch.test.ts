import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  XMediaSource,
  XMediaUploadClient,
} from '../src/modules/providers/x-media-staging.service.js';
import {
  dispatchDueXMedia,
  reconcileXJobs,
  stageXJobMedia,
} from '../src/modules/providers/x-media-dispatch.service.js';

vi.mock('../src/modules/providers/x-media-staging.service.js', () => ({ stageXMedia: vi.fn() }));
vi.mock('../src/modules/scheduler/job.repository.js', () => ({
  claimDueJobs: vi.fn(),
  deriveJobIdempotencyKey: vi.fn(() => 'job-key'),
  startDispatchAttempt: vi.fn(() =>
    Promise.resolve({ attemptId: 'attempt-1', attemptNumber: 1, idempotencyKey: 'job-key' }),
  ),
  finishDispatchAttempt: vi.fn(() => Promise.resolve(true)),
  recoverExpiredDispatches: vi.fn(() => Promise.resolve([])),
  claimReconciliationJobs: vi.fn(() => Promise.resolve([])),
  resolveReconciliation: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../src/database/tenant-transaction.js', () => ({
  withTenantTransaction: vi.fn(
    (_database: unknown, _input: unknown, work: (transaction: unknown) => unknown) =>
      work(databaseTransaction),
  ),
}));
vi.mock('../src/modules/credentials/credential.repository.js', () => ({
  getActiveCredential: vi.fn(),
}));
vi.mock('../src/modules/credentials/envelope.js', () => ({ decryptCredential: vi.fn() }));

import { stageXMedia } from '../src/modules/providers/x-media-staging.service.js';
import { getActiveCredential } from '../src/modules/credentials/credential.repository.js';
import { decryptCredential } from '../src/modules/credentials/envelope.js';
import { claimDueJobs } from '../src/modules/scheduler/job.repository.js';
import {
  finishDispatchAttempt,
  claimReconciliationJobs,
  recoverExpiredDispatches,
  resolveReconciliation,
  startDispatchAttempt,
} from '../src/modules/scheduler/job.repository.js';

const databaseTransaction = {
  select: vi.fn(() => databaseTransaction),
  from: vi.fn(() => databaseTransaction),
  innerJoin: vi.fn(() => databaseTransaction),
  leftJoin: vi.fn(() => databaseTransaction),
  where: vi.fn(() => databaseTransaction),
  orderBy: vi.fn(() =>
    Promise.resolve([
      {
        credentialId: 'credential-1',
        accountId: 'x-account-1',
        content: { type: 'text', text: 'scheduled text' },
        mediaId: 'media-1',
        mimeType: 'image/png',
      },
    ]),
  ),
};

describe('X media dispatch composition', () => {
  beforeEach(() => vi.clearAllMocks());

  it('binds one credential-scoped client and stages every scheduled job media item', async () => {
    const client = {} as XMediaUploadClient;
    const createClient = vi.fn(() => client);
    vi.mocked(stageXMedia)
      .mockResolvedValueOnce({ mediaId: 'x-media-1', state: 'succeeded' })
      .mockResolvedValueOnce({ mediaId: 'x-media-2', state: 'pending' });

    const result = await stageXJobMedia({} as never, {} as XMediaSource, createClient, {
      workspaceId: 'workspace-1',
      jobId: 'job-1',
      credential: '{"accessToken":"sanitized","accessTokenSecret":"sanitized"}',
      mediaIds: ['media-1', 'media-2'],
      idempotencyKey: 'job-key',
    });

    expect(createClient).toHaveBeenCalledOnce();
    expect(stageXMedia).toHaveBeenNthCalledWith(1, expect.anything(), expect.anything(), client, {
      workspaceId: 'workspace-1',
      jobId: 'job-1',
      mediaId: 'media-1',
      idempotencyKey: 'job-key:media-1',
    });
    expect(stageXMedia).toHaveBeenNthCalledWith(2, expect.anything(), expect.anything(), client, {
      workspaceId: 'workspace-1',
      jobId: 'job-1',
      mediaId: 'media-2',
      idempotencyKey: 'job-key:media-2',
    });
    expect(result).toEqual({ mediaIds: ['x-media-1', 'x-media-2'], state: 'pending' });
  });

  it('claims the real worker path, binds its account credential, and durably stages revision media', async () => {
    vi.mocked(claimDueJobs).mockResolvedValue([
      {
        id: 'job-1',
        workspaceId: 'workspace-1',
        revisionId: 'revision-1',
        providerAccountId: 'account-1',
        state: 'leased',
        attemptNumber: 1,
        leaseOwner: 'worker-1',
        leaseExpiresAt: new Date('2026-09-01T00:01:00Z'),
      },
    ]);
    vi.mocked(getActiveCredential).mockResolvedValue({ id: 'credential-1' } as never);
    vi.mocked(decryptCredential).mockResolvedValue(
      Buffer.from('{"accessToken":"sanitized","accessTokenSecret":"sanitized"}'),
    );
    vi.mocked(stageXMedia).mockResolvedValue({ mediaId: 'x-media-1', state: 'succeeded' });
    const createClient = vi.fn(
      () =>
        ({
          createPost: vi.fn(() => Promise.resolve({ id: 'post-1', username: 'dailyviber' })),
        }) as unknown as XMediaUploadClient,
    );

    await expect(
      dispatchDueXMedia(
        {
          database: {} as never,
          keys: {} as never,
          source: {} as XMediaSource,
          createClient,
          workerId: 'worker-1',
          leaseMs: 30_000,
        },
        new Date('2026-09-01T00:00:00Z'),
      ),
    ).resolves.toBe(1);

    expect(claimDueJobs).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workerId: 'worker-1' }),
    );
    expect(createClient).toHaveBeenCalledWith(
      '{"accessToken":"sanitized","accessTokenSecret":"sanitized"}',
    );
    expect(stageXMedia).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      {
        workspaceId: 'workspace-1',
        jobId: 'job-1',
        mediaId: 'media-1',
        idempotencyKey: 'job-key:media-1',
      },
    );
  });

  it('resumes idempotent staging on a later worker pass after a staging failure', async () => {
    const claimedJob = {
      id: 'job-1',
      workspaceId: 'workspace-1',
      revisionId: 'revision-1',
      providerAccountId: 'account-1',
      state: 'leased' as const,
      attemptNumber: 1,
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date('2026-09-01T00:01:00Z'),
    };
    vi.mocked(claimDueJobs).mockResolvedValue([claimedJob]);
    vi.mocked(getActiveCredential).mockResolvedValue({ id: 'credential-1' } as never);
    vi.mocked(decryptCredential).mockImplementation(() =>
      Promise.resolve(Buffer.from('{"accessToken":"sanitized","accessTokenSecret":"sanitized"}')),
    );
    vi.mocked(stageXMedia)
      .mockRejectedValueOnce(new Error('sanitized staging failure'))
      .mockResolvedValueOnce({ mediaId: 'x-media-1', state: 'pending' });
    const runtime = {
      database: {} as never,
      keys: {} as never,
      source: {} as XMediaSource,
      createClient: vi.fn(
        () =>
          ({
            createPost: vi.fn(() => Promise.resolve({ id: 'post-1', username: 'dailyviber' })),
          }) as unknown as XMediaUploadClient,
      ),
      workerId: 'worker-1',
      leaseMs: 30_000,
    };

    await expect(dispatchDueXMedia(runtime, new Date('2026-09-01T00:00:00Z'))).rejects.toThrow(
      'sanitized staging failure',
    );
    await expect(dispatchDueXMedia(runtime, new Date('2026-09-01T00:02:00Z'))).resolves.toBe(0);

    expect(stageXMedia).toHaveBeenCalledTimes(2);
    expect(startDispatchAttempt).not.toHaveBeenCalled();
    expect(stageXMedia).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      {
        workspaceId: 'workspace-1',
        jobId: 'job-1',
        mediaId: 'media-1',
        idempotencyKey: 'job-key:media-1',
      },
    );
  });

  it('reconciles an expired ambiguous dispatch through provider lookup', async () => {
    vi.mocked(recoverExpiredDispatches).mockResolvedValue(['job-unknown']);
    vi.mocked(claimReconciliationJobs).mockResolvedValue(['job-unknown']);
    vi.mocked(resolveReconciliation).mockResolvedValue(true);
    databaseTransaction.orderBy.mockResolvedValueOnce([
      {
        workspaceId: 'workspace-1',
        credentialId: 'credential-1',
        reconciliationKey: 'x:post-1',
      } as never,
    ]);
    vi.mocked(getActiveCredential).mockResolvedValue({ id: 'credential-1' } as never);
    vi.mocked(decryptCredential).mockResolvedValue(Buffer.from('{}'));
    const getPost = vi.fn(() => Promise.resolve({ id: 'post-1', username: 'dailyviber' }));

    await expect(
      reconcileXJobs(
        {
          database: databaseTransaction as never,
          keys: {} as never,
          source: {} as XMediaSource,
          createClient: vi.fn(() => ({ getPost }) as unknown as XMediaUploadClient),
          workerId: 'worker-1',
          leaseMs: 30_000,
        },
        new Date('2026-09-01T00:02:00Z'),
      ),
    ).resolves.toBe(1);

    expect(recoverExpiredDispatches).toHaveBeenCalled();
    expect(getPost).toHaveBeenCalledWith('post-1');
    expect(resolveReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ jobId: 'job-unknown', outcome: 'published' }),
    );
  });

  it('dispatches a text-only job through the durable attempt boundary', async () => {
    vi.mocked(claimDueJobs).mockResolvedValue([
      {
        id: 'job-text',
        workspaceId: 'workspace-1',
        revisionId: 'revision-1',
        providerAccountId: 'account-1',
        state: 'leased',
        attemptNumber: 1,
        leaseOwner: 'worker-1',
        leaseExpiresAt: new Date('2026-09-01T00:01:00Z'),
      },
    ]);
    databaseTransaction.orderBy.mockResolvedValueOnce([
      {
        credentialId: 'credential-1',
        accountId: 'x-account-1',
        content: { type: 'text', text: 'text only' },
        mediaId: null as never,
        mimeType: null as never,
      },
    ]);
    vi.mocked(getActiveCredential).mockResolvedValue({ id: 'credential-1' } as never);
    vi.mocked(decryptCredential).mockResolvedValue(Buffer.from('{}'));
    const createPost = vi.fn(() => Promise.resolve({ id: 'post-1', username: 'dailyviber' }));

    await expect(
      dispatchDueXMedia({
        database: {} as never,
        keys: {} as never,
        source: {} as XMediaSource,
        createClient: vi.fn(() => ({ createPost }) as unknown as XMediaUploadClient),
        workerId: 'worker-1',
        leaseMs: 30_000,
      }),
    ).resolves.toBe(1);

    expect(startDispatchAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ jobId: 'job-text', workerId: 'worker-1' }),
    );
    expect(createPost).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'text only', mediaIds: [] }),
    );
    expect(finishDispatchAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        jobId: 'job-text',
        outcome: 'published',
        externalPostId: 'post-1',
      }),
    );
  });
});

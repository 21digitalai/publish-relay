import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  XMediaSource,
  XMediaUploadClient,
} from '../src/modules/providers/x-media-staging.service.js';
import {
  dispatchDueXMedia,
  normalizeStoredXContent,
  reconcileXJobs,
  stageXJobMedia,
} from '../src/modules/providers/x-media-dispatch.service.js';

vi.mock('../src/modules/providers/x-media-staging.service.js', () => ({ stageXMedia: vi.fn() }));
vi.mock('../src/modules/scheduler/job.repository.js', () => ({
  claimDueJobs: vi.fn(),
  claimExactDueJob: vi.fn(),
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
import { claimDueJobs, claimExactDueJob } from '../src/modules/scheduler/job.repository.js';
import {
  finishDispatchAttempt,
  claimReconciliationJobs,
  recoverExpiredDispatches,
  resolveReconciliation,
  startDispatchAttempt,
} from '../src/modules/scheduler/job.repository.js';

const databaseTransaction = {
  execute: vi.fn(() => Promise.resolve({ rows: [] })),
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

  it('preserves migrated thread order as one X Premium text payload', () => {
    expect(
      normalizeStoredXContent({ kind: 'thread', posts: ['Opening', 'Middle', 'Closing'] }),
    ).toEqual({ kind: 'text', text: 'Opening\n\nMiddle\n\nClosing' });
    expect(
      normalizeStoredXContent({
        kind: 'thread',
        posts: [
          { text: 'Opening', mediaIds: ['media-1'] },
          { text: 'Closing', mediaIds: [] },
        ],
      }),
    ).toEqual({ kind: 'text', text: 'Opening\n\nClosing' });
  });

  it('rejects malformed migrated thread content instead of publishing media by itself', () => {
    expect(() => normalizeStoredXContent({ kind: 'thread', posts: [] })).toThrow(
      'Stored X thread content is empty',
    );
    expect(() =>
      normalizeStoredXContent({ kind: 'thread', posts: [{ text: 'Opening', mediaIds: [1] }] }),
    ).toThrow('Stored X thread content is invalid');
    expect(() => normalizeStoredXContent({ kind: 'thread', posts: [{ text: 'Opening' }] })).toThrow(
      'Stored X thread content is invalid',
    );
    for (const posts of [
      ['Opening', { text: 'Closing', mediaIds: [] }],
      [{ text: 'Opening', mediaIds: [] }, 'Closing'],
    ]) {
      expect(() => normalizeStoredXContent({ kind: 'thread', posts })).toThrow(
        'Stored X thread content is invalid',
      );
    }
  });

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
          createPost: vi.fn(() => Promise.resolve({ id: 'post-1', username: 'exampleeditorial' })),
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
      expect.objectContaining({ workerId: 'worker-1', destinationProvider: 'x' }),
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
        leaseOwner: 'worker-1',
      },
    );
  });

  it('sends migrated thread root with media and a separate linked reply', async () => {
    vi.mocked(claimDueJobs).mockResolvedValue([
      {
        id: 'job-thread',
        workspaceId: 'workspace-1',
        revisionId: 'revision-thread',
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
        content: {
          kind: 'thread',
          posts: [
            { text: 'Opening', mediaIds: ['media-1'] },
            { text: 'Closing', mediaIds: [] },
          ],
        } as never,
        mediaId: 'media-1',
        mimeType: 'image/png',
      },
    ]);
    vi.mocked(getActiveCredential).mockResolvedValue({ id: 'credential-1' } as never);
    vi.mocked(decryptCredential).mockResolvedValue(Buffer.from('{}'));
    vi.mocked(stageXMedia).mockResolvedValue({ mediaId: 'x-media-1', state: 'succeeded' });
    const createPost = vi
      .fn()
      .mockResolvedValueOnce({ id: 'root-1', username: 'exampleeditorial' })
      .mockResolvedValueOnce({ id: 'reply-1', username: 'exampleeditorial' });

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

    expect(createPost).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: 'Opening', mediaIds: ['x-media-1'] }),
    );
    expect(createPost).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: 'Closing', mediaIds: [], replyToPostId: 'root-1' }),
    );
  });

  it('dispatches an accepted string-only thread as one joined text post', async () => {
    vi.mocked(claimDueJobs).mockResolvedValue([
      {
        id: 'job-string-thread',
        workspaceId: 'workspace-1',
        revisionId: 'revision-string-thread',
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
        content: { kind: 'thread', posts: ['Opening', 'Closing'] } as never,
        mediaId: '',
        mimeType: '',
      },
    ]);
    vi.mocked(getActiveCredential).mockResolvedValue({ id: 'credential-1' } as never);
    vi.mocked(decryptCredential).mockResolvedValue(Buffer.from('{}'));
    const createPost = vi.fn().mockResolvedValue({ id: 'post-1', username: 'exampleeditorial' });

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

    expect(createPost).toHaveBeenCalledOnce();
    expect(createPost).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Opening\n\nClosing' }),
    );
  });

  it('dispatches only the explicitly claimed canary job with exact text and staged media', async () => {
    vi.mocked(claimExactDueJob).mockResolvedValue({
      id: 'canary-job',
      workspaceId: 'workspace-1',
      revisionId: 'revision-1',
      providerAccountId: 'account-1',
      state: 'leased',
      attemptNumber: 1,
      leaseOwner: 'x-example-worker',
      leaseExpiresAt: new Date('2026-09-01T00:01:00Z'),
    });
    databaseTransaction.orderBy.mockResolvedValueOnce([
      {
        credentialId: 'credential-1',
        accountId: 'x-account-1',
        content: { kind: 'text', text: 'Exact Example Editorial source text' } as never,
        mediaId: 'source-media-1',
        mimeType: 'image/png',
      },
    ]);
    vi.mocked(getActiveCredential).mockResolvedValue({ id: 'credential-1' } as never);
    vi.mocked(decryptCredential).mockResolvedValue(Buffer.from('{}'));
    vi.mocked(stageXMedia).mockResolvedValue({ mediaId: 'x-staged-media-1', state: 'succeeded' });
    const createPost = vi.fn(() =>
      Promise.resolve({ id: 'replacement-post', username: 'example_editorial' }),
    );

    await expect(
      dispatchDueXMedia(
        {
          database: {} as never,
          keys: {} as never,
          source: {} as XMediaSource,
          createClient: vi.fn(() => ({ createPost }) as unknown as XMediaUploadClient),
          workerId: 'x-example-worker',
          leaseMs: 30_000,
        },
        new Date('2026-09-01T00:00:00Z'),
        { workspaceId: 'workspace-1', jobId: 'canary-job' },
      ),
    ).resolves.toBe(1);

    expect(claimDueJobs).not.toHaveBeenCalled();
    expect(claimExactDueJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ jobId: 'canary-job' }),
    );
    expect(createPost).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Exact Example Editorial source text',
        mediaIds: ['x-staged-media-1'],
      }),
    );
  });

  it('does not call the provider again when an exact canary dispatch has an uncertain outcome', async () => {
    vi.mocked(claimExactDueJob)
      .mockResolvedValueOnce({
        id: 'canary-job',
        workspaceId: 'workspace-1',
        revisionId: 'revision-1',
        providerAccountId: 'account-1',
        state: 'leased',
        attemptNumber: 1,
        leaseOwner: 'x-example-worker',
        leaseExpiresAt: new Date('2026-09-01T00:01:00Z'),
      })
      .mockResolvedValueOnce(null);
    databaseTransaction.orderBy.mockResolvedValueOnce([
      {
        credentialId: 'credential-1',
        accountId: 'x-account-1',
        content: { kind: 'text', text: 'Exact Example Editorial source text' } as never,
        mediaId: 'source-media-1',
        mimeType: 'image/png',
      },
    ]);
    vi.mocked(getActiveCredential).mockResolvedValue({ id: 'credential-1' } as never);
    vi.mocked(decryptCredential).mockResolvedValue(Buffer.from('{}'));
    vi.mocked(stageXMedia).mockResolvedValue({ mediaId: 'x-staged-media-1', state: 'succeeded' });
    const createPost = vi.fn(() =>
      Promise.reject(Object.assign(new Error('sanitized timeout'), { outcomeUnknown: true })),
    );
    const runtime = {
      database: {} as never,
      keys: {} as never,
      source: {} as XMediaSource,
      createClient: vi.fn(() => ({ createPost }) as unknown as XMediaUploadClient),
      workerId: 'x-example-worker',
      leaseMs: 30_000,
    };
    const exact = { workspaceId: 'workspace-1', jobId: 'canary-job' };

    await expect(dispatchDueXMedia(runtime, new Date('2026-09-01T00:00:00Z'), exact)).resolves.toBe(
      1,
    );
    await expect(dispatchDueXMedia(runtime, new Date('2026-09-01T00:02:00Z'), exact)).resolves.toBe(
      0,
    );

    expect(createPost).toHaveBeenCalledTimes(1);
    expect(finishDispatchAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        jobId: 'canary-job',
        outcome: 'unknown',
        reconciliationKey: 'x:manual:job-key',
      }),
    );
    expect(claimDueJobs).not.toHaveBeenCalled();
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
            createPost: vi.fn(() =>
              Promise.resolve({ id: 'post-1', username: 'exampleeditorial' }),
            ),
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
        leaseOwner: 'worker-1',
      },
    );
  });

  it('preserves the real ambiguous create lineage without treating its job hash as a post id', async () => {
    vi.mocked(claimDueJobs).mockResolvedValue([
      {
        id: 'job-unknown',
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
        content: { type: 'text', text: 'ambiguous post' },
        mediaId: null as never,
        mimeType: null as never,
      },
    ]);
    vi.mocked(getActiveCredential).mockResolvedValue({ id: 'credential-1' } as never);
    vi.mocked(decryptCredential).mockImplementation(() => Promise.resolve(Buffer.from('{}')));
    const ambiguousError = Object.assign(new Error('sanitized timeout'), {
      status: 503,
      outcomeUnknown: true,
    });
    const createPost = vi.fn(() => Promise.reject(ambiguousError));
    const getPost = vi.fn(() => Promise.resolve(null));
    const runtime = {
      database: databaseTransaction as never,
      keys: {} as never,
      source: {} as XMediaSource,
      createClient: vi.fn(() => ({ createPost, getPost }) as unknown as XMediaUploadClient),
      workerId: 'worker-1',
      leaseMs: 30_000,
    };

    await expect(dispatchDueXMedia(runtime, new Date('2026-09-01T00:00:00Z'))).resolves.toBe(1);
    const finishInput = vi.mocked(finishDispatchAttempt).mock.calls[0]?.[1];
    expect(finishInput).toMatchObject({
      jobId: 'job-unknown',
      outcome: 'unknown',
      reconciliationKey: 'x:manual:job-key',
    });

    vi.mocked(recoverExpiredDispatches).mockResolvedValue(['job-unknown']);
    vi.mocked(claimReconciliationJobs).mockResolvedValue(['job-unknown']);
    databaseTransaction.orderBy.mockResolvedValueOnce([
      {
        workspaceId: 'workspace-1',
        credentialId: 'credential-1',
        reconciliationKey: finishInput?.reconciliationKey,
      } as never,
    ]);

    await expect(reconcileXJobs(runtime, new Date('2026-09-01T00:02:00Z'))).resolves.toBe(0);

    expect(recoverExpiredDispatches).toHaveBeenCalled();
    expect(claimReconciliationJobs).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ destinationProvider: 'x' }),
    );
    expect(getPost).not.toHaveBeenCalled();
    expect(resolveReconciliation).not.toHaveBeenCalled();
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
    const createPost = vi.fn(() => Promise.resolve({ id: 'post-1', username: 'exampleeditorial' }));

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

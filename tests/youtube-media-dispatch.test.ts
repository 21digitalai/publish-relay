import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dispatchDueYouTubeJobs,
  reconcileYouTubeJobs,
} from '../src/modules/providers/youtube-media-dispatch.service.js';
import { YouTubeRequestError } from '../src/modules/providers/youtube-http-client.js';

vi.mock('../src/modules/providers/youtube-media-staging.service.js', () => ({
  stageYouTubeMedia: vi.fn(),
}));
vi.mock('../src/modules/providers/youtube-credential.service.js', () => ({
  getFreshYouTubeCredential: vi.fn(),
}));
vi.mock('../src/modules/scheduler/job.repository.js', () => ({
  claimDueJobs: vi.fn(),
  claimReconciliationJobs: vi.fn(() => Promise.resolve([])),
  deriveJobIdempotencyKey: vi.fn(() => 'job-key'),
  startDispatchAttempt: vi.fn(() => Promise.resolve({ attemptId: 'attempt-1' })),
  finishDispatchAttempt: vi.fn(() => Promise.resolve(true)),
  recoverExpiredDispatches: vi.fn(() => Promise.resolve([])),
  resolveReconciliation: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../src/database/tenant-transaction.js', () => ({
  withTenantTransaction: vi.fn(
    (_database: unknown, _input: unknown, work: (transaction: unknown) => unknown) =>
      work(databaseQuery),
  ),
}));

import { getFreshYouTubeCredential } from '../src/modules/providers/youtube-credential.service.js';
import { stageYouTubeMedia } from '../src/modules/providers/youtube-media-staging.service.js';
import {
  claimDueJobs,
  claimReconciliationJobs,
  finishDispatchAttempt,
  resolveReconciliation,
} from '../src/modules/scheduler/job.repository.js';

const context = {
  credentialId: 'credential-1',
  mediaId: 'media-1',
  mimeType: 'video/mp4',
  settings: {
    schemaVersion: 1,
    title: 'Clip',
    description: 'Description',
    privacyStatus: 'public',
    madeForKids: false,
    notifySubscribers: true,
  },
};
const databaseQuery = {
  select: vi.fn(() => databaseQuery),
  from: vi.fn(() => databaseQuery),
  innerJoin: vi.fn(() => databaseQuery),
  where: vi.fn(() => databaseQuery),
  limit: vi.fn(() => Promise.resolve([context])),
};
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
const runtime = {
  database: databaseQuery as never,
  keys: {} as never,
  source: {} as never,
  client: {} as never,
  workerId: 'worker-1',
  leaseMs: 30_000,
};

describe('YouTube media dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseQuery.limit.mockResolvedValue([context]);
    vi.mocked(getFreshYouTubeCredential).mockResolvedValue({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: '2026-09-02T00:00:00.000Z',
    });
  });

  it('claims only YouTube video jobs and records the staged video as published', async () => {
    vi.mocked(claimDueJobs).mockResolvedValue([claimedJob]);
    vi.mocked(stageYouTubeMedia).mockResolvedValue({ videoId: 'video-1' });

    await expect(dispatchDueYouTubeJobs(runtime, new Date('2026-09-01T00:00:00Z'))).resolves.toBe(1);

    expect(claimDueJobs).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: 'youtube', requireMedia: true }),
    );
    expect(stageYouTubeMedia).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        mediaId: 'media-1',
        notifySubscribers: true,
        metadata: {
          snippet: { title: 'Clip', description: 'Description' },
          status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
        },
      }),
    );
    expect(finishDispatchAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'published', externalPostId: 'video-1' }),
    );
  });

  it('marks an ambiguous upload outcome for reconciliation instead of blind retry', async () => {
    vi.mocked(claimDueJobs).mockResolvedValue([claimedJob]);
    vi.mocked(stageYouTubeMedia).mockRejectedValue(
      new YouTubeRequestError(0, 'transient', 'unknown upload outcome', { outcomeUnknown: true }),
    );

    await expect(dispatchDueYouTubeJobs(runtime, new Date('2026-09-01T00:00:00Z'))).resolves.toBe(0);
    expect(finishDispatchAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'unknown', reconciliationKey: 'youtube:job-1' }),
    );
  });

  it('claims only YouTube reconciliation and resolves after authoritative staged resume', async () => {
    vi.mocked(claimReconciliationJobs).mockResolvedValue(['job-1']);
    databaseQuery.limit
      .mockResolvedValueOnce([claimedJob] as never)
      .mockResolvedValueOnce([context]);
    vi.mocked(stageYouTubeMedia).mockResolvedValue({ videoId: 'video-1' });

    await expect(reconcileYouTubeJobs(runtime, new Date('2026-09-01T00:02:00Z'))).resolves.toBe(1);
    expect(claimReconciliationJobs).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: 'youtube' }),
    );
    expect(resolveReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ jobId: 'job-1', outcome: 'published' }),
    );
  });
});

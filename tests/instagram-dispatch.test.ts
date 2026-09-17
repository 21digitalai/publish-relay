import { beforeEach, describe, expect, it, vi } from 'vitest';

const stage = vi.fn();
const publish = vi.fn();

vi.mock('../src/modules/providers/instagram-adapter.js', () => ({
  InstagramPublishingAdapter: class {
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

import { reconcileInstagramJobs } from '../src/modules/providers/instagram-dispatch.service.js';
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
    content: { text: 'Caption' },
    mediaId: 'media-1',
    mimeType: 'image/jpeg',
  },
];
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
  tokenCodec: { issue: vi.fn(() => 'opaque') } as never,
  publicOrigin: 'https://relay.example',
  workerId: 'worker-1',
  leaseMs: 30_000,
};

describe('Instagram reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});

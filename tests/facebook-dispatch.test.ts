import { beforeEach, describe, expect, it, vi } from 'vitest';

const stage = vi.fn();
const publish = vi.fn();

vi.mock('../src/modules/providers/facebook-adapter.js', () => ({
  FacebookPublishingAdapter: class {
    public stage = stage;
    public publish = publish;
  },
}));
vi.mock('../src/modules/providers/facebook-artifact-store.js', () => ({
  PostgresFacebookArtifactStore: class {
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
  claimDueJobs: vi.fn(() => Promise.resolve([])),
  claimReconciliationJobs: vi.fn(() => Promise.resolve([])),
  deriveJobIdempotencyKey: vi.fn((input: { jobId: string }) => `key-${input.jobId}`),
  finishDispatchAttempt: vi.fn(() => Promise.resolve(true)),
  recoverExpiredDispatches: vi.fn(() => Promise.resolve([])),
  resolveReconciliation: vi.fn(() => Promise.resolve(true)),
  startDispatchAttempt: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../src/database/tenant-transaction.js', () => ({
  withTenantTransaction: vi.fn(
    (_database: unknown, _input: unknown, work: (transaction: unknown) => unknown) =>
      work(databaseQuery),
  ),
}));

import {
  dispatchDueFacebookJobs,
  reconcileFacebookJobs,
} from '../src/modules/providers/facebook-dispatch.service.js';
import {
  claimDueJobs,
  claimReconciliationJobs,
  finishDispatchAttempt,
  resolveReconciliation,
  startDispatchAttempt,
} from '../src/modules/scheduler/job.repository.js';

function job(id: string, providerAccountId = `account-${id}`) {
  return {
    id,
    workspaceId: 'workspace-1',
    revisionId: `revision-${id}`,
    providerAccountId,
  };
}

function context(availability = 'active') {
  return {
    accountRemoteId: 'page-1',
    availability,
    credentialId: 'credential-1',
    effectivePayload: {
      kind: 'link',
      message: 'Message',
      linkUrl: 'https://example.com/story',
    },
  };
}

const databaseQuery = {
  select: vi.fn(() => databaseQuery),
  from: vi.fn(() => databaseQuery),
  innerJoin: vi.fn(() => databaseQuery),
  where: vi.fn(() => databaseQuery),
  orderBy: vi.fn(() => Promise.resolve([])),
  limit: vi.fn<() => Promise<unknown[]>>(),
  update: vi.fn(() => databaseQuery),
  set: vi.fn(() => databaseQuery),
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
const now = new Date('2026-09-17T18:00:00Z');

describe('Facebook dispatch and reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stage.mockImplementation((_accountId, _content, key: string) =>
      Promise.resolve({ stageId: `facebook_page:${key}` }),
    );
  });

  it('resolves only durable provider results and leaves request-started work held', async () => {
    const publishedJob = job('published');
    const ambiguousJob = job('ambiguous');
    vi.mocked(claimReconciliationJobs).mockResolvedValue([publishedJob.id, ambiguousJob.id]);
    databaseQuery.limit
      .mockResolvedValueOnce([publishedJob])
      .mockResolvedValueOnce([context()])
      .mockResolvedValueOnce([ambiguousJob])
      .mockResolvedValueOnce([context()]);
    publish
      .mockResolvedValueOnce({ status: 'published', externalPostId: 'page_post_1' })
      .mockResolvedValueOnce({
        status: 'unknown',
        reconciliationKey: 'facebook_page:key-ambiguous:create',
      });

    await expect(reconcileFacebookJobs(runtime, now)).resolves.toBe(1);
    expect(claimReconciliationJobs).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ destinationProvider: 'facebook_page' }),
    );
    expect(resolveReconciliation).toHaveBeenCalledTimes(1);
    expect(resolveReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        jobId: publishedJob.id,
        outcome: 'published',
        externalPostId: 'page_post_1',
      }),
    );
  });

  it('marks permission loss unavailable, fails the job, and continues its sibling', async () => {
    const denied = job('denied');
    const sibling = job('sibling');
    vi.mocked(claimDueJobs).mockResolvedValue([denied, sibling] as never);
    vi.mocked(startDispatchAttempt)
      .mockResolvedValueOnce({ attemptId: 'attempt-denied' } as never)
      .mockResolvedValueOnce({ attemptId: 'attempt-sibling' } as never);
    databaseQuery.limit.mockResolvedValueOnce([context()]).mockResolvedValueOnce([context()]);
    publish
      .mockResolvedValueOnce({
        status: 'failed',
        code: 'auth',
        message: 'Facebook request failed (permission, HTTP 403)',
      })
      .mockResolvedValueOnce({ status: 'published', externalPostId: 'page_post_2' });

    await expect(dispatchDueFacebookJobs(runtime, now)).resolves.toBe(1);
    expect(databaseQuery.update).toHaveBeenCalledTimes(1);
    expect(finishDispatchAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ jobId: denied.id, outcome: 'auth' }),
    );
    expect(finishDispatchAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ jobId: sibling.id, outcome: 'published' }),
    );
  });

  it('fails an unavailable scheduled destination closed without aborting a sibling', async () => {
    const unavailable = job('unavailable');
    const sibling = job('sibling');
    vi.mocked(claimDueJobs).mockResolvedValue([unavailable, sibling] as never);
    vi.mocked(startDispatchAttempt)
      .mockResolvedValueOnce({ attemptId: 'attempt-unavailable' } as never)
      .mockResolvedValueOnce({ attemptId: 'attempt-sibling' } as never);
    databaseQuery.limit
      .mockResolvedValueOnce([context('permission_lost')])
      .mockResolvedValueOnce([context()]);
    publish.mockResolvedValueOnce({ status: 'published', externalPostId: 'page_post_3' });

    await expect(dispatchDueFacebookJobs(runtime, now)).resolves.toBe(1);
    expect(finishDispatchAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        jobId: unavailable.id,
        outcome: 'permanent',
        redactedError: 'Facebook Page destination is unavailable',
      }),
    );
    expect(publish).toHaveBeenCalledTimes(1);
    expect(finishDispatchAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ jobId: sibling.id, outcome: 'published' }),
    );
  });
});

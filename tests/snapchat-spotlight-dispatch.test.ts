import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/modules/providers/snapchat-credential.service.js', () => ({
  getFreshSnapchatToken: vi.fn(),
}));
vi.mock('../src/modules/providers/snapchat-spotlight-upload.js', () => ({
  stageAndPostSnapchatSpotlight: vi.fn(),
}));
vi.mock('../src/modules/scheduler/job.repository.js', () => ({
  claimDueJobs: vi.fn(),
  claimReconciliationJobs: vi.fn(),
  deriveJobIdempotencyKey: vi.fn(() => 'job-key'),
  startDispatchAttempt: vi.fn(() => Promise.resolve({ attemptId: 'attempt-1' })),
  finishDispatchAttempt: vi.fn(() => Promise.resolve(true)),
  recoverExpiredDispatches: vi.fn(() => Promise.resolve([])),
  resolveReconciliation: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../src/database/tenant-transaction.js', () => ({
  withTenantTransaction: vi.fn((_db, _input, callback: (tx: unknown) => unknown) => callback(db)),
}));

import { getFreshSnapchatToken } from '../src/modules/providers/snapchat-credential.service.js';
import {
  dispatchDueSnapchatSpotlights,
  reconcileSnapchatSpotlights,
} from '../src/modules/providers/snapchat-spotlight-dispatch.service.js';
import { stageAndPostSnapchatSpotlight } from '../src/modules/providers/snapchat-spotlight-upload.js';
import {
  claimDueJobs,
  claimReconciliationJobs,
  finishDispatchAttempt,
  resolveReconciliation,
} from '../src/modules/scheduler/job.repository.js';

const profileId = '00000000-0000-4000-8000-000000000101';
const mediaId = '00000000-0000-4000-8000-000000000102';
const job = {
  id: 'job-1',
  workspaceId: 'workspace-1',
  revisionId: 'revision-1',
  providerAccountId: 'account-1',
};
const context = {
  accountId: job.providerAccountId,
  profileId,
  connectionProfileId: profileId,
  mediaId,
  mimeType: 'video/mp4',
  byteSize: 10,
  durationMs: 6_000,
  width: 540,
  height: 960,
  storageKey: 'fixture',
  sha256: 'a'.repeat(64),
  content: { schemaVersion: 1, kind: 'spotlight_video', mediaId, locale: 'en_US' },
};
const db = {
  select: vi.fn(() => db),
  from: vi.fn(() => db),
  innerJoin: vi.fn(() => db),
  where: vi.fn(() => db),
  limit: vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([context])),
  insert: vi.fn(() => db),
  values: vi.fn(() => db),
  onConflictDoNothing: vi.fn(() => db),
  returning: vi.fn(() => Promise.resolve([{ id: 'artifact-1' }])),
  update: vi.fn(() => db),
  set: vi.fn(() => db),
};
const lookup = vi.fn(() => Promise.resolve('SUBMITTED' as 'SUBMITTED' | 'LIVE' | 'REJECTED'));
const runtime = {
  database: db as never,
  keys: {} as never,
  oauthClient: {} as never,
  client: { lookup } as never,
  mediaStorage: { openVerifiedRange: vi.fn() } as never,
  workerId: 'worker-1',
  leaseMs: 30_000,
};
const now = new Date('2026-10-19T20:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  db.limit.mockResolvedValue([context]);
  db.returning.mockResolvedValue([{ id: 'artifact-1' }]);
  vi.mocked(getFreshSnapchatToken).mockResolvedValue({
    access_token: 'token',
    refresh_token: 'refresh',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'snapchat-profile-api',
  });
  vi.mocked(claimDueJobs).mockResolvedValue([job as never]);
  vi.mocked(claimReconciliationJobs).mockResolvedValue([]);
});

it('keeps a provider-accepted Spotlight pending; never calls it published at SUBMITTED', async () => {
  vi.mocked(stageAndPostSnapchatSpotlight).mockResolvedValue({
    spotlightId: 'spotlight-one',
    mediaId: 'remote-media',
  });
  expect(await dispatchDueSnapchatSpotlights(runtime, now)).toBe(1);
  expect(claimDueJobs).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ destinationProvider: 'snapchat', requireMedia: true }),
  );
  expect(finishDispatchAttempt).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ outcome: 'accepted_pending', externalPostId: 'spotlight-one' }),
  );
});

it('preserves an ambiguous post outcome without a blind second POST', async () => {
  vi.mocked(stageAndPostSnapchatSpotlight).mockImplementation(async (input) => {
    await input.onBeforeSpotlightPost?.();
    throw new Error('network response lost');
  });
  expect(await dispatchDueSnapchatSpotlights(runtime, now)).toBe(0);
  expect(stageAndPostSnapchatSpotlight).toHaveBeenCalledTimes(1);
  expect(finishDispatchAttempt).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ outcome: 'unknown', reconciliationKey: 'snapchat:job-1' }),
  );
});

it('reconciles SUBMITTED, LIVE and REJECTED distinctly using the stored Spotlight ID', async () => {
  vi.mocked(claimReconciliationJobs).mockResolvedValue(['job-1']);
  db.limit.mockResolvedValueOnce([{ workspaceId: job.workspaceId, spotlightId: 'spotlight-one' }]);
  db.limit.mockResolvedValueOnce([context]);
  expect(await reconcileSnapchatSpotlights(runtime, now)).toBe(1);
  expect(resolveReconciliation).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ outcome: 'accepted_pending' }),
  );
  for (const [status, outcome] of [
    ['LIVE', 'published'],
    ['REJECTED', 'failed'],
  ] as const) {
    db.limit.mockResolvedValueOnce([
      { workspaceId: job.workspaceId, spotlightId: 'spotlight-one' },
    ]);
    db.limit.mockResolvedValueOnce([context]);
    lookup.mockResolvedValueOnce(status);
    expect(await reconcileSnapchatSpotlights(runtime, now)).toBe(1);
    expect(resolveReconciliation).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome }),
    );
  }
});

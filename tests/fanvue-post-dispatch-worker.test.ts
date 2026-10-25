import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/modules/scheduler/job.repository.js', () => ({
  claimDueJobs: vi.fn(),
  deferLeasedJob: vi.fn(() => Promise.resolve(true)),
  deriveJobIdempotencyKey: vi.fn(() => 'fingerprint'),
  finishDispatchAttempt: vi.fn(() => Promise.resolve(true)),
  recoverExpiredDispatches: vi.fn(() => Promise.resolve([])),
  startDispatchAttempt: vi.fn(() =>
    Promise.resolve({ attemptId: 'attempt-1', attemptNumber: 1, idempotencyKey: 'fingerprint' }),
  ),
}));
vi.mock('../src/modules/providers/fanvue-dispatch-context.repository.js', () => ({
  loadFanvueDispatchContext: vi.fn(),
  assertFanvueDispatchPreflight: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/modules/providers/fanvue-credential.service.js', () => ({
  getFreshFanvueToken: vi.fn(() => Promise.resolve({ access_token: 'test-token' })),
}));
vi.mock('../src/modules/providers/fanvue-artifact.repository.js', () => ({
  getFinalizedFanvueMediaUuids: vi.fn(() => Promise.resolve(new Map())),
}));
vi.mock('../src/modules/providers/fanvue-stage-job-media.service.js', () => ({
  FanvueStagingPendingError: class extends Error {},
  stageFanvueJobMedia: vi.fn(() => Promise.resolve('ready')),
}));

import {
  claimDueJobs,
  deferLeasedJob,
  finishDispatchAttempt,
  startDispatchAttempt,
} from '../src/modules/scheduler/job.repository.js';
import { getFinalizedFanvueMediaUuids } from '../src/modules/providers/fanvue-artifact.repository.js';
import { loadFanvueDispatchContext } from '../src/modules/providers/fanvue-dispatch-context.repository.js';
import { FanvueRequestError } from '../src/modules/providers/fanvue-http-client.js';
import { dispatchDueFanvueJobs } from '../src/modules/providers/fanvue-post-dispatch.service.js';
import { FanvuePostOutcomeUnknownError } from '../src/modules/providers/fanvue-post-client.js';
import { stageFanvueJobMedia } from '../src/modules/providers/fanvue-stage-job-media.service.js';

const mediaId = '00000000-0000-4000-8000-000000000001';
const providerMediaId = '00000000-0000-4000-8000-000000000002';
const job = {
  id: 'job-1',
  workspaceId: 'workspace-1',
  revisionId: 'revision-1',
  providerAccountId: 'account-1',
  attemptNumber: 1,
};
const createPost = vi.fn();
const runtime = {
  database: {} as never,
  keys: {} as never,
  storage: {} as never,
  oauthClient: {} as never,
  mediaClient: {} as never,
  postClient: { createPost } as never,
  workerId: 'worker-1',
  leaseMs: 30_000,
};
const now = new Date('2026-10-25T10:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(claimDueJobs).mockResolvedValue([job] as never);
  vi.mocked(loadFanvueDispatchContext).mockResolvedValue({
    creatorId: 'creator-1',
    content: {
      schemaVersion: 1,
      kind: 'post',
      audience: 'subscribers',
      text: 'Hello',
      mediaIds: [],
    },
  });
  createPost.mockResolvedValue({ uuid: 'post-1' });
});

it('reserves attempt before one free post and persists the provider ID', async () => {
  await expect(dispatchDueFanvueJobs(runtime, now)).resolves.toBe(1);
  expect(vi.mocked(startDispatchAttempt).mock.invocationCallOrder[0]).toBeLessThan(
    createPost.mock.invocationCallOrder[0] ?? 0,
  );
  expect(createPost).toHaveBeenCalledWith('test-token', { audience: 'subscribers', text: 'Hello' });
  expect(finishDispatchAttempt).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ outcome: 'published', externalPostId: 'post-1' }),
  );
});

it('stages exact media before reserving a paid post', async () => {
  vi.mocked(loadFanvueDispatchContext).mockResolvedValue({
    creatorId: 'creator-1',
    content: {
      schemaVersion: 1,
      kind: 'post',
      audience: 'subscribers',
      mediaIds: [mediaId],
      price: 300,
    },
  });
  vi.mocked(getFinalizedFanvueMediaUuids).mockResolvedValue(new Map([[mediaId, providerMediaId]]));
  await expect(dispatchDueFanvueJobs(runtime, now)).resolves.toBe(1);
  expect(vi.mocked(stageFanvueJobMedia).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(startDispatchAttempt).mock.invocationCallOrder[0] ?? 0,
  );
  expect(createPost).toHaveBeenCalledWith('test-token', {
    audience: 'subscribers',
    mediaUuids: [providerMediaId],
    price: 300,
  });
});

it('defers processing media without reserving a post attempt', async () => {
  vi.mocked(loadFanvueDispatchContext).mockResolvedValue({
    creatorId: 'creator-1',
    content: { schemaVersion: 1, kind: 'post', audience: 'subscribers', mediaIds: [mediaId] },
  });
  vi.mocked(stageFanvueJobMedia).mockResolvedValue('processing');
  await expect(dispatchDueFanvueJobs(runtime, now)).resolves.toBe(0);
  expect(deferLeasedJob).toHaveBeenCalledOnce();
  expect(startDispatchAttempt).not.toHaveBeenCalled();
  expect(createPost).not.toHaveBeenCalled();
});

it('holds ambiguous POST as unknown and does not resend', async () => {
  createPost.mockRejectedValue(new FanvuePostOutcomeUnknownError());
  await expect(dispatchDueFanvueJobs(runtime, now)).resolves.toBe(0);
  expect(createPost).toHaveBeenCalledOnce();
  expect(finishDispatchAttempt).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ outcome: 'unknown', reconciliationKey: 'fanvue:job-1' }),
  );
});

it('records a definite 403 rejection without reconciliation', async () => {
  createPost.mockRejectedValue(new FanvueRequestError(403));
  await expect(dispatchDueFanvueJobs(runtime, now)).resolves.toBe(0);
  expect(finishDispatchAttempt).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ outcome: 'auth' }),
  );
});

it('records a definite 400 validation rejection', async () => {
  createPost.mockRejectedValue(new FanvueRequestError(400));
  await expect(dispatchDueFanvueJobs(runtime, now)).resolves.toBe(0);
  expect(finishDispatchAttempt).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ outcome: 'validation' }),
  );
});

it('retries only a definite 429 with a bounded retry timestamp', async () => {
  createPost.mockRejectedValue(new FanvueRequestError(429));
  await expect(dispatchDueFanvueJobs(runtime, now)).resolves.toBe(0);
  const result = vi.mocked(finishDispatchAttempt).mock.calls[0]?.[1];
  expect(result?.outcome).toBe('rate_limit');
  expect(result?.retryAt).toBeInstanceOf(Date);
});

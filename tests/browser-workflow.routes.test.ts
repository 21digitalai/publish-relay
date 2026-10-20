import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthService } from '../src/modules/identity/auth.service.js';
import { WorkspaceAuthorizationError } from '../src/modules/identity/authorization.js';
import { PostValidationError } from '../src/modules/content/post.errors.js';

const authorizeRequest = vi.fn();
const listBrowserJobSummaries = vi.fn();
const listExposedPageCalendarJobs = vi.fn();
const listFacebookPageOccupancy = vi.fn();
const getExposedPageCalendarJob = vi.fn();
const getExposedPageCalendarMedia = vi.fn();
const getBrowserJobDetail = vi.fn();
const cancelPendingJob = vi.fn();
const requestOperatorRetry = vi.fn();
const verifyCsrfToken = vi.fn(() => true);
const executeBrowserMutation = vi.fn();
const storeStagedMediaInTransaction = vi.fn();
const storeMediaInTransaction = vi.fn();
const deleteUnattachedMedia = vi.fn();
const getExternalDraftForWorkspace = vi.fn();
const transitionExternalDraft = vi.fn();
const createPostInTransaction = vi.fn();

vi.mock('../src/modules/identity/auth.routes.js', () => ({
  authorizeRequest,
  CSRF_COOKIE: 'publish_relay_csrf',
}));
vi.mock('../src/modules/identity/session.js', () => ({ verifyCsrfToken }));
vi.mock('../src/modules/content/browser-idempotency.repository.js', () => ({
  executeBrowserMutation,
}));
vi.mock('../src/modules/content/media.service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  storeStagedMediaInTransaction,
  storeMediaInTransaction,
}));
vi.mock('../src/modules/content/media-retention.service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  deleteUnattachedMedia,
}));
vi.mock('../src/modules/content/external-draft.repository.js', () => ({
  getExternalDraftForWorkspace,
  transitionExternalDraft,
}));
vi.mock('../src/modules/content/post.service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createPostInTransaction,
}));
vi.mock('../src/modules/scheduler/job.repository.js', () => ({
  cancelPendingJob,
  requestOperatorRetry,
}));
vi.mock('../src/modules/content/post-read.repository.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listBrowserJobSummaries,
  getBrowserJobDetail,
}));
vi.mock('../src/modules/content/calendar-mirror.repository.js', () => ({
  listExposedPageCalendarJobs,
  getExposedPageCalendarJob,
  getExposedPageCalendarMedia,
}));
vi.mock('../src/modules/content/page-occupancy.repository.js', () => ({
  listFacebookPageOccupancy,
}));

const { registerBrowserWorkflowRoutes } =
  await import('../src/modules/content/browser-workflow.routes.js');

const workspaceId = '00000000-0000-4000-8000-000000000801';
const jobId = '00000000-0000-4000-8000-000000000802';
const postId = '00000000-0000-4000-8000-000000000803';

function job() {
  return {
    id: jobId,
    postId,
    state: 'scheduled',
    needsAttention: false,
    scheduledAt: new Date('2026-09-02T10:00:00.000Z'),
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    updatedAt: new Date('2026-09-01T11:00:00.000Z'),
    content: { type: 'text', text: 'Hello' },
    mediaCount: 2,
    previewMediaId: '00000000-0000-4000-8000-000000000805',
    creator: { type: 'api_key', id: 'key-1', label: 'Editorial agent' },
    lastMutator: { type: 'user', id: 'user-1', label: 'Avery' },
    providerAccount: {
      id: '00000000-0000-4000-8000-000000000804',
      displayName: 'Example Editorial',
      handle: 'example_editorial',
      provider: 'x',
    },
    credentialId: 'must-never-leak',
    workspaceId: 'must-never-leak',
  };
}

describe('browser workflow read contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyCsrfToken.mockReturnValue(true);
    authorizeRequest.mockResolvedValue({ workspaceId, userId: 'user', role: 'owner' });
  });

  it('bounds mirrored Page calendar reads and keeps them off the local job list', async () => {
    const scheduledAt = new Date('2026-10-25T01:30:00.000Z');
    listExposedPageCalendarJobs.mockResolvedValue([
      {
        id: jobId,
        providerAccountId: '00000000-0000-4000-8000-000000000804',
        providerAccountName: 'Shared Page',
        originWorkspaceName: 'Origin',
        state: 'scheduled',
        scheduledAt,
        contentPreview: 'Preview',
        mediaCount: 1,
      },
      { id: postId, scheduledAt: new Date('2026-10-25T02:30:00.000Z') },
    ]);
    const application = Fastify();
    registerBrowserWorkflowRoutes(application, { auth: {} as AuthService, database: {} as never });
    const response = await application.inject({
      method: 'GET',
      url: '/api/workflow/calendar/exposed-pages?startsAt=2026-10-25T00%3A00%3A00Z&endsAt=2026-10-26T00%3A00%3A00Z&limit=1',
    });
    expect(response.statusCode).toBe(200);
    expect(listExposedPageCalendarJobs).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceId, userId: 'user', limit: 2 }),
    );
    expect(response.json()).toMatchObject({
      data: {
        items: [{ id: jobId, originWorkspaceName: 'Origin', providerAccountName: 'Shared Page' }],
        next: { afterScheduledAt: scheduledAt.toISOString(), afterId: jobId },
      },
    });
    expect(response.body).not.toContain('credentialId');
    expect(Buffer.byteLength(response.body)).toBeLessThan(1000);
    const invalid = await application.inject({
      method: 'GET',
      url: '/api/workflow/calendar/exposed-pages?startsAt=2026-10-01T00%3A00%3A00Z&endsAt=2026-12-01T00%3A00%3A00Z',
    });
    expect(invalid.statusCode).toBe(400);
    await application.close();
  });

  it('returns only bounded Page-wide occupancy counts and instants', async () => {
    const scheduledAt = new Date('2026-10-25T01:30:00.000Z');
    listFacebookPageOccupancy.mockResolvedValue([
      { scheduledAt, jobCount: 2 },
      { scheduledAt: new Date('2026-10-25T00:30:00.000Z'), jobCount: 1 },
    ]);
    const app = Fastify();
    registerBrowserWorkflowRoutes(app, { auth: {} as AuthService, database: {} as never });
    const path = `/api/workflow/accounts/${job().providerAccount.id}/occupancy`;
    const response = await app.inject({
      method: 'GET',
      url: `${path}?startsAt=2026-10-25T00%3A00%3A00Z&endsAt=2026-10-26T00%3A00%3A00Z&limit=1`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        items: [{ scheduledAt: scheduledAt.toISOString(), jobCount: 2 }],
        next: { beforeScheduledAt: scheduledAt.toISOString() },
      },
      error: null,
    });
    expect(response.body).not.toMatch(/workspaceId|jobId|content|credential/);
    expect(Buffer.byteLength(response.body)).toBeLessThan(300);
    expect(listFacebookPageOccupancy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceId, userId: 'user', limit: 2 }),
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${path}?startsAt=2026-10-25T00%3A00%3A00Z&endsAt=2026-11-02T00%3A00%3A00Z`,
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it('uses a separate read-only target detail contract for mirrored Page jobs', async () => {
    getExposedPageCalendarJob.mockResolvedValue({
      id: jobId,
      caption: 'Shared caption',
      originWorkspaceName: 'Origin',
      media: [{ id: postId, mimeType: 'image/jpeg', byteSize: 10, position: 0, ready: true }],
    });
    const app = Fastify();
    registerBrowserWorkflowRoutes(app, { auth: {} as AuthService, database: {} as never });
    const path = `/api/workflow/calendar/exposed-pages/${jobId}`;
    const response = await app.inject({ method: 'GET', url: path });
    expect(response.statusCode).toBe(200);
    expect(getExposedPageCalendarJob).toHaveBeenCalledWith(expect.anything(), {
      workspaceId,
      userId: 'user',
      jobId,
    });
    expect(response.json()).toMatchObject({
      data: {
        caption: 'Shared caption',
        originWorkspaceName: 'Origin',
      },
    });
    expect(response.body).not.toMatch(/credential|storageKey|remoteAccount/);
    getExposedPageCalendarJob.mockResolvedValueOnce(null);
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    await app.close();
  });

  it('streams only exact-job authorized mirrored media without exposing storage paths', async () => {
    getExposedPageCalendarMedia.mockResolvedValue({
      storageKey: 'origin/private.jpg',
      mimeType: 'image/jpeg',
      byteSize: 10,
    });
    const read = vi.fn().mockResolvedValue(Buffer.alloc(10));
    const app = Fastify();
    registerBrowserWorkflowRoutes(app, {
      auth: {} as AuthService,
      database: {} as never,
      mediaStorage: { read } as never,
    });
    const path = `/api/workflow/calendar/exposed-pages/${jobId}/media/${postId}`;
    const response = await app.inject({ method: 'GET', url: path });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toContain('image/jpeg');
    expect(read).toHaveBeenCalledWith('origin/private.jpg');
    expect(getExposedPageCalendarMedia).toHaveBeenCalledWith(expect.anything(), {
      workspaceId,
      userId: 'user',
      jobId,
      mediaId: postId,
    });
    getExposedPageCalendarMedia.mockResolvedValueOnce(null);
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    await app.close();
  });

  it('uses live session tenancy and returns an allowlisted paginated summary', async () => {
    listBrowserJobSummaries.mockResolvedValue([job(), { ...job(), id: postId }]);
    const application = Fastify();
    registerBrowserWorkflowRoutes(application, {
      auth: {} as AuthService,
      database: {} as never,
    });
    const response = await application.inject({
      method: 'GET',
      url: '/api/workflow/jobs?limit=1&states=scheduled',
    });

    expect(response.statusCode).toBe(200);
    expect(listBrowserJobSummaries).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceId, limit: 2, states: ['scheduled'] }),
    );
    expect(response.body).not.toContain('must-never-leak');
    expect(Buffer.byteLength(response.body)).toBeLessThan(4_000);
    expect(response.json()).toMatchObject({
      data: {
        items: [
          {
            id: jobId,
            contentPreview: 'Hello',
            media: {
              count: 2,
              previewUrl: '/api/workflow/media/00000000-0000-4000-8000-000000000805',
            },
            creator: { type: 'api_key', label: 'Editorial agent' },
            providerAccount: { displayName: 'Example Editorial' },
          },
        ],
        next: { beforeId: jobId },
      },
      error: null,
    });
    await application.close();
  });

  it('projects only the Story attention flag in lists and request correlation in detail', async () => {
    const story = { ...job(), state: 'dispatching', needsAttention: true };
    listBrowserJobSummaries.mockResolvedValue([story]);
    getBrowserJobDetail.mockResolvedValue({
      ...story,
      attempts: [{ providerRequestId: 'snap-request-1', outcome: 'unknown' }],
    });
    const application = Fastify();
    registerBrowserWorkflowRoutes(application, { auth: {} as AuthService, database: {} as never });
    const list = await application.inject({ method: 'GET', url: '/api/workflow/jobs' });
    const detail = await application.inject({ method: 'GET', url: `/api/workflow/jobs/${jobId}` });
    expect(list.json()).toMatchObject({ data: { items: [{ needsAttention: true }] } });
    expect(list.body).not.toContain('snap-request-1');
    expect(detail.json()).toMatchObject({
      data: {
        needsAttention: true,
        attempts: [{ providerRequestId: 'snap-request-1', outcome: 'unknown' }],
      },
    });
    expect(detail.body).not.toContain('must-never-leak');
    await application.close();
  });

  it('hydrates an imported draft through the authenticated workspace only', async () => {
    const draftId = '00000000-0000-4000-8000-000000000820';
    getExternalDraftForWorkspace.mockResolvedValue({
      id: draftId,
      label: 'Approved clip',
      mediaIds: ['00000000-0000-4000-8000-000000000821'],
      media: [
        {
          id: '00000000-0000-4000-8000-000000000821',
          mimeType: 'video/mp4',
          byteSize: 1048576,
          durationMs: 12000,
          state: 'ready',
          storageKey: 'must-not-leak',
        },
      ],
      postId: null,
      sourceActorId: 'must-not-leak',
    });
    const application = Fastify();
    registerBrowserWorkflowRoutes(application, {
      auth: {} as AuthService,
      database: {} as never,
    });
    const response = await application.inject({
      method: 'GET',
      url: `/api/workflow/drafts/${draftId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(getExternalDraftForWorkspace).toHaveBeenCalledWith(expect.anything(), {
      workspaceId,
      draftId,
    });
    expect(response.json()).toEqual({
      data: {
        id: draftId,
        label: 'Approved clip',
        mediaIds: ['00000000-0000-4000-8000-000000000821'],
        media: [
          {
            id: '00000000-0000-4000-8000-000000000821',
            mimeType: 'video/mp4',
            byteSize: 1048576,
            durationMs: 12000,
            ready: true,
            previewUrl: '/api/workflow/media/00000000-0000-4000-8000-000000000821',
          },
        ],
        postId: null,
      },
      error: null,
    });
    expect(response.body).not.toContain('must-not-leak');
    await application.close();
  });

  it('maps browser post authorization, validation, and unexpected failures to safe envelopes', async () => {
    const payload = {
      content: { type: 'text', text: 'Safe browser post' },
      providerAccountIds: ['00000000-0000-4000-8000-000000000804'],
      scheduledAt: '2030-09-02T10:00:00.000Z',
    };
    const headers = {
      'idempotency-key': 'safe-create',
      'x-csrf-token': 'csrf',
      cookie: 'publish_relay_csrf=csrf',
    };
    const application = Fastify();
    registerBrowserWorkflowRoutes(application, { auth: {} as AuthService, database: {} as never });

    authorizeRequest.mockRejectedValueOnce(new WorkspaceAuthorizationError('viewer detail'));
    const denied = await application.inject({
      method: 'POST',
      url: '/api/workflow/posts',
      headers,
      payload,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain('viewer detail');

    authorizeRequest.mockResolvedValue({ workspaceId, userId: 'user', role: 'owner' });
    executeBrowserMutation.mockRejectedValueOnce(new PostValidationError('duplicate target'));
    const invalid = await application.inject({
      method: 'POST',
      url: '/api/workflow/posts',
      headers,
      payload,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ data: null, error: 'duplicate target' });

    executeBrowserMutation.mockRejectedValueOnce(new Error('database-secret-detail'));
    const failed = await application.inject({
      method: 'POST',
      url: '/api/workflow/posts',
      headers,
      payload,
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ data: null, error: 'Internal server error' });
    expect(failed.body).not.toContain('database-secret-detail');
    await application.close();
  });

  it('atomically transitions the selected imported draft with the created post', async () => {
    const draftId = '00000000-0000-4000-8000-000000000820';
    createPostInTransaction.mockResolvedValue({ postId, revisionId: 'revision', jobIds: [] });
    transitionExternalDraft.mockResolvedValue(true);
    executeBrowserMutation.mockImplementationOnce(
      async (_database, _input, mutation: (transaction: never) => Promise<unknown>) => ({
        kind: 'executed',
        response: await mutation({} as never),
      }),
    );
    const application = Fastify();
    registerBrowserWorkflowRoutes(application, { auth: {} as AuthService, database: {} as never });
    const response = await application.inject({
      method: 'POST',
      url: '/api/workflow/posts',
      headers: {
        'idempotency-key': 'transition-draft',
        'x-csrf-token': 'csrf',
        cookie: 'publish_relay_csrf=csrf',
      },
      payload: {
        content: { type: 'text', text: 'Scheduled from imported media' },
        mediaIds: ['00000000-0000-4000-8000-000000000821'],
        providerAccountIds: ['00000000-0000-4000-8000-000000000804'],
        scheduledAt: '2030-09-02T10:00:00.000Z',
        externalDraftId: draftId,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(transitionExternalDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceId, draftId, postId, userId: 'user' }),
    );
    await application.close();
  });

  it('does not look up a job when the browser session is missing', async () => {
    authorizeRequest.mockResolvedValue(null);
    const application = Fastify();
    registerBrowserWorkflowRoutes(application, {
      auth: {} as AuthService,
      database: {} as never,
    });
    const response = await application.inject({
      method: 'GET',
      url: `/api/workflow/jobs/${jobId}`,
    });

    expect(response.statusCode).toBe(401);
    expect(getBrowserJobDetail).not.toHaveBeenCalled();
    await application.close();
  });

  it('binds job detail lookup to the authenticated workspace and excludes private fields', async () => {
    getBrowserJobDetail.mockResolvedValue(job());
    const application = Fastify();
    registerBrowserWorkflowRoutes(application, {
      auth: {} as AuthService,
      database: {} as never,
    });
    const response = await application.inject({
      method: 'GET',
      url: `/api/workflow/jobs/${jobId}`,
    });

    expect(getBrowserJobDetail).toHaveBeenCalledWith(expect.anything(), workspaceId, jobId, 'user');
    expect(response.body).not.toContain('must-never-leak');
    expect(response.json()).toMatchObject({ data: { id: jobId, content: { text: 'Hello' } } });
    await application.close();
  });

  it('rejects malformed filters and incomplete cursors before querying', async () => {
    const application = Fastify();
    registerBrowserWorkflowRoutes(application, {
      auth: {} as AuthService,
      database: {} as never,
    });
    const response = await application.inject({
      method: 'GET',
      url: '/api/workflow/jobs?limit=101&beforeId=00000000-0000-4000-8000-000000000802',
    });

    expect(response.statusCode).toBe(400);
    expect(listBrowserJobSummaries).not.toHaveBeenCalled();
    await application.close();
  });

  it('cancels and safely replays an already-cancelled browser job', async () => {
    getBrowserJobDetail
      .mockResolvedValueOnce(job())
      .mockResolvedValueOnce({ ...job(), state: 'cancelled' });
    cancelPendingJob.mockResolvedValue(true);
    const application = Fastify();
    registerBrowserWorkflowRoutes(application, {
      auth: {} as AuthService,
      database: {} as never,
    });
    const request = {
      method: 'POST' as const,
      url: `/api/workflow/jobs/${jobId}/cancel`,
      headers: {
        'idempotency-key': 'cancel-job',
        'x-csrf-token': 'csrf',
        cookie: 'publish_relay_csrf=csrf',
      },
    };
    expect((await application.inject(request)).json()).toEqual({
      data: { state: 'cancelled' },
      error: null,
    });
    expect((await application.inject(request)).json()).toEqual({
      data: { state: 'cancelled' },
      error: null,
    });
    expect(cancelPendingJob).toHaveBeenCalledTimes(1);
    await application.close();
  });

  it('requires an idempotency key before retrying a failed browser job', async () => {
    getBrowserJobDetail.mockResolvedValue({ ...job(), state: 'failed' });
    const application = Fastify();
    registerBrowserWorkflowRoutes(application, {
      auth: {} as AuthService,
      database: {} as never,
    });
    const response = await application.inject({
      method: 'POST',
      url: `/api/workflow/jobs/${jobId}/retry`,
      headers: { 'x-csrf-token': 'csrf', cookie: 'publish_relay_csrf=csrf' },
    });
    expect(response.statusCode).toBe(400);
    expect(requestOperatorRetry).not.toHaveBeenCalled();
    await application.close();
  });

  it('retries once, replays queued state, and scopes both operations to the session workspace', async () => {
    getBrowserJobDetail
      .mockResolvedValueOnce({ ...job(), state: 'failed' })
      .mockResolvedValueOnce({ ...job(), state: 'retry_wait' });
    requestOperatorRetry.mockResolvedValue('scheduled');
    const application = Fastify();
    registerBrowserWorkflowRoutes(application, {
      auth: {} as AuthService,
      database: {} as never,
    });
    const request = {
      method: 'POST' as const,
      url: `/api/workflow/jobs/${jobId}/retry`,
      headers: {
        'idempotency-key': 'retry-job',
        'x-csrf-token': 'csrf',
        cookie: 'publish_relay_csrf=csrf',
      },
    };
    expect((await application.inject(request)).statusCode).toBe(200);
    expect((await application.inject(request)).statusCode).toBe(200);
    expect(requestOperatorRetry).toHaveBeenCalledTimes(1);
    expect(requestOperatorRetry.mock.calls[0]?.slice(0, 2)).toEqual([
      expect.anything(),
      expect.objectContaining({ workspaceId, jobId, actorId: 'user' }),
    ]);
    expect(getBrowserJobDetail).toHaveBeenCalledWith(expect.anything(), workspaceId, jobId, 'user');
    await application.close();
  });

  it('returns a retry lifecycle conflict without reporting a queued transition', async () => {
    getBrowserJobDetail.mockResolvedValue({ ...job(), state: 'failed' });
    requestOperatorRetry.mockResolvedValue('conflict');
    const application = Fastify();
    registerBrowserWorkflowRoutes(application, { auth: {} as AuthService, database: {} as never });
    const response = await application.inject({
      method: 'POST',
      url: `/api/workflow/jobs/${jobId}/retry`,
      headers: {
        'idempotency-key': 'retry-conflict',
        'x-csrf-token': 'csrf',
        cookie: 'publish_relay_csrf=csrf',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ data: null, error: 'This job is not eligible for retry' });
    expect(requestOperatorRetry).toHaveBeenCalledTimes(1);
    await application.close();
  });

  it('rejects invalid CSRF and returns lifecycle conflicts without mutating state', async () => {
    verifyCsrfToken.mockReturnValue(false);
    const application = Fastify();
    registerBrowserWorkflowRoutes(application, {
      auth: {} as AuthService,
      database: {} as never,
    });
    const denied = await application.inject({
      method: 'POST',
      url: `/api/workflow/jobs/${jobId}/cancel`,
      headers: { 'idempotency-key': 'cancel-job' },
    });
    expect(denied.statusCode).toBe(403);
    expect(cancelPendingJob).not.toHaveBeenCalled();

    verifyCsrfToken.mockReturnValue(true);
    getBrowserJobDetail.mockResolvedValue(job());
    cancelPendingJob.mockResolvedValue(false);
    const conflict = await application.inject({
      method: 'POST',
      url: `/api/workflow/jobs/${jobId}/cancel`,
      headers: {
        'idempotency-key': 'cancel-job',
        'x-csrf-token': 'csrf',
        cookie: 'publish_relay_csrf=csrf',
      },
    });
    expect(conflict.statusCode).toBe(409);
    await application.close();
  });

  it.each(['cancel', 'retry'] as const)(
    'returns bounded authorization and internal failures for job %s',
    async (action) => {
      const application = Fastify();
      registerBrowserWorkflowRoutes(application, {
        auth: {} as AuthService,
        database: {} as never,
      });
      const request = {
        method: 'POST' as const,
        url: `/api/workflow/jobs/${jobId}/${action}`,
        headers: {
          'idempotency-key': `${action}-safe-boundary`,
          'x-csrf-token': 'csrf',
          cookie: 'publish_relay_csrf=csrf',
        },
      };

      authorizeRequest.mockRejectedValueOnce(new WorkspaceAuthorizationError('viewer detail'));
      const denied = await application.inject(request);
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain('viewer detail');

      authorizeRequest.mockResolvedValue({ workspaceId, userId: 'user', role: 'owner' });
      getBrowserJobDetail.mockRejectedValueOnce(new Error('database-secret-detail'));
      const failed = await application.inject(request);
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({ data: null, error: 'Internal server error' });
      expect(failed.body).not.toContain('database-secret-detail');
      expect(cancelPendingJob).not.toHaveBeenCalled();
      expect(requestOperatorRetry).not.toHaveBeenCalled();
      await application.close();
    },
  );
});

describe('browser workflow MP4 ingest', () => {
  const storage = {
    stageStream: vi.fn(),
    promote: vi.fn(),
    delete: vi.fn(),
    read: vi.fn(),
    store: vi.fn(),
    put: vi.fn(),
  };
  const probe = { probe: vi.fn(), probeMp4: vi.fn(), probeMp4File: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    verifyCsrfToken.mockReturnValue(true);
    storage.delete.mockResolvedValue(undefined);
    deleteUnattachedMedia.mockResolvedValue(true);
    authorizeRequest.mockResolvedValue({ workspaceId, userId: 'user', role: 'owner' });
    storage.stageStream.mockResolvedValue({
      temporaryKey: '.temporary/upload',
      filePath: '/tmp/upload',
      prefix: Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]),
      sha256: 'a'.repeat(64),
      byteSize: 128,
      requestFingerprint: 'fingerprint',
    });
    probe.probeMp4File.mockResolvedValue({ durationMs: 1000, width: 1080, height: 1920 });
    storeStagedMediaInTransaction.mockResolvedValue({
      mediaId: '00000000-0000-4000-8000-000000000899',
      mimeType: 'video/mp4',
      sha256: 'a'.repeat(64),
      byteSize: 128,
    });
    storeMediaInTransaction.mockResolvedValue({
      mediaId: '00000000-0000-4000-8000-000000000899',
      mimeType: 'image/png',
      sha256: 'b'.repeat(64),
      byteSize: 12,
    });
    executeBrowserMutation.mockImplementation(
      async (
        _database: unknown,
        _input: unknown,
        mutation: (transaction: never) => Promise<unknown>,
      ) => ({
        kind: 'executed',
        response: await mutation({} as never),
      }),
    );
  });

  async function upload(headers: Record<string, string> = {}) {
    const application = Fastify();
    registerBrowserWorkflowRoutes(application, {
      auth: {} as AuthService,
      database: {} as never,
      mediaStorage: storage,
      mediaProbe: probe,
      videoConfig: {
        maxBytes: 1024,
        limits: { maxDurationMs: 2000, maxWidth: 1920, maxHeight: 1920 },
      },
    });
    const response = await application.inject({
      method: 'POST',
      url: '/api/workflow/media',
      headers: {
        'content-type': 'video/mp4',
        'x-file-name': 'clip.mp4',
        'idempotency-key': 'browser-upload',
        'x-csrf-token': 'csrf',
        cookie: 'publish_relay_csrf=csrf',
        ...headers,
      },
      payload: Buffer.from('video'),
    });
    await application.close();
    return response;
  }

  it('stores a tenant-scoped user upload and returns only ready media fields', async () => {
    const response = await upload();

    expect(response.statusCode).toBe(201);
    expect(executeBrowserMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceId, userId: 'user', operation: 'media.create' }),
      expect.any(Function),
    );
    expect(storeStagedMediaInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      storage,
      expect.objectContaining({ workspaceId, userId: 'user', actor: { type: 'user', id: 'user' } }),
      expect.anything(),
    );
    expect(response.json()).toEqual({
      data: {
        id: '00000000-0000-4000-8000-000000000899',
        mimeType: 'video/mp4',
        byteSize: 128,
        durationMs: 1000,
        width: 1080,
        height: 1920,
        state: 'ready',
      },
      error: null,
    });
    expect(response.body).not.toContain('sha256');
  });

  it('accepts bounded signed image bytes through the same browser media lifecycle', async () => {
    const application = Fastify();
    registerBrowserWorkflowRoutes(application, {
      auth: {} as AuthService,
      database: {} as never,
      mediaStorage: storage,
    });
    const headers = {
      'content-type': 'image/png',
      'x-file-name': 'picture.png',
      'idempotency-key': 'browser-image',
      'x-csrf-token': 'csrf',
      cookie: 'publish_relay_csrf=csrf',
    };
    const response = await application.inject({
      method: 'POST',
      url: '/api/workflow/media',
      headers,
      payload: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
    });
    expect(response.statusCode).toBe(201);
    expect(storeMediaInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      storage,
      expect.objectContaining({ workspaceId, userId: 'user', maxBytes: 5 * 1024 * 1024 }),
      expect.anything(),
    );
    expect(response.json()).toEqual({
      data: {
        id: '00000000-0000-4000-8000-000000000899',
        mimeType: 'image/png',
        byteSize: 12,
        state: 'ready',
      },
      error: null,
    });
    const invalid = await application.inject({
      method: 'POST',
      url: '/api/workflow/media',
      headers: { ...headers, 'idempotency-key': 'browser-image-invalid' },
      payload: Buffer.from('not-an-image'),
    });
    expect(invalid.statusCode).toBe(400);
    expect(storeMediaInTransaction).toHaveBeenCalledTimes(1);
    await application.close();
  });

  it('admits GIF bytes above the still-image limit using the X adapter limit', async () => {
    const application = Fastify();
    registerBrowserWorkflowRoutes(application, {
      auth: {} as AuthService,
      database: {} as never,
      mediaStorage: storage,
    });
    const bytes = Buffer.alloc(10 * 1024 * 1024);
    bytes.write('GIF89a');
    const response = await application.inject({
      method: 'POST',
      url: '/api/workflow/media',
      headers: {
        'content-type': 'image/gif',
        'x-file-name': 'animation.gif',
        'idempotency-key': 'browser-gif',
        'x-csrf-token': 'csrf',
        cookie: 'publish_relay_csrf=csrf',
      },
      payload: bytes,
    });
    expect(response.statusCode).toBe(201);
    expect(storeMediaInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      storage,
      expect.objectContaining({ maxBytes: 15 * 1024 * 1024 }),
      expect.anything(),
    );
    await application.close();
  });

  it('rejects missing sessions and CSRF before staging bytes', async () => {
    authorizeRequest.mockResolvedValueOnce(null);
    expect((await upload()).statusCode).toBe(401);
    verifyCsrfToken.mockReturnValueOnce(false);
    expect((await upload()).statusCode).toBe(403);
    expect(storage.stageStream).not.toHaveBeenCalled();
  });

  it('rolls back staged bytes when validation or persistence fails', async () => {
    probe.probeMp4File.mockResolvedValueOnce({ durationMs: 3000, width: 1080, height: 1920 });
    expect((await upload()).statusCode).toBe(400);
    expect(storage.delete).toHaveBeenCalledWith('.temporary/upload');

    storeStagedMediaInTransaction.mockRejectedValueOnce(new Error('database unavailable'));
    expect((await upload()).statusCode).toBe(500);
    expect(storage.delete).toHaveBeenCalledWith('.temporary/upload');
  });

  async function removeMedia(options?: { authenticated?: boolean; csrf?: boolean }) {
    if (options?.authenticated === false) authorizeRequest.mockResolvedValueOnce(null);
    if (options?.csrf === false) verifyCsrfToken.mockReturnValueOnce(false);
    const application = Fastify();
    registerBrowserWorkflowRoutes(application, {
      auth: {} as AuthService,
      database: {} as never,
      mediaStorage: storage,
    });
    const response = await application.inject({
      method: 'DELETE',
      url: '/api/workflow/media/00000000-0000-4000-8000-000000000899',
      headers: { 'x-csrf-token': 'csrf', cookie: 'publish_relay_csrf=csrf' },
    });
    await application.close();
    return response;
  }

  it('requires authentication and CSRF before deleting abandoned media', async () => {
    expect((await removeMedia({ authenticated: false })).statusCode).toBe(401);
    expect((await removeMedia({ csrf: false })).statusCode).toBe(403);
    expect(deleteUnattachedMedia).not.toHaveBeenCalled();
  });

  it.each(['cross-tenant', 'nonexistent', 'attached'])(
    'refuses %s media deletion through the tenant route boundary',
    async () => {
      deleteUnattachedMedia.mockResolvedValueOnce(false);
      const response = await removeMedia();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { deleted: false }, error: null });
      expect(deleteUnattachedMedia).toHaveBeenCalledWith(expect.anything(), storage, {
        workspaceId,
        mediaId: '00000000-0000-4000-8000-000000000899',
      });
    },
  );

  it('deletes successfully and safely replays the deletion result', async () => {
    deleteUnattachedMedia.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    expect((await removeMedia()).json()).toEqual({ data: { deleted: true }, error: null });
    expect((await removeMedia()).json()).toEqual({ data: { deleted: true }, error: null });
    expect(deleteUnattachedMedia).toHaveBeenCalledTimes(2);
  });

  it('returns a bounded failure and permits storage-failure recovery on retry', async () => {
    deleteUnattachedMedia
      .mockRejectedValueOnce(new Error('storage-secret-detail'))
      .mockResolvedValueOnce(true);
    const failed = await removeMedia();
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ data: null, error: 'Internal server error' });
    expect(failed.body).not.toContain('storage-secret-detail');
    expect((await removeMedia()).json()).toEqual({ data: { deleted: true }, error: null });
  });
});

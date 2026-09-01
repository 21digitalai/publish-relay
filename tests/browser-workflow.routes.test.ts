import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthService } from '../src/modules/identity/auth.service.js';
import { WorkspaceAuthorizationError } from '../src/modules/identity/authorization.js';
import { PostValidationError } from '../src/modules/content/post.errors.js';

const authorizeRequest = vi.fn();
const listBrowserJobSummaries = vi.fn();
const getBrowserJobDetail = vi.fn();
const cancelPendingJob = vi.fn();
const requestOperatorRetry = vi.fn();
const verifyCsrfToken = vi.fn(() => true);
const executeBrowserMutation = vi.fn();

vi.mock('../src/modules/identity/auth.routes.js', () => ({
  authorizeRequest,
  CSRF_COOKIE: 'publish_relay_csrf',
}));
vi.mock('../src/modules/identity/session.js', () => ({ verifyCsrfToken }));
vi.mock('../src/modules/content/browser-idempotency.repository.js', () => ({
  executeBrowserMutation,
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
    scheduledAt: new Date('2026-09-02T10:00:00.000Z'),
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    updatedAt: new Date('2026-09-01T11:00:00.000Z'),
    content: { type: 'text', text: 'Hello' },
    providerAccount: {
      id: '00000000-0000-4000-8000-000000000804',
      displayName: 'Daily Viber',
      handle: 'daily_viber',
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
    expect(response.json()).toMatchObject({
      data: {
        items: [
          {
            id: jobId,
            contentPreview: 'Hello',
            providerAccount: { displayName: 'Daily Viber' },
          },
        ],
        next: { beforeId: jobId },
      },
      error: null,
    });
    await application.close();
  });

  it('maps browser post authorization, validation, and unexpected failures to safe envelopes', async () => {
    const payload = {
      content: { type: 'text', text: 'Safe browser post' },
      providerAccountIds: ['00000000-0000-4000-8000-000000000804'],
      scheduledAt: '2026-09-02T10:00:00.000Z',
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

    expect(getBrowserJobDetail).toHaveBeenCalledWith(expect.anything(), workspaceId, jobId);
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
    expect(requestOperatorRetry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceId, jobId, actorId: 'user' }),
    );
    expect(getBrowserJobDetail).toHaveBeenCalledWith(expect.anything(), workspaceId, jobId);
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
});

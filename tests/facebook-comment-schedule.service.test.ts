import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { scheduleAccountPageCommentReply } from '../src/modules/providers/facebook-comment-schedule.service.js';
import { PendingCommentConflictError } from '../src/modules/providers/facebook-comment-pending.repository.js';

const mocks = vi.hoisted(() => ({
  tenant: vi.fn(),
  policy: vi.fn(),
  find: vi.fn(),
  target: vi.fn(),
  schedule: vi.fn(),
}));
vi.mock('../src/database/tenant-transaction.js', () => ({ withTenantTransaction: mocks.tenant }));
vi.mock('../src/modules/policy/action-policy.js', () => ({ enforceWorkspaceAction: mocks.policy }));
vi.mock(
  '../src/modules/providers/facebook-comment-pending.repository.js',
  async (loadOriginal) => ({
    ...(await loadOriginal<object>()),
    getPageCommentIntentByAction: mocks.find,
    schedulePageComment: mocks.schedule,
  }),
);
vi.mock('../src/modules/providers/facebook-comments-read.service.js', () => ({
  readScheduledCommentTarget: mocks.target,
}));

const input = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  postId: '123_456',
  commentId: '123_456_789',
  clientActionId: '00000000-0000-4000-8000-000000000003',
  text: 'Hello later',
  dueAt: '2026-11-10T10:00:00Z',
  actor: { type: 'api-key' as const, id: '00000000-0000-4000-8000-000000000004' },
};
const runtime = {
  database: {} as never,
  keys: {} as never,
  client: {} as never,
  policy: {} as never,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenant.mockImplementation(
    (_db: unknown, _input: unknown, callback: (tx: unknown) => Promise<unknown>) => callback({}),
  );
});

describe('scheduled Page comment replay', () => {
  it('stores an attachment-only target snapshot without weakening the reply body', async () => {
    mocks.find.mockResolvedValue(null);
    mocks.target.mockResolvedValue({
      text: '',
      createdAt: '2026-11-10T10:00:00+0000',
      hasPageReply: false,
      threadFingerprint: 'a'.repeat(64),
    });
    mocks.schedule.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000005',
      status: 'pending',
      dueAt: new Date('2099-11-10T10:00:00Z'),
    });

    const future = { ...input, dueAt: '2099-11-10T10:00:00Z' };
    await expect(scheduleAccountPageCommentReply(runtime, future)).resolves.toEqual({
      id: '00000000-0000-4000-8000-000000000005',
      status: 'pending',
      dueAt: '2099-11-10T10:00:00.000Z',
    });
    expect(mocks.schedule).toHaveBeenCalledWith(
      runtime.database,
      expect.objectContaining({ targetText: '', text: input.text }),
    );
  });

  it('returns the exact durable receipt after due time without a new provider read or insert', async () => {
    mocks.find.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000005',
      accountId: input.accountId,
      postId: input.postId,
      commentId: input.commentId,
      requestFingerprint: createHash('sha256')
        .update(
          JSON.stringify({
            accountId: input.accountId,
            postId: input.postId,
            commentId: input.commentId,
            text: input.text,
            dueAt: new Date(input.dueAt).toISOString(),
          }),
        )
        .digest('hex'),
      actorType: 'api_key',
      actorId: input.actor.id,
      status: 'confirmed',
      dueAt: new Date(input.dueAt),
    });
    await expect(scheduleAccountPageCommentReply(runtime, input)).resolves.toEqual({
      id: '00000000-0000-4000-8000-000000000005',
      status: 'confirmed',
      dueAt: new Date(input.dueAt).toISOString(),
    });
    expect(mocks.policy).toHaveBeenCalledOnce();
    expect(mocks.target).not.toHaveBeenCalled();
    expect(mocks.schedule).not.toHaveBeenCalled();
    await expect(
      scheduleAccountPageCommentReply(runtime, { ...input, text: 'Changed' }),
    ).rejects.toBeInstanceOf(PendingCommentConflictError);
    expect(mocks.target).not.toHaveBeenCalled();
  });
});

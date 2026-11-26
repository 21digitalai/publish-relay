import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadToken: vi.fn(),
  reserve: vi.fn(),
  settle: vi.fn(),
}));

vi.mock('../src/modules/providers/instagram-unified-read.service.js', () => ({
  loadInstagramUnifiedToken: mocks.loadToken,
}));
vi.mock('../src/modules/providers/instagram-unified-action.repository.js', () => ({
  reserveInstagramUnifiedAction: mocks.reserve,
  settleInstagramUnifiedAction: mocks.settle,
}));

import {
  createInstagramUnifiedSendService,
  InstagramUnifiedActionConflictError,
  InstagramUnifiedEligibilityError,
} from '../src/modules/providers/instagram-unified-send.service.js';
import { InstagramUnifiedReadError } from '../src/modules/providers/instagram-unified-read-client.js';

const input = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  clientActionId: '00000000-0000-4000-8000-000000000003',
  kind: 'dm_reply' as const,
  targetId: 'message-1',
  parentId: 'conversation-1',
  recipientId: 'person-1',
  text: 'Hello',
  actor: { type: 'api-key' as const, id: '00000000-0000-4000-8000-000000000004' },
};

function runtime() {
  return {
    database: {} as never,
    keys: {} as never,
    client: {
      verifyMessagingPermission: vi.fn().mockResolvedValue('granted'),
      verifyPermissions: vi.fn().mockResolvedValue({ instagram_manage_comments: 'granted' }),
      listMessages: vi.fn().mockResolvedValue({
        messages: [{ id: 'message-1', senderId: 'person-1', createdAt: new Date().toISOString() }],
      }),
      assertCommentOwner: vi.fn().mockResolvedValue(undefined),
      sendConversationMessage: vi.fn().mockResolvedValue('provider-message-1'),
      replyToComment: vi.fn().mockResolvedValue('provider-comment-1'),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadToken.mockResolvedValue({ accessToken: 'token', remoteAccountId: 'remote-account-1' });
  mocks.reserve.mockResolvedValue({ kind: 'new', id: 'reservation-1' });
  mocks.settle.mockResolvedValue(undefined);
});

describe('Instagram Unified manual reply service', () => {
  it('uses only the messaging grant for DM replies and proves inbound target ancestry', async () => {
    const client = runtime();
    const result = await createInstagramUnifiedSendService(client as never).send(input);

    expect(result).toEqual({ state: 'confirmed', receipt: 'provider-message-1' });
    expect(client.client.verifyMessagingPermission).toHaveBeenCalledWith('token');
    expect(client.client.verifyPermissions).not.toHaveBeenCalled();
    expect(client.client.listMessages).toHaveBeenCalledWith({
      accountId: 'remote-account-1',
      conversationId: 'conversation-1',
      accessToken: 'token',
      limit: 100,
    });
    expect(client.client.sendConversationMessage).toHaveBeenCalledOnce();
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: { state: 'confirmed', receipt: 'provider-message-1' } }),
    );
  });

  it('rejects a message authored by the selected account before reservation or send', async () => {
    const client = runtime();
    client.client.listMessages.mockResolvedValue({
      messages: [
        { id: 'message-1', senderId: 'remote-account-1', createdAt: new Date().toISOString() },
      ],
    });

    await expect(
      createInstagramUnifiedSendService(client as never).send(input),
    ).rejects.toBeInstanceOf(InstagramUnifiedEligibilityError);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(client.client.sendConversationMessage).not.toHaveBeenCalled();
  });

  it('rejects a stale or differently authored inbound window', async () => {
    const client = runtime();
    client.client.listMessages.mockResolvedValue({
      messages: [
        { id: 'message-1', senderId: 'another-person', createdAt: new Date().toISOString() },
      ],
    });

    await expect(
      createInstagramUnifiedSendService(client as never).send(input),
    ).rejects.toBeInstanceOf(InstagramUnifiedEligibilityError);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('replays an existing action without a second provider request', async () => {
    mocks.reserve.mockResolvedValue({
      kind: 'existing',
      outcome: { state: 'unknown' },
    });
    const client = runtime();

    await expect(createInstagramUnifiedSendService(client as never).send(input)).resolves.toEqual({
      state: 'unknown',
    });
    expect(client.client.sendConversationMessage).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('rejects a changed replay as an action conflict', async () => {
    mocks.reserve.mockResolvedValue({ kind: 'conflict' });
    const client = runtime();

    await expect(
      createInstagramUnifiedSendService(client as never).send(input),
    ).rejects.toBeInstanceOf(InstagramUnifiedActionConflictError);
    expect(client.client.sendConversationMessage).not.toHaveBeenCalled();
  });

  it('preserves typed provider outcomes for auth, permission, validation, and rate-limit errors', async () => {
    const cases = [
      ['auth', 401],
      ['permission', 403],
      ['validation', 400],
      ['rate_limit', 429],
    ] as const;

    for (const [kind, status] of cases) {
      vi.clearAllMocks();
      mocks.loadToken.mockResolvedValue({
        accessToken: 'token',
        remoteAccountId: 'remote-account-1',
      });
      mocks.reserve.mockResolvedValue({ kind: 'new', id: `reservation-${String(status)}` });
      const client = runtime();
      client.client.sendConversationMessage.mockRejectedValueOnce(
        new InstagramUnifiedReadError(kind, status),
      );

      await expect(createInstagramUnifiedSendService(client as never).send(input)).resolves.toEqual(
        status === 429 ? { state: 'unknown' } : { state: 'failed', failureStatus: status },
      );
      expect(mocks.settle).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          outcome:
            status === 429 ? { state: 'unknown' } : { state: 'failed', failureStatus: status },
        }),
      );
    }
  });

  it('records transport loss as unknown and does not imply delivery', async () => {
    const client = runtime();
    client.client.sendConversationMessage.mockRejectedValueOnce(new Error('connection lost'));

    await expect(createInstagramUnifiedSendService(client as never).send(input)).resolves.toEqual({
      state: 'unknown',
    });
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: { state: 'unknown' } }),
    );
  });

  it('uses the comments grant and exact comment ancestry for comment replies', async () => {
    const client = runtime();
    const commentInput = {
      ...input,
      kind: 'comment_reply' as const,
      targetId: 'comment-1',
      parentId: 'media-1',
      recipientId: undefined,
    };

    await expect(
      createInstagramUnifiedSendService(client as never).send(commentInput),
    ).resolves.toEqual({
      state: 'confirmed',
      receipt: 'provider-comment-1',
    });
    expect(client.client.verifyPermissions).toHaveBeenCalledWith('token');
    expect(client.client.assertCommentOwner).toHaveBeenCalledWith({
      accountId: 'remote-account-1',
      commentId: 'comment-1',
      mediaId: 'media-1',
      accessToken: 'token',
    });
    expect(client.client.verifyMessagingPermission).not.toHaveBeenCalled();
  });
});

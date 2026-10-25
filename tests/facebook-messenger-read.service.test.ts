import { describe, expect, it, vi } from 'vitest';

import { listAccountConversationMessages } from '../src/modules/providers/facebook-messenger-read.service.js';

const mocks = vi.hoisted(() => ({ tokenBoundary: vi.fn() }));
vi.mock('../src/modules/providers/facebook-page-read-context.service.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  withPageReadToken: mocks.tokenBoundary,
}));

const input = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  conversationId: 't_123',
  limit: 10,
};

describe('Facebook selected-conversation message read', () => {
  it('denies a foreign Page or ambiguous participants before message retrieval', async () => {
    const getConversationParticipantIds = vi.fn().mockResolvedValue(['999', 'psid_789']);
    const listConversationMessages = vi.fn();
    mocks.tokenBoundary.mockImplementation(
      async (
        _runtime: unknown,
        _input: unknown,
        read: (pageId: string, token: string) => Promise<unknown>,
      ) => read('123', 'server-held-token'),
    );
    const runtime = {
      database: {} as never,
      keys: {} as never,
      client: { getConversationParticipantIds, listConversationMessages } as never,
    };
    await expect(listAccountConversationMessages(runtime, input)).rejects.toThrow('unavailable');
    getConversationParticipantIds.mockResolvedValue(['123', 'psid_1', 'psid_2']);
    await expect(listAccountConversationMessages(runtime, input)).rejects.toThrow('unavailable');
    expect(listConversationMessages).not.toHaveBeenCalled();
    expect(mocks.tokenBoundary).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ module: 'dms' }),
      expect.any(Function),
    );
  });

  it('reads only after proving the exact selected Page and one fan', async () => {
    const getConversationParticipantIds = vi.fn().mockResolvedValue(['123', 'psid_789']);
    const listConversationMessages = vi.fn().mockResolvedValue({ messages: [], nextCursor: null });
    mocks.tokenBoundary.mockImplementation(
      async (
        _runtime: unknown,
        _input: unknown,
        read: (pageId: string, token: string) => Promise<unknown>,
      ) => read('123', 'server-held-token'),
    );
    const result = await listAccountConversationMessages(
      {
        database: {} as never,
        keys: {} as never,
        client: { getConversationParticipantIds, listConversationMessages } as never,
      },
      input,
    );
    expect(result).toEqual({ participantId: 'psid_789', messages: [], nextCursor: null });
    expect(getConversationParticipantIds).toHaveBeenCalledWith('t_123', 'server-held-token');
    expect(listConversationMessages).toHaveBeenCalledWith({
      conversationId: 't_123',
      accessToken: 'server-held-token',
      limit: 10,
    });
  });
});

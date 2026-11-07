import { describe, expect, it, vi } from 'vitest';

import {
  getAccountConversationLink,
  listAccountConversationMessages,
} from '../src/modules/providers/facebook-messenger-read.service.js';

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
  it('uses only the exact Graph conversation link and leaves a missing link absent', async () => {
    mocks.tokenBoundary.mockImplementation(
      async (
        _runtime: unknown,
        _input: unknown,
        read: (pageId: string, token: string) => Promise<unknown>,
      ) => read('123', 'server-held-token'),
    );
    const getConversationDetails = vi
      .fn()
      .mockResolvedValueOnce({
        participants: [{ id: '123' }, { id: 'psid_7' }],
        link: 'https://www.facebook.com/messages/t/123',
      })
      .mockResolvedValue({ participants: [{ id: '123' }, { id: 'psid_7' }], link: null });
    const runtime = {
      database: {} as never,
      keys: {} as never,
      client: { getConversationDetails } as never,
    };
    await expect(getAccountConversationLink(runtime, input)).resolves.toBe(
      'https://www.facebook.com/messages/t/123',
    );
    await expect(getAccountConversationLink(runtime, input)).resolves.toBeNull();
    getConversationDetails.mockResolvedValue({
      participants: [{ id: '999' }, { id: 'psid_7' }],
      link: null,
    });
    await expect(getAccountConversationLink(runtime, input)).rejects.toThrow('unavailable');
  });
  it('denies a foreign Page or ambiguous participants before message retrieval', async () => {
    const getConversationDetails = vi
      .fn()
      .mockResolvedValue({ participants: [{ id: '999' }, { id: 'psid_789' }], link: null });
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
      client: { getConversationDetails, listConversationMessages } as never,
    };
    await expect(listAccountConversationMessages(runtime, input)).rejects.toThrow('unavailable');
    getConversationDetails.mockResolvedValue({
      participants: [{ id: '123' }, { id: 'psid_1' }, { id: 'psid_2' }],
      link: null,
    });
    await expect(listAccountConversationMessages(runtime, input)).rejects.toThrow('unavailable');
    expect(listConversationMessages).not.toHaveBeenCalled();
    expect(mocks.tokenBoundary).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ module: 'dms' }),
      expect.any(Function),
    );
  });

  it('reads only after proving the exact selected Page and one fan', async () => {
    const getConversationDetails = vi.fn().mockResolvedValue({
      participants: [{ id: '123' }, { id: 'psid_789', name: 'Birkan Reyhan' }],
      link: 'https://www.facebook.com/messages/t/123',
    });
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
        client: { getConversationDetails, listConversationMessages } as never,
      },
      input,
    );
    expect(result).toEqual({
      participantId: 'psid_789',
      displayName: 'Birkan Reyhan',
      link: 'https://www.facebook.com/messages/t/123',
      messages: [],
      nextCursor: null,
    });
    expect(getConversationDetails).toHaveBeenCalledWith('t_123', 'server-held-token');
    expect(listConversationMessages).toHaveBeenCalledWith({
      conversationId: 't_123',
      accessToken: 'server-held-token',
      limit: 10,
    });
  });

  it('keeps absent provider names explicit instead of guessing from participant ID', async () => {
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
        client: {
          getConversationDetails: vi
            .fn()
            .mockResolvedValue({ participants: [{ id: '123' }, { id: 'psid_789' }], link: null }),
          listConversationMessages: vi.fn().mockResolvedValue({ messages: [], nextCursor: null }),
        } as never,
      },
      input,
    );
    expect(result.displayName).toBeNull();
  });
});

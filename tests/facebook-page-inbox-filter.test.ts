import { describe, expect, it, vi } from 'vitest';

import { listAccountPageConversations } from '../src/modules/providers/facebook-messenger-read.service.js';

const mocks = vi.hoisted(() => ({
  noGo: vi.fn(),
  terminal: vi.fn(),
}));
vi.mock('../src/modules/providers/facebook-dm-no-go.repository.js', () => ({
  pageNoGoConversationIds: mocks.noGo,
}));
vi.mock('../src/modules/providers/facebook-dm-memory.repository.js', () => ({
  terminalPageConversationIds: mocks.terminal,
}));
vi.mock('../src/modules/providers/facebook-page-read-context.service.js', () => ({
  withPageReadToken: (
    _runtime: unknown,
    _input: unknown,
    use: (id: string, token: string) => unknown,
  ) => use('page', 'token'),
}));

describe('selected-Page inbox filtering', () => {
  it('drops no-go and terminal threads before detail reads while retaining the provider cursor', async () => {
    mocks.noGo.mockResolvedValue(new Set(['blocked']));
    mocks.terminal.mockResolvedValue(new Set(['finished']));
    const listPageConversations = vi.fn().mockResolvedValue({
      conversations: ['blocked', 'finished', 'ready'].map((id) => ({ id, displayName: id })),
      nextCursor: 'next-page',
    });
    const runtime = {
      database: {} as never,
      keys: {} as never,
      client: { listPageConversations } as never,
    };
    const input = {
      workspaceId: 'workspace',
      accountId: 'page-account',
      filter: 'eligible' as const,
    };

    const result = await listAccountPageConversations(runtime, input);
    expect(result).toEqual({
      conversations: [{ id: 'ready', displayName: 'ready', noGo: false, terminal: false }],
      nextCursor: 'next-page',
    });
    expect(mocks.noGo).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      conversationIds: ['blocked', 'finished', 'ready'],
    });
    expect(mocks.terminal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accountId: input.accountId }),
    );
    expect(
      (await listAccountPageConversations(runtime, { ...input, filter: 'all' })).conversations,
    ).toMatchObject([{ noGo: true }, { terminal: true }, { noGo: false, terminal: false }]);
  });
});

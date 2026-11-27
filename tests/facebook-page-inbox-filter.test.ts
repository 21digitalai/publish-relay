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
  it('filters mixed timestamps inclusively, keeps uncertainty and preserves empty-page continuation', async () => {
    mocks.noGo.mockResolvedValue(new Set(['blocked']));
    mocks.terminal.mockResolvedValue(new Set(['finished']));
    const cutoff = '2026-11-27T00:00:00Z';
    const rows = [
      { id: 'recent', updatedAt: '2026-11-28T00:00:00Z' },
      { id: 'old', updatedAt: '2026-11-26T23:59:59Z' },
      { id: 'exact', updatedAt: cutoff },
      { id: 'missing', updatedAt: null },
      { id: 'invalid', updatedAt: 'not-a-date' },
      { id: 'blocked', updatedAt: cutoff },
      { id: 'finished', updatedAt: cutoff },
    ];
    const listPageConversations = vi
      .fn()
      .mockResolvedValueOnce({
        conversations: rows,
        nextCursor: 'opaque/next',
      })
      .mockResolvedValueOnce({
        conversations: [rows[1]],
        nextCursor: 'after-empty',
      })
      .mockResolvedValueOnce({
        conversations: [rows[0]],
        nextCursor: null,
      });
    const runtime = {
      database: {} as never,
      keys: {} as never,
      client: { listPageConversations } as never,
    };
    const input = {
      workspaceId: 'workspace',
      accountId: 'page-account',
      updatedSince: cutoff,
      filter: 'eligible' as const,
      limit: 25,
    };
    const first = await listAccountPageConversations(runtime, input);
    expect(first.conversations.map((item) => item.id)).toEqual([
      'recent',
      'exact',
      'missing',
      'invalid',
    ]);
    expect(first.nextCursor).toBe('opaque/next');
    expect(
      await listAccountPageConversations(runtime, { ...input, after: first.nextCursor ?? '' }),
    ).toEqual({ conversations: [], nextCursor: 'after-empty' });
    const last = await listAccountPageConversations(runtime, { ...input, after: 'after-empty' });
    expect(last.conversations.map((item) => item.id)).toEqual(['recent']);
    expect(last.nextCursor).toBeNull();
    expect(listPageConversations.mock.calls).toEqual([
      [{ pageId: 'page', accessToken: 'token', limit: 25 }],
      [{ pageId: 'page', accessToken: 'token', limit: 25, after: 'opaque/next' }],
      [{ pageId: 'page', accessToken: 'token', limit: 25, after: 'after-empty' }],
    ]);
    expect(JSON.stringify(first)).not.toMatch(/accessToken|participants|messages|credential/);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(1024);
  });
});

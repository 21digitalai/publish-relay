import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sendAccountPageConversationMessage } from '../src/modules/providers/facebook-messenger-send.service.js';

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  find: vi.fn(),
  reserve: vi.fn(),
  settle: vi.fn(),
  tenant: vi.fn(),
  policy: vi.fn(),
  noGo: vi.fn(),
  noGoInTransaction: vi.fn(),
  lock: vi.fn(),
}));
vi.mock('../src/modules/providers/facebook-page-read-context.service.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  withPageReadToken: mocks.token,
}));
vi.mock('../src/modules/providers/facebook-dm-action.repository.js', () => ({
  findFacebookDmAction: mocks.find,
  reserveFacebookDmAction: mocks.reserve,
  settleFacebookDmAction: mocks.settle,
}));
vi.mock('../src/modules/providers/facebook-dm-no-go.repository.js', () => ({
  isPageConversationNoGo: mocks.noGo,
  isPageConversationNoGoInTransaction: mocks.noGoInTransaction,
  lockPageDmAccount: mocks.lock,
}));
vi.mock('../src/database/tenant-transaction.js', () => ({ withTenantTransaction: mocks.tenant }));
vi.mock('../src/modules/policy/action-policy.js', () => ({ enforceWorkspaceAction: mocks.policy }));

const input = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  conversationId: 't_123',
  clientActionId: '00000000-0000-4000-8000-000000000003',
  text: 'Hello',
  actor: { type: 'api-key' as const, id: '00000000-0000-4000-8000-000000000004' },
};

function runtime(messages: { id?: string; senderId: string | null; createdAt: string }[]) {
  return {
    database: {} as never,
    keys: {} as never,
    policy: {} as never,
    client: {
      getConversationParticipants: vi.fn().mockResolvedValue([
        { id: '123', name: 'Eli Page' },
        { id: 'psid_7', name: 'Alexandra' },
      ]),
      listConversationMessages: vi.fn().mockResolvedValue({ messages, nextCursor: null }),
      sendPageMessage: vi.fn().mockResolvedValue('mid_9'),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenant.mockImplementation(
    (_db: unknown, _input: unknown, callback: (tx: unknown) => Promise<unknown>) => callback({}),
  );
  mocks.token.mockImplementation(
    (
      _runtime: unknown,
      _input: unknown,
      callback: (pageId: string, token: string) => Promise<unknown>,
    ) => callback('123', 'server-token'),
  );
  mocks.find.mockResolvedValue(null);
  mocks.noGo.mockResolvedValue(false);
  mocks.noGoInTransaction.mockResolvedValue(false);
  mocks.reserve.mockResolvedValue({ kind: 'new', id: '00000000-0000-4000-8000-000000000005' });
});

describe('Facebook inbound-only send command', () => {
  it('sends once to the selected Page participant and persists confirmation', async () => {
    const client = runtime([{ senderId: 'psid_7', createdAt: new Date().toISOString() }]);
    await expect(sendAccountPageConversationMessage(client as never, input)).resolves.toEqual({
      state: 'confirmed',
      messageId: 'mid_9',
    });
    expect(client.client.sendPageMessage).toHaveBeenCalledWith({
      pageId: '123',
      recipientId: 'psid_7',
      text: 'Hello',
      accessToken: 'server-token',
    });
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        receiverLabel: 'Alexandra',
      }),
    );
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: { state: 'confirmed', messageId: 'mid_9' },
      }),
    );
  });

  it('denies absent or stale inbound before reserving or sending', async () => {
    const client = runtime([
      { senderId: 'psid_7', createdAt: new Date(Date.now() - 25 * 3600_000).toISOString() },
    ]);
    await expect(sendAccountPageConversationMessage(client as never, input)).rejects.toThrow(
      'No recent inbound',
    );
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(client.client.sendPageMessage).not.toHaveBeenCalled();
  });

  it('stops a grouped reply before reservation when a newer inbound arrives', async () => {
    const client = runtime([
      {
        id: 'mid_original',
        senderId: 'psid_7',
        createdAt: new Date(Date.now() - 10_000).toISOString(),
      },
      { id: 'mid_new', senderId: 'psid_7', createdAt: new Date().toISOString() },
    ]);
    await expect(
      sendAccountPageConversationMessage(client as never, {
        ...input,
        expectedLatestInboundMessageId: 'mid_original',
      }),
    ).rejects.toThrow('newer inbound');
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(client.client.sendPageMessage).not.toHaveBeenCalled();
  });

  it('allows a reviewed reply when its expected inbound is still latest', async () => {
    const client = runtime([
      { id: 'mid_original', senderId: 'psid_7', createdAt: new Date().toISOString() },
    ]);
    await expect(
      sendAccountPageConversationMessage(client as never, {
        ...input,
        expectedLatestInboundMessageId: 'mid_original',
      }),
    ).resolves.toMatchObject({ state: 'confirmed' });
    expect(client.client.sendPageMessage).toHaveBeenCalledOnce();
  });

  it('does not reserve or call Meta for a no-go conversation', async () => {
    mocks.noGo.mockResolvedValue(true);
    const client = runtime([{ senderId: 'psid_7', createdAt: new Date().toISOString() }]);
    await expect(sendAccountPageConversationMessage(client as never, input)).rejects.toThrow(
      'no-go list',
    );
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(client.client.sendPageMessage).not.toHaveBeenCalled();
  });

  it('rechecks no-go under the dispatch lock after durable reservation', async () => {
    mocks.noGoInTransaction.mockResolvedValue(true);
    const client = runtime([{ senderId: 'psid_7', createdAt: new Date().toISOString() }]);
    await expect(sendAccountPageConversationMessage(client as never, input)).rejects.toThrow(
      'no-go list',
    );
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.lock).toHaveBeenCalledOnce();
    expect(client.client.sendPageMessage).not.toHaveBeenCalled();
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: { state: 'failed', failureStatus: 403 },
      }),
    );
  });

  it('denies a sibling Page conversation before reserving', async () => {
    const client = runtime([{ senderId: 'psid_7', createdAt: new Date().toISOString() }]);
    vi.mocked(client.client.getConversationParticipants).mockResolvedValue([
      { id: '999', name: 'Other Page' },
      { id: 'psid_7', name: 'Alexandra' },
    ]);
    await expect(sendAccountPageConversationMessage(client as never, input)).rejects.toThrow(
      'unavailable',
    );
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('replays a reserved action as unknown without another provider call', async () => {
    mocks.find.mockResolvedValue({ kind: 'existing', outcome: { state: 'unknown' } });
    const client = runtime([]);
    await expect(sendAccountPageConversationMessage(client as never, input)).resolves.toEqual({
      state: 'unknown',
    });
    expect(client.client.sendPageMessage).not.toHaveBeenCalled();
  });

  it('settles ambiguous provider failure as unknown', async () => {
    const client = runtime([{ senderId: 'psid_7', createdAt: new Date().toISOString() }]);
    vi.mocked(client.client.sendPageMessage).mockRejectedValue(new Error('lost response'));
    await expect(sendAccountPageConversationMessage(client as never, input)).resolves.toEqual({
      state: 'unknown',
    });
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: { state: 'unknown' },
      }),
    );
  });
});

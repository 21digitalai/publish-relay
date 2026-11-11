import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sendAccountPageConversationMessage } from '../src/modules/providers/facebook-messenger-send.service.js';
import { FacebookRequestError } from '../src/modules/providers/facebook-http-client.js';

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
  bioMention: vi.fn(),
  dailyLimit: vi.fn(),
  claimedGroup: vi.fn(),
}));
vi.mock('../src/modules/providers/facebook-page-read-context.service.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  withPageReadToken: mocks.token,
}));
vi.mock('../src/modules/providers/facebook-dm-action.repository.js', () => ({
  findFacebookDmAction: mocks.find,
  reserveFacebookDmAction: mocks.reserve,
  settleFacebookDmAction: mocks.settle,
  settleFacebookDmActionInTransaction: mocks.settle,
}));
vi.mock('../src/modules/providers/facebook-dm-no-go.repository.js', () => ({
  isPageConversationNoGo: mocks.noGo,
  isPageConversationNoGoInTransaction: mocks.noGoInTransaction,
  lockPageDmAccount: mocks.lock,
}));
vi.mock('../src/modules/providers/facebook-dm-bio-link.repository.js', () => ({
  hasPageDmBioLinkMention: mocks.bioMention,
}));
vi.mock('../src/modules/providers/facebook-page-engagement.service.js', () => ({
  isPageDmDailyGroupLimitEnabledInTransaction: mocks.dailyLimit,
}));
vi.mock('../src/modules/providers/facebook-dm-pending.repository.js', () => ({
  isAllowedPageDmGroupDispatchInTransaction: mocks.claimedGroup,
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
      sendPageMessage: vi.fn<() => Promise<string>>().mockResolvedValue('mid_9'),
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
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
  mocks.bioMention.mockResolvedValue(false);
  mocks.dailyLimit.mockResolvedValue(false);
  mocks.claimedGroup.mockResolvedValue(false);
});

describe('Facebook inbound-only send command', () => {
  it('fails an already-claimed single-message machine intent after the Page cap is enabled', async () => {
    mocks.dailyLimit.mockResolvedValue(true);
    const client = runtime([{ senderId: 'psid_7', createdAt: new Date().toISOString() }]);
    await expect(
      sendAccountPageConversationMessage(client as never, {
        ...input,
        scheduledIntentId: '00000000-0000-4000-8000-000000000006',
      }),
    ).resolves.toEqual({ state: 'failed', failureStatus: 409 });
    expect(mocks.claimedGroup).toHaveBeenCalledOnce();
    expect(client.client.sendPageMessage).not.toHaveBeenCalled();
  });

  it('does not call Meta for a preexisting second group whose day slot is occupied at dispatch', async () => {
    mocks.dailyLimit.mockResolvedValue(true);
    mocks.claimedGroup.mockResolvedValue(false);
    const client = runtime([{ senderId: 'psid_7', createdAt: new Date().toISOString() }]);
    await expect(
      sendAccountPageConversationMessage(client as never, {
        ...input,
        scheduledIntentId: '00000000-0000-4000-8000-000000000006',
      }),
    ).resolves.toEqual({ state: 'failed', failureStatus: 409 });
    expect(client.client.sendPageMessage).not.toHaveBeenCalled();
  });

  it('rechecks a direct machine send after the Page toggle takes the lock', async () => {
    let enabled = false;
    mocks.lock.mockImplementation(() => {
      enabled = true;
    });
    mocks.dailyLimit.mockImplementation(() => enabled);
    const client = runtime([{ senderId: 'psid_7', createdAt: new Date().toISOString() }]);
    await expect(sendAccountPageConversationMessage(client as never, input)).resolves.toEqual({
      state: 'failed',
      failureStatus: 409,
    });
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: { state: 'failed', failureStatus: 409 },
      }),
    );
    expect(client.client.sendPageMessage).not.toHaveBeenCalled();
  });

  it('allows only a claimed group bubble through an enabled Page cap', async () => {
    mocks.dailyLimit.mockResolvedValue(true);
    mocks.claimedGroup.mockResolvedValue(true);
    const client = runtime([{ senderId: 'psid_7', createdAt: new Date().toISOString() }]);
    await expect(
      sendAccountPageConversationMessage(client as never, {
        ...input,
        scheduledIntentId: '00000000-0000-4000-8000-000000000006',
      }),
    ).resolves.toMatchObject({ state: 'confirmed' });
    expect(client.client.sendPageMessage).toHaveBeenCalledOnce();
  });
  it('refuses a second explicit bio mention before provider I/O', async () => {
    const client = runtime([
      { id: 'in_1', senderId: 'psid_7', createdAt: new Date().toISOString() },
    ]);
    mocks.bioMention.mockResolvedValue(true);
    await expect(
      sendAccountPageConversationMessage(client as never, { ...input, bioLinkMention: true }),
    ).resolves.toEqual({ state: 'failed', failureStatus: 409 });
    expect(client.client.sendPageMessage).not.toHaveBeenCalled();
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        bioLinkMention: true,
        outcome: { state: 'failed', failureStatus: 409 },
      }),
    );
  });
  it('keeps confirmed final settlement under the Page lock before another send can POST', async () => {
    let releaseProvider: ((messageId: string) => void) | undefined;
    let previousLock = Promise.resolve();
    let noGo = false;
    const client = runtime([{ senderId: 'psid_7', createdAt: new Date().toISOString() }]);
    vi.mocked(client.client.sendPageMessage).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseProvider = resolve;
        }),
    );
    mocks.noGoInTransaction.mockImplementation(() => noGo);
    mocks.lock.mockImplementation(async (tx: { release?: () => void }) => {
      const waitForPrior = previousLock;
      let unlock: (() => void) | undefined;
      previousLock = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      await waitForPrior;
      if (!unlock) throw new Error('Page lock release unavailable');
      tx.release = unlock;
    });
    mocks.tenant.mockImplementation(
      async (
        _db: unknown,
        _input: unknown,
        callback: (tx: { release?: () => void }) => Promise<unknown>,
      ) => {
        const tx: { release?: () => void } = {};
        try {
          return await callback(tx);
        } finally {
          tx.release?.();
        }
      },
    );
    mocks.settle.mockImplementation((_tx: unknown, settlement: { outcome: { state: string } }) => {
      if (settlement.outcome.state === 'confirmed') noGo = true;
    });
    const final = sendAccountPageConversationMessage(client as never, {
      ...input,
      finalExit: true,
    });
    await vi.waitFor(() => {
      expect(releaseProvider).toBeDefined();
    });
    const second = sendAccountPageConversationMessage(client as never, {
      ...input,
      clientActionId: '00000000-0000-4000-8000-000000000099',
    });
    await vi.waitFor(() => {
      expect(mocks.reserve).toHaveBeenCalledTimes(2);
    });
    releaseProvider?.('mid_final');
    await expect(final).resolves.toMatchObject({ state: 'confirmed' });
    await expect(second).rejects.toThrow('no-go list');
    expect(client.client.sendPageMessage).toHaveBeenCalledTimes(1);
  });
  it('settles a definite Graph rejection with safe diagnostics but returns only status', async () => {
    const client = runtime([{ senderId: 'psid_7', createdAt: new Date().toISOString() }]);
    vi.mocked(client.client.sendPageMessage).mockRejectedValue(
      new FacebookRequestError({
        kind: 'validation',
        status: 400,
        code: 100,
        subcode: 2018001,
        traceId: 'A-safe_trace-1',
        isTransient: false,
      }),
    );
    await expect(sendAccountPageConversationMessage(client as never, input)).resolves.toEqual({
      state: 'failed',
      failureStatus: 400,
    });
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: { state: 'failed', failureStatus: 400 },
        failureEvidence: {
          code: 100,
          subcode: 2018001,
          traceId: 'A-safe_trace-1',
          isTransient: false,
        },
      }),
    );
  });
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

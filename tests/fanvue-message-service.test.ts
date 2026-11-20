import { beforeEach, describe, expect, it, vi } from 'vitest';

const ledger = vi.hoisted(() => ({ find: vi.fn(), reserve: vi.fn(), settle: vi.fn() }));
const policy = vi.hoisted(() => ({ enforce: vi.fn(() => Promise.resolve()) }));
const readyMedia = vi.hoisted(() => ({ get: vi.fn() }));
const pending = vi.hoisted(() => ({
  schedule: vi.fn(),
  replay: vi.fn(),
  find: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('../src/database/tenant-transaction.js', () => ({
  withTenantTransaction: (_db: unknown, _input: unknown, work: (transaction: unknown) => unknown) =>
    work({}),
}));
vi.mock('../src/modules/policy/action-policy.js', () => ({
  enforceWorkspaceAction: policy.enforce,
}));
vi.mock('../src/modules/providers/fanvue-action-intent.repository.js', () => ({
  findFanvueAction: ledger.find,
  reserveFanvueAction: ledger.reserve,
  settleFanvueAction: ledger.settle,
}));
vi.mock('../src/modules/providers/fanvue-dm-ready-media.repository.js', () => ({
  getReadyFanvueDmMedia: readyMedia.get,
}));
vi.mock('../src/modules/providers/fanvue-dm-pending.repository.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  scheduleFanvueDm: pending.schedule,
  replayScheduledFanvueDm: pending.replay,
  findPendingFanvueDm: pending.find,
  cancelPendingFanvueDm: pending.cancel,
}));

import { FanvueRequestError } from '../src/modules/providers/fanvue-http-client.js';
import { FanvueMessageService } from '../src/modules/providers/fanvue-message.service.js';

const input = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  fanUuid: '00000000-0000-4000-8000-000000000003',
  clientActionId: '00000000-0000-4000-8000-000000000004',
  text: 'Hello',
  actor: { type: 'api-key' as const, id: '00000000-0000-4000-8000-000000000007' },
};
const messageUuid = '00000000-0000-4000-8000-000000000005';
const mediaUuid = '00000000-0000-4000-8000-000000000008';
const localMediaId = '00000000-0000-4000-8000-000000000009';
const events: string[] = [];
const reads = {
  getChatCreateToken: vi.fn(() => Promise.resolve('token')),
  listFollowers: vi.fn(() => Promise.resolve({ data: [{ uuid: input.fanUuid }] })),
  listSubscribers: vi.fn(() => Promise.resolve({ data: [{ uuid: input.fanUuid }] })),
  getExistingChatForMessage: vi.fn(() => {
    events.push('preflight');
    return Promise.resolve({
      accessToken: 'token',
      targetLabel: '@alexandra',
      latestMessageUuid: messageUuid,
      latestMessageAt: new Date('2026-11-20T10:00:00Z'),
    });
  }),
  getMediaStatus: vi.fn(() => Promise.resolve({ uuid: mediaUuid, status: 'ready' })),
};
const client = {
  createChat: vi.fn(() => {
    events.push('create');
    return Promise.resolve();
  }),
  sendMessage: vi.fn(() => {
    events.push('send');
    return Promise.resolve({ messageUuid });
  }),
};
const service = new FanvueMessageService({} as never, reads as never, client as never, {} as never);

beforeEach(() => {
  vi.clearAllMocks();
  reads.listFollowers.mockReset().mockResolvedValue({ data: [{ uuid: input.fanUuid }] });
  reads.listSubscribers.mockReset().mockResolvedValue({ data: [{ uuid: input.fanUuid }] });
  ledger.find.mockResolvedValue(null);
  events.length = 0;
  ledger.reserve.mockImplementation(() => {
    events.push('reserve');
    return Promise.resolve({ kind: 'new', id: '00000000-0000-4000-8000-000000000006' });
  });
  ledger.settle.mockImplementation(() => {
    events.push('settle');
    return Promise.resolve();
  });
  readyMedia.get.mockResolvedValue(new Map([[localMediaId, mediaUuid]]));
  pending.schedule.mockResolvedValue({ status: 'pending' });
  pending.replay.mockResolvedValue(null);
});

describe('Fanvue scheduled message preflight', () => {
  const dueAt = new Date('2026-11-11T10:00:00Z');
  it('persists timing only after current account, target and policy checks', async () => {
    await service.scheduleMessage({ ...input, dueAt });
    expect(reads.getExistingChatForMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        fanUuid: input.fanUuid,
      }),
    );
    expect(policy.enforce).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'engagement.send' }),
    );
    expect(pending.schedule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ...input, dueAt }),
    );
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('does not persist or send on revoked chat access', async () => {
    reads.getExistingChatForMessage.mockRejectedValueOnce(new Error('revoked'));
    await expect(service.scheduleMessage({ ...input, dueAt })).rejects.toThrow('revoked');
    expect(pending.schedule).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('returns an exact prior receipt without provider preflight', async () => {
    pending.replay.mockResolvedValueOnce({
      status: 'cancelled',
      clientActionId: input.clientActionId,
    });
    await expect(service.scheduleMessage({ ...input, dueAt })).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(reads.getExistingChatForMessage).not.toHaveBeenCalled();
    expect(pending.schedule).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});

describe('Fanvue grouped dispatch preflight', () => {
  const boundary = {
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    fanUuid: input.fanUuid,
    expectedLatestInboundMessageUuid: messageUuid,
    expectedLatestInboundAt: new Date('2026-11-20T10:00:00Z'),
  };

  it('allows only the exact latest message boundary', async () => {
    await expect(service.preflightScheduledDispatch(boundary)).resolves.toBe('allow');
    await expect(
      service.preflightScheduledDispatch({
        ...boundary,
        expectedLatestInboundMessageUuid: mediaUuid,
      }),
    ).resolves.toBe('cancel');
  });

  it('freezes on an ambiguous provider read and preserves legacy singles', async () => {
    reads.getExistingChatForMessage.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(service.preflightScheduledDispatch(boundary)).resolves.toBe('freeze_unknown');
    await expect(
      service.preflightScheduledDispatch({
        ...boundary,
        expectedLatestInboundMessageUuid: null,
        expectedLatestInboundAt: null,
      }),
    ).resolves.toBe('allow');
  });
});

describe('Fanvue selected-fan chat creation', () => {
  const selected = {
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    fanUuid: input.fanUuid,
    clientActionId: input.clientActionId,
    audience: 'followers' as const,
    page: 1,
    actor: input.actor,
  };

  it('reserves before one provider create and never sends a message', async () => {
    await expect(service.createChat(selected)).resolves.toEqual({
      state: 'confirmed',
      fanUuid: input.fanUuid,
    });
    expect(events).toEqual(['reserve', 'create', 'settle']);
    expect(reads.listFollowers).toHaveBeenCalledWith({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      page: 1,
      size: 15,
    });
    expect(ledger.reserve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actionKind: 'chat_create', targetUuid: input.fanUuid }),
    );
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('does not replay an unknown provider outcome or a conflicting action ID', async () => {
    ledger.find.mockResolvedValueOnce({
      kind: 'existing',
      state: 'unknown',
      providerObjectUuid: null,
      failureStatus: null,
    });
    await expect(service.createChat(selected)).resolves.toEqual({ state: 'unknown' });
    ledger.find.mockResolvedValueOnce({ kind: 'conflict' });
    await expect(service.createChat(selected)).rejects.toThrow('conflicts');
    expect(client.createChat).not.toHaveBeenCalled();
  });

  it('rechecks the exact nondefault page size and denies a shifted or mismatched page', async () => {
    await expect(service.createChat({ ...selected, page: 2, size: 25 })).resolves.toMatchObject({
      state: 'confirmed',
    });
    expect(reads.listFollowers).toHaveBeenCalledWith({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      page: 2,
      size: 25,
    });
    reads.listFollowers.mockResolvedValueOnce({ data: [{ uuid: messageUuid }] });
    await expect(service.createChat({ ...selected, page: 2, size: 15 })).rejects.toThrow(
      'Selected fan',
    );
    expect(client.createChat).toHaveBeenCalledTimes(1);
    expect(ledger.reserve).toHaveBeenCalledTimes(1);
  });

  it.each(['confirmed', 'unknown'] as const)(
    'returns a %s receipt after Audience membership shifts without another provider call',
    async (state) => {
      ledger.find.mockResolvedValueOnce({
        kind: 'existing',
        state,
        providerObjectUuid: state === 'confirmed' ? input.fanUuid : null,
        failureStatus: null,
      });
      reads.listFollowers.mockResolvedValueOnce({ data: [] });
      await expect(service.createChat(selected)).resolves.toEqual(
        state === 'confirmed'
          ? { state: 'confirmed', fanUuid: input.fanUuid }
          : { state: 'unknown' },
      );
      expect(reads.listFollowers).not.toHaveBeenCalled();
      expect(ledger.reserve).not.toHaveBeenCalled();
      expect(client.createChat).not.toHaveBeenCalled();
    },
  );

  it('does not reserve or create when selected account permission is denied', async () => {
    reads.getChatCreateToken.mockRejectedValueOnce(new Error('selected account unavailable'));
    await expect(service.createChat(selected)).rejects.toThrow('selected account unavailable');
    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(client.createChat).not.toHaveBeenCalled();
  });

  it('denies a foreign, missing or shifted Audience selection before reservation', async () => {
    reads.listFollowers.mockResolvedValueOnce({ data: [{ uuid: messageUuid }] });
    await expect(service.createChat(selected)).rejects.toThrow('Selected fan');
    reads.listFollowers.mockResolvedValueOnce({ data: [] });
    await expect(service.createChat(selected)).rejects.toThrow('Selected fan');
    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(client.createChat).not.toHaveBeenCalled();
  });

  it('requires the independent Audience read grant and supports subscriber cursor selection', async () => {
    reads.listFollowers.mockRejectedValueOnce(new Error('read:fan scope missing'));
    await expect(service.createChat(selected)).rejects.toThrow('read:fan scope missing');
    expect(ledger.reserve).not.toHaveBeenCalled();
    await expect(
      service.createChat({ ...selected, audience: 'subscribers', page: undefined, cursor: 'next' }),
    ).resolves.toMatchObject({ state: 'confirmed' });
    expect(reads.listSubscribers).toHaveBeenCalledWith({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      cursor: 'next',
      size: 15,
    });
  });

  it('preserves contactability denial and transport uncertainty', async () => {
    client.createChat.mockRejectedValueOnce(new FanvueRequestError(400));
    await expect(service.createChat(selected)).resolves.toEqual({
      state: 'failed',
      failureStatus: 400,
    });
    client.createChat.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.createChat(selected)).resolves.toEqual({ state: 'unknown' });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});

describe('Fanvue existing-chat text send command', () => {
  it('preflights selected creator/fan and commits intent before one text-only send', async () => {
    await expect(service.sendText(input)).resolves.toEqual({ state: 'confirmed', messageUuid });
    expect(events).toEqual(['preflight', 'reserve', 'send', 'settle']);
    expect(policy.enforce).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'engagement.send', actor: input.actor }),
    );
    expect(reads.getExistingChatForMessage).toHaveBeenCalledWith(input);
    expect(client.sendMessage).toHaveBeenCalledWith('token', input.fanUuid, { text: input.text });
    expect(ledger.reserve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        textBody: 'Hello',
        targetLabel: '@alexandra',
        mediaCount: 0,
        priceCents: null,
      }),
    );
    expect(ledger.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: { state: 'confirmed', providerObjectUuid: messageUuid } }),
    );
  });

  it('never reserves or sends without account, chat or write-scope reach', async () => {
    reads.getExistingChatForMessage.mockRejectedValueOnce(new Error('scope missing'));
    await expect(service.sendText(input)).rejects.toThrow('scope missing');
    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('never reserves or sends when the neutral action policy denies', async () => {
    policy.enforce.mockRejectedValueOnce(new Error('policy denied'));
    await expect(service.sendText(input)).rejects.toThrow('policy denied');
    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('does not resend an existing or conflicting action ID', async () => {
    ledger.reserve.mockResolvedValueOnce({
      kind: 'existing',
      state: 'unknown',
      providerObjectUuid: null,
      failureStatus: null,
    });
    await expect(service.sendText(input)).resolves.toEqual({ state: 'unknown' });
    ledger.reserve.mockResolvedValueOnce({ kind: 'conflict' });
    await expect(service.sendText({ ...input, text: 'Changed' })).rejects.toThrow('conflicts');
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(ledger.settle).not.toHaveBeenCalled();
  });

  it.each([400, 403, 429])('settles definite HTTP %i as failed', async (status) => {
    client.sendMessage.mockRejectedValueOnce(new FanvueRequestError(status));
    await expect(service.sendText(input)).resolves.toEqual({
      state: 'failed',
      failureStatus: status,
    });
  });

  it('settles timeout as unknown without retrying the send', async () => {
    client.sendMessage.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.sendText(input)).resolves.toEqual({ state: 'unknown' });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(ledger.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: { state: 'unknown' } }),
    );
  });

  it('sends selected ready provider media for free or native paid unlock with preview', async () => {
    await expect(
      service.sendMessage({ ...input, text: undefined, mediaUuids: [mediaUuid] }),
    ).resolves.toEqual({ state: 'confirmed', messageUuid });
    expect(reads.getMediaStatus).toHaveBeenCalledWith({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      mediaUuid,
    });
    expect(client.sendMessage).toHaveBeenCalledWith('token', input.fanUuid, {
      mediaUuids: [mediaUuid],
    });
    await expect(
      service.sendMessage({
        ...input,
        clientActionId: mediaUuid,
        text: 'Unlock',
        mediaUuids: [mediaUuid],
        price: 300,
        mediaPreviewUuid: mediaUuid,
      }),
    ).resolves.toEqual({ state: 'confirmed', messageUuid });
    expect(client.sendMessage).toHaveBeenLastCalledWith('token', input.fanUuid, {
      text: 'Unlock',
      mediaUuids: [mediaUuid],
      price: 300,
      mediaPreviewUuid: mediaUuid,
    });
    expect(ledger.reserve).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ textBody: 'Unlock', mediaCount: 1, priceCents: 300 }),
    );
  });

  it('refuses not-ready or invalid paid media before reserving a send intent', async () => {
    reads.getMediaStatus.mockResolvedValueOnce({ uuid: mediaUuid, status: 'processing' });
    await expect(service.sendMessage({ ...input, mediaUuids: [mediaUuid] })).rejects.toThrow(
      'not ready',
    );
    await expect(
      service.sendMessage({ ...input, mediaUuids: [mediaUuid], price: 299 }),
    ).rejects.toThrow();
    await expect(
      service.sendMessage({ ...input, mediaUuids: [mediaUuid], mediaPreviewUuid: mediaUuid }),
    ).rejects.toThrow();
    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('resolves exact ready local media through the same free and paid send command', async () => {
    await expect(
      service.sendMessage({ ...input, text: undefined, mediaIds: [localMediaId] }),
    ).resolves.toEqual({ state: 'confirmed', messageUuid });
    expect(readyMedia.get).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      clientActionId: input.clientActionId,
      mediaIds: [localMediaId],
    });
    expect(client.sendMessage).toHaveBeenCalledWith('token', input.fanUuid, {
      mediaUuids: [mediaUuid],
    });
    await expect(
      service.sendMessage({
        ...input,
        clientActionId: localMediaId,
        mediaIds: [localMediaId],
        mediaPreviewId: localMediaId,
        price: 300,
      }),
    ).resolves.toEqual({ state: 'confirmed', messageUuid });
    expect(client.sendMessage).toHaveBeenLastCalledWith('token', input.fanUuid, {
      text: 'Hello',
      mediaUuids: [mediaUuid],
      mediaPreviewUuid: mediaUuid,
      price: 300,
    });
  });

  it('denies missing or mixed local media before reserving a send intent', async () => {
    readyMedia.get.mockResolvedValueOnce(new Map());
    await expect(service.sendMessage({ ...input, mediaIds: [localMediaId] })).rejects.toThrow(
      'not ready',
    );
    await expect(
      service.sendMessage({ ...input, mediaIds: [localMediaId], mediaUuids: [mediaUuid] }),
    ).rejects.toThrow();
    await expect(
      service.sendMessage({ ...input, mediaIds: [localMediaId], mediaPreviewId: localMediaId }),
    ).rejects.toThrow();
    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});

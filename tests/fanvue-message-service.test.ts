import { beforeEach, describe, expect, it, vi } from 'vitest';

const ledger = vi.hoisted(() => ({ reserve: vi.fn(), settle: vi.fn() }));
const policy = vi.hoisted(() => ({ enforce: vi.fn(() => Promise.resolve()) }));
const readyMedia = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../src/database/tenant-transaction.js', () => ({
  withTenantTransaction: (_db: unknown, _input: unknown, work: (transaction: unknown) => unknown) =>
    work({}),
}));
vi.mock('../src/modules/policy/action-policy.js', () => ({
  enforceWorkspaceAction: policy.enforce,
}));
vi.mock('../src/modules/providers/fanvue-action-intent.repository.js', () => ({
  reserveFanvueAction: ledger.reserve,
  settleFanvueAction: ledger.settle,
}));
vi.mock('../src/modules/providers/fanvue-dm-ready-media.repository.js', () => ({
  getReadyFanvueDmMedia: readyMedia.get,
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
  getExistingChatForMessage: vi.fn(() => {
    events.push('preflight');
    return Promise.resolve({ accessToken: 'token' });
  }),
  getMediaStatus: vi.fn(() => Promise.resolve({ uuid: mediaUuid, status: 'ready' })),
};
const client = {
  sendMessage: vi.fn(() => {
    events.push('send');
    return Promise.resolve({ messageUuid });
  }),
};
const service = new FanvueMessageService({} as never, reads as never, client as never, {} as never);

beforeEach(() => {
  vi.clearAllMocks();
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

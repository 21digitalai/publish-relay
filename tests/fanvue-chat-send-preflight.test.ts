import { describe, expect, it, vi } from 'vitest';

import {
  FanvueReadService,
  FanvueReadUnavailableError,
} from '../src/modules/providers/fanvue-read.service.js';

const input = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  fanUuid: '00000000-0000-4000-8000-000000000003',
};

function fixture(data: unknown[]) {
  const accessToken = vi.fn().mockResolvedValue('token');
  const listMessages = vi.fn().mockResolvedValue({ data });
  const getMediaPurchaseFact = vi.fn().mockResolvedValue({ purchasedByFan: true });
  const service = new FanvueReadService({} as never, {} as never, {} as never, {} as never);
  Reflect.set(service, 'accessToken', accessToken);
  Reflect.set(service, 'readClient', { listMessages, getMediaPurchaseFact });
  return { service, accessToken, listMessages, getMediaPurchaseFact };
}

describe('Fanvue existing-chat send preflight', () => {
  it('requires read and write chat scopes for the selected account and counterpart', async () => {
    const context = fixture([
      {
        sender: { uuid: input.fanUuid },
        recipient: { uuid: '00000000-0000-4000-8000-000000000004' },
      },
    ]);
    await expect(context.service.getExistingChatForMessage(input)).resolves.toEqual({
      accessToken: 'token',
      targetLabel: null,
    });
    expect(context.accessToken).toHaveBeenCalledWith(input, 'chat', ['write:chat']);
    expect(context.listMessages).toHaveBeenCalledWith('token', input.fanUuid, { size: 1 });
  });

  it('captures only the selected counterpart handle as a friendly send target', async () => {
    const context = fixture([
      {
        sender: { uuid: '00000000-0000-4000-8000-000000000004' },
        recipient: { uuid: input.fanUuid, handle: 'alexandra' },
      },
    ]);
    await expect(context.service.getExistingChatForMessage(input)).resolves.toMatchObject({
      targetLabel: '@alexandra',
    });
  });

  it('proves purchase facts with read chat and media scopes without write chat', async () => {
    const context = fixture([
      {
        sender: { uuid: input.fanUuid },
        recipient: { uuid: '00000000-0000-4000-8000-000000000004' },
      },
    ]);
    await expect(
      context.service.getMediaPurchaseFact({
        ...input,
        mediaUuid: '00000000-0000-4000-8000-000000000005',
      }),
    ).resolves.toEqual({ state: 'known', purchasedByFan: true });
    expect(context.accessToken).toHaveBeenCalledWith(
      expect.objectContaining(input),
      'chat',
      ['read:media'],
    );
    expect(context.getMediaPurchaseFact).toHaveBeenCalledWith(
      'token',
      '00000000-0000-4000-8000-000000000005',
      input.fanUuid,
    );
  });

  it('refuses empty or mismatched chat evidence', async () => {
    for (const data of [
      [],
      [
        {
          sender: { uuid: '00000000-0000-4000-8000-000000000004' },
          recipient: { uuid: '00000000-0000-4000-8000-000000000005' },
        },
      ],
    ]) {
      const context = fixture(data);
      await expect(context.service.getExistingChatForMessage(input)).rejects.toBeInstanceOf(
        FanvueReadUnavailableError,
      );
    }
  });
});

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
  const service = new FanvueReadService({} as never, {} as never, {} as never, {} as never);
  Reflect.set(service, 'accessToken', accessToken);
  Reflect.set(service, 'readClient', { listMessages });
  return { service, accessToken, listMessages };
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
    });
    expect(context.accessToken).toHaveBeenCalledWith(input, 'chat', ['write:chat']);
    expect(context.listMessages).toHaveBeenCalledWith('token', input.fanUuid, { size: 1 });
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

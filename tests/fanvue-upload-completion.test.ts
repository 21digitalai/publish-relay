import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ reserve: vi.fn(), confirm: vi.fn() }));
vi.mock('../src/modules/providers/fanvue-upload-progress.repository.js', () => ({
  reserveFanvueUploadCompletion: mock.reserve,
  confirmFanvueUploadCompletion: mock.confirm,
}));
vi.mock('../src/modules/content/provider-staging-lock.js', () => ({
  withProviderStagingLock: async (_database: unknown, _id: string, work: () => Promise<void>) =>
    work(),
}));

import { completeFanvueUpload } from '../src/modules/providers/fanvue-upload-completion.service.js';

const session = {
  uploadId: 'upload-one',
  mediaUuid: '00000000-0000-4000-8000-000000000001',
  byteSize: 5,
  partSize: 5,
  partCount: 1,
  parts: [{ PartNumber: 1, ETag: 'etag-one' }],
};
const input = {
  workspaceId: 'workspace',
  jobId: 'job',
  mediaId: 'media',
  artifactId: 'artifact',
  leaseOwner: 'worker',
  credentialId: 'credential',
  credentialVersion: 2,
  session,
  accessToken: 'token',
};
const events: string[] = [];
const client = {
  completeSession: vi.fn(() => {
    events.push('patch');
    return Promise.resolve({ status: 'processing' });
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  mock.reserve.mockImplementation(() => {
    events.push('reserve');
    return Promise.resolve(true);
  });
  mock.confirm.mockImplementation(() => {
    events.push('confirm');
    return Promise.resolve(true);
  });
});

describe('Fanvue upload completion', () => {
  it('reserves durable intent before one provider PATCH and confirms afterward', async () => {
    await completeFanvueUpload({} as never, client as never, {} as never, input);
    expect(events).toEqual(['reserve', 'patch', 'confirm']);
    expect(client.completeSession).toHaveBeenCalledWith('token', 'upload-one', session.parts);
  });

  it('never sends when completion is unreserved or parts are incomplete', async () => {
    mock.reserve.mockResolvedValue(false);
    await expect(
      completeFanvueUpload({} as never, client as never, {} as never, input),
    ).rejects.toThrow('not eligible');
    await expect(
      completeFanvueUpload({} as never, client as never, {} as never, {
        ...input,
        session: { ...session, parts: [] },
      }),
    ).rejects.toThrow('parts are incomplete');
    expect(client.completeSession).not.toHaveBeenCalled();
  });

  it('leaves a possibly sent completion pending on transport failure', async () => {
    client.completeSession.mockRejectedValueOnce(new Error('timeout'));
    await expect(
      completeFanvueUpload({} as never, client as never, {} as never, input),
    ).rejects.toThrow('timeout');
    expect(events).toEqual(['reserve']);
    expect(mock.confirm).not.toHaveBeenCalled();
  });

  it('does not record processing when the provider reports an error status', async () => {
    client.completeSession.mockResolvedValueOnce({ status: 'error' });
    await expect(
      completeFanvueUpload({} as never, client as never, {} as never, input),
    ).rejects.toThrow('not confirmed');
    expect(events).toEqual(['reserve']);
    expect(client.completeSession).toHaveBeenCalledTimes(1);
    expect(mock.confirm).not.toHaveBeenCalled();
  });
});

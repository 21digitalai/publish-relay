import { beforeEach, describe, expect, it, vi } from 'vitest';

const stage = vi.hoisted(() => ({
  bind: vi.fn(),
  state: vi.fn(),
  init: vi.fn(),
  session: vi.fn(),
  part: vi.fn(),
  complete: vi.fn(),
  readiness: vi.fn(),
}));
vi.mock('../src/modules/providers/fanvue-dm-attachment.repository.js', () => ({
  bindFanvueDmAttachment: stage.bind,
  getFanvueDmAttachmentState: stage.state,
}));
vi.mock('../src/modules/providers/fanvue-dm-upload-init.service.js', () => ({
  initializeFanvueDmUpload: stage.init,
}));
vi.mock('../src/modules/providers/fanvue-dm-upload-source.js', () => ({
  loadFanvueDmUploadSession: stage.session,
}));
vi.mock('../src/modules/providers/fanvue-dm-upload-part.service.js', () => ({
  uploadFanvueDmPart: stage.part,
}));
vi.mock('../src/modules/providers/fanvue-dm-upload-completion.service.js', () => ({
  completeFanvueDmUpload: stage.complete,
}));
vi.mock('../src/modules/providers/fanvue-dm-upload-readiness.service.js', () => ({
  refreshFanvueDmReadiness: stage.readiness,
}));

import { stageFanvueDmMediaStep } from '../src/modules/providers/fanvue-dm-stage-step.service.js';

const input = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  clientActionId: '00000000-0000-4000-8000-000000000003',
  mediaId: '00000000-0000-4000-8000-000000000004',
};
const reads = { getDmMediaUploadToken: vi.fn() };
const advance = () =>
  stageFanvueDmMediaStep({} as never, {} as never, {} as never, {} as never, reads, input);

beforeEach(() => {
  vi.clearAllMocks();
  reads.getDmMediaUploadToken.mockResolvedValue('creator-token');
  stage.bind.mockResolvedValue(true);
  stage.init.mockResolvedValue({ state: 'uploading' });
  stage.session.mockResolvedValue({ session: { parts: [], partCount: 2 } });
  stage.readiness.mockResolvedValue(false);
});

describe('Fanvue DM bounded upload progression', () => {
  it('requires selected account media/chat consent before binding', async () => {
    reads.getDmMediaUploadToken.mockRejectedValueOnce(new Error('scope missing'));
    await expect(advance()).rejects.toThrow('scope missing');
    expect(stage.bind).not.toHaveBeenCalled();
  });

  it('starts a bound upload, advances one confirmed part, then one completion', async () => {
    stage.state.mockResolvedValueOnce('bound');
    await expect(advance()).resolves.toBe('uploading');
    expect(stage.init).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { ...input, accessToken: 'creator-token' },
    );
    expect(stage.part).not.toHaveBeenCalled();

    stage.state.mockResolvedValueOnce('uploading');
    stage.session.mockResolvedValueOnce({ session: { parts: [{}], partCount: 2 } });
    await expect(advance()).resolves.toBe('uploading');
    expect(stage.part).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { ...input, partNumber: 2, accessToken: 'creator-token' },
    );

    stage.state.mockResolvedValueOnce('uploading');
    stage.session.mockResolvedValueOnce({ session: { parts: [{}, {}], partCount: 2 } });
    await expect(advance()).resolves.toBe('processing');
    expect(stage.complete).toHaveBeenCalledTimes(1);
  });

  it('polls processing once and never resends unknown, failed, or ready media', async () => {
    stage.state.mockResolvedValueOnce('processing');
    await expect(advance()).resolves.toBe('processing');
    stage.state.mockResolvedValueOnce('processing');
    stage.readiness.mockResolvedValueOnce(true);
    await expect(advance()).resolves.toBe('ready');
    for (const state of ['unknown', 'failed', 'ready']) {
      stage.state.mockResolvedValueOnce(state);
      await expect(advance()).resolves.toBe(state);
    }
    expect(stage.init).not.toHaveBeenCalled();
    expect(stage.part).not.toHaveBeenCalled();
    expect(stage.complete).not.toHaveBeenCalled();
    expect(stage.readiness).toHaveBeenCalledTimes(2);
  });
});

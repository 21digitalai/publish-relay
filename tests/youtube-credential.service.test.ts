import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/tenant-transaction.js', () => ({
  withTenantTransaction: vi.fn(
    (_database: unknown, _tenant: unknown, callback: (transaction: unknown) => unknown) =>
      callback({}),
  ),
}));
vi.mock('../src/modules/credentials/credential.repository.js', () => ({
  getActiveCredential: vi.fn(),
  rotateCredential: vi.fn(),
}));
vi.mock('../src/modules/credentials/envelope.js', () => ({
  decryptCredential: vi.fn(),
  encryptCredential: vi.fn(),
}));

import { getActiveCredential, rotateCredential } from '../src/modules/credentials/credential.repository.js';
import { decryptCredential, encryptCredential } from '../src/modules/credentials/envelope.js';
import { getFreshYouTubeCredential } from '../src/modules/providers/youtube-credential.service.js';

const current = {
  accessToken: 'old-access',
  refreshToken: 'refresh',
  expiresAt: '2026-09-08T00:00:00.000Z',
};
const fresh = {
  accessToken: 'new-access',
  refreshToken: 'refresh',
  expiresAt: '2026-09-08T02:00:00.000Z',
};

describe('getFreshYouTubeCredential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveCredential).mockResolvedValue({ id: 'credential', version: 3 } as never);
    vi.mocked(decryptCredential).mockResolvedValue(Buffer.from(JSON.stringify(current)));
    vi.mocked(encryptCredential).mockResolvedValue({ ciphertext: Buffer.from('encrypted') } as never);
    vi.mocked(rotateCredential).mockResolvedValue({ id: 'credential', version: 4 } as never);
  });

  it('refreshes an expiring token with an optimistic version rotation', async () => {
    const client = { refresh: vi.fn().mockResolvedValue(fresh) };
    await expect(
      getFreshYouTubeCredential({} as never, {} as never, client as never, {
        workspaceId: 'workspace',
        credentialId: 'credential',
        now: new Date('2026-09-08T00:00:00.000Z'),
      }),
    ).resolves.toEqual(fresh);
    expect(rotateCredential).toHaveBeenCalledWith(
      expect.anything(),
      'workspace',
      'credential',
      3,
      expect.anything(),
    );
  });

  it('uses the winning refreshed token when a concurrent rotation wins', async () => {
    vi.mocked(rotateCredential).mockResolvedValue(null);
    vi.mocked(decryptCredential)
      .mockResolvedValueOnce(Buffer.from(JSON.stringify(current)))
      .mockResolvedValueOnce(Buffer.from(JSON.stringify(fresh)));
    const client = { refresh: vi.fn().mockResolvedValue(fresh) };
    await expect(
      getFreshYouTubeCredential({} as never, {} as never, client as never, {
        workspaceId: 'workspace',
        credentialId: 'credential',
        now: new Date('2026-09-08T00:00:00.000Z'),
      }),
    ).resolves.toEqual(fresh);
    expect(getActiveCredential).toHaveBeenCalledTimes(2);
  });
});

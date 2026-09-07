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
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
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

  it('does not refresh a token outside the skew window', async () => {
    vi.mocked(decryptCredential).mockResolvedValue(
      Buffer.from(JSON.stringify({ ...current, expiresAt: '2026-09-08T00:01:00.001Z' })),
    );
    const client = { refresh: vi.fn() };
    await expect(
      getFreshYouTubeCredential({} as never, {} as never, client as never, {
        workspaceId: 'workspace', credentialId: 'credential', now: new Date('2026-09-08T00:00:00.000Z'),
      }),
    ).resolves.toMatchObject({ accessToken: 'old-access' });
    expect(client.refresh).not.toHaveBeenCalled();
  });

  it('refreshes at the exact skew boundary and passes tenant/version predicates', async () => {
    vi.mocked(decryptCredential).mockResolvedValue(
      Buffer.from(JSON.stringify({ ...current, expiresAt: '2026-09-08T00:01:00.000Z' })),
    );
    const client = { refresh: vi.fn().mockResolvedValue(fresh) };
    await getFreshYouTubeCredential({} as never, {} as never, client as never, {
      workspaceId: 'workspace', credentialId: 'credential', now: new Date('2026-09-08T00:00:00.000Z'),
    });
    expect(withTenantTransaction).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'workspace' }, expect.any(Function));
    expect(rotateCredential).toHaveBeenCalledWith(expect.anything(), 'workspace', 'credential', 3, expect.anything());
  });

  it('zeroes decrypted and refreshed plaintext buffers', async () => {
    const decrypted = Buffer.from(JSON.stringify(current));
    let serialized: Buffer | undefined;
    vi.mocked(decryptCredential).mockResolvedValue(decrypted);
    vi.mocked(encryptCredential).mockImplementation((value) => {
      serialized = value;
      return Promise.resolve({ ciphertext: Buffer.from('encrypted') } as never);
    });
    await getFreshYouTubeCredential({} as never, {} as never, { refresh: vi.fn().mockResolvedValue(fresh) } as never, {
      workspaceId: 'workspace', credentialId: 'credential', now: new Date('2026-09-08T00:00:00.000Z'),
    });
    expect([...decrypted].every((byte) => byte === 0)).toBe(true);
    expect(serialized && [...serialized].every((byte) => byte === 0)).toBe(true);
  });

  it('zeroes refreshed plaintext when encryption fails without exposing tokens', async () => {
    let serialized: Buffer | undefined;
    vi.mocked(encryptCredential).mockImplementation((value) => {
      serialized = value;
      return Promise.reject(new Error('encryption failed'));
    });
    await expect(getFreshYouTubeCredential({} as never, {} as never, { refresh: vi.fn().mockResolvedValue(fresh) } as never, {
      workspaceId: 'workspace', credentialId: 'credential', now: new Date('2026-09-08T00:00:00.000Z'),
    })).rejects.toThrow('encryption failed');
    expect(serialized && [...serialized].every((byte) => byte === 0)).toBe(true);
  });

  it('fails closed when a concurrent winner remains inside the skew window', async () => {
    vi.mocked(rotateCredential).mockResolvedValue(null);
    vi.mocked(decryptCredential)
      .mockResolvedValueOnce(Buffer.from(JSON.stringify(current)))
      .mockResolvedValueOnce(Buffer.from(JSON.stringify({ ...fresh, expiresAt: '2026-09-08T00:00:59.999Z' })));
    await expect(getFreshYouTubeCredential({} as never, {} as never, { refresh: vi.fn().mockResolvedValue(fresh) } as never, {
      workspaceId: 'workspace', credentialId: 'credential', now: new Date('2026-09-08T00:00:00.000Z'),
    })).rejects.toThrow('did not produce a usable token');
  });

  it('fails safely for missing and malformed credentials', async () => {
    vi.mocked(getActiveCredential).mockResolvedValueOnce(null);
    await expect(getFreshYouTubeCredential({} as never, {} as never, {} as never, {
      workspaceId: 'workspace', credentialId: 'credential',
    })).rejects.toThrow('credential is unavailable');
    vi.mocked(getActiveCredential).mockResolvedValueOnce({ id: 'credential', version: 3 } as never);
    vi.mocked(decryptCredential).mockResolvedValueOnce(Buffer.from('{malformed'));
    await expect(getFreshYouTubeCredential({} as never, {} as never, {} as never, {
      workspaceId: 'workspace', credentialId: 'credential',
    })).rejects.not.toThrow(/old-access|refresh/);
  });
});

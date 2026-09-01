import { describe, expect, it, vi } from 'vitest';

import {
  importLegacyXCredential,
  parseLegacyXCredential,
} from '../src/modules/providers/x-legacy-credential-import.js';

describe('legacy X credential import', () => {
  it('converts one opaque delimiter without changing either half', () => {
    expect(parseLegacyXCredential('token-value:secret-value\n')).toBe(
      JSON.stringify({ accessToken: 'token-value', accessTokenSecret: 'secret-value' }),
    );
  });

  it.each(['', 'missing-delimiter', ':secret', 'token:', 'one:two:three'])(
    'rejects malformed credential shape',
    (value) => {
      expect(() => parseLegacyXCredential(value)).toThrow(/exactly one non-empty/);
    },
  );

  it('refuses the wrong account before attempting persistence', async () => {
    const currentAccount = vi
      .fn()
      .mockResolvedValue({ id: 'x-1', name: 'Wrong', username: 'wrong' });
    await expect(
      importLegacyXCredential({} as never, {} as never, { currentAccount } as never, {
        workspaceId: 'workspace',
        userId: 'user',
        sourceIntegrationId: 'integration',
        expectedUsername: '@TheDailyViber',
        credentialValue: 'token:secret',
        requestId: 'request',
      }),
    ).rejects.toThrow(/did not match/);
    expect(currentAccount).toHaveBeenCalledOnce();
  });
});

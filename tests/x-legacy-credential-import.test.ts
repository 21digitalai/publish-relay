import { spawnSync } from 'node:child_process';

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
        approvedSourceIntegrationId: 'integration',
        expectedUsername: '@TheDailyViber',
        credentialValue: 'token:secret',
        requestId: 'request',
      }),
    ).rejects.toThrow(/did not match/);
    expect(currentAccount).toHaveBeenCalledOnce();
  });

  it('refuses an integration not bound by approved runtime configuration', async () => {
    const currentAccount = vi.fn();
    await expect(
      importLegacyXCredential({} as never, {} as never, { currentAccount } as never, {
        workspaceId: 'workspace',
        userId: 'user',
        sourceIntegrationId: 'unapproved',
        approvedSourceIntegrationId: 'approved',
        expectedUsername: 'TheDailyViber',
        credentialValue: 'token:secret',
        requestId: 'request',
      }),
    ).rejects.toThrow(/not approved/);
    expect(currentAccount).not.toHaveBeenCalled();
  });

  it('redacts credential material at the administrative process boundary', () => {
    const sentinel = 'SENTINEL_TOKEN:SENTINEL_SECRET:INVALID';
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/entrypoints/import-legacy-x-credential.ts',
        '--workspace-id',
        'workspace',
        '--user-id',
        'user',
        '--source-integration-id',
        'integration',
        '--expected-username',
        'TheDailyViber',
      ],
      {
        cwd: process.cwd(),
        input: sentinel,
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://localhost:1/unreachable',
          PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION: 'V1',
          PUBLISH_RELAY_MASTER_KEY_V1: Buffer.alloc(32).toString('base64'),
          X_API_KEY: 'consumer-key',
          X_API_SECRET: 'consumer-secret',
          PUBLISH_RELAY_APPROVED_LEGACY_X_INTEGRATION_ID: 'integration',
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('SENTINEL');
    expect(result.stderr).toBe('Legacy X credential import failed\n');
  });
});

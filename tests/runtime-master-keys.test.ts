import { describe, expect, it } from 'vitest';

import { loadRuntimeConfig, resolveWorkerDatabaseUrl } from '../src/config/runtime-config.js';
import { RuntimeMasterKeyProvider } from '../src/config/runtime-master-keys.js';

describe('production runtime secret configuration', () => {
  it('loads the active and historical master-key versions without exposing their values', async () => {
    const active = Buffer.alloc(32, 1).toString('base64');
    const old = Buffer.alloc(32, 2).toString('base64');
    const keys = new RuntimeMasterKeyProvider('v2', {
      PUBLISH_RELAY_MASTER_KEY_v1: old,
      PUBLISH_RELAY_MASTER_KEY_v2: active,
    });
    expect(keys.currentVersion()).toBe('v2');
    await expect(keys.getKey('v1')).resolves.toEqual(Buffer.alloc(32, 2));
    await expect(keys.getKey('v2')).resolves.toEqual(Buffer.alloc(32, 1));
  });

  it.each([
    ['missing', undefined],
    ['short', Buffer.alloc(31).toString('base64')],
  ])('fails closed for a %s active key', (_case, value) => {
    expect(
      () => new RuntimeMasterKeyProvider('v1', { PUBLISH_RELAY_MASTER_KEY_v1: value }),
    ).toThrow(/Master key version v1/);
  });

  it('requires the approved X and HTTPS origin contract in production', () => {
    expect(() => loadRuntimeConfig({ NODE_ENV: 'production' })).toThrow();
    expect(() =>
      loadRuntimeConfig({
        NODE_ENV: 'production',
        PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION: 'v1',
        PUBLISH_RELAY_X_CONSUMER_KEY: 'consumer',
        PUBLISH_RELAY_X_CONSUMER_SECRET: 'secret',
        PUBLISH_RELAY_PUBLIC_ORIGIN: 'http://relay.example.test',
      }),
    ).toThrow(/HTTPS/);
  });

  it('requires a distinct worker database URL in production', () => {
    const production = loadRuntimeConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://web@127.0.0.1/publish_relay',
      PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION: 'v1',
      PUBLISH_RELAY_X_CONSUMER_KEY: 'consumer',
      PUBLISH_RELAY_X_CONSUMER_SECRET: 'secret',
      PUBLISH_RELAY_PUBLIC_ORIGIN: 'https://relay.example.test',
    });
    expect(() => resolveWorkerDatabaseUrl(production)).toThrow(/WORKER_DATABASE_URL/);
    expect(
      resolveWorkerDatabaseUrl({
        ...production,
        WORKER_DATABASE_URL: 'postgresql://worker@127.0.0.1/publish_relay',
      }),
    ).toBe('postgresql://worker@127.0.0.1/publish_relay');
  });

  it('allows the development worker to reuse DATABASE_URL', () => {
    const development = loadRuntimeConfig({
      DATABASE_URL: 'postgresql://development@127.0.0.1/publish_relay',
    });
    expect(resolveWorkerDatabaseUrl(development)).toBe(
      'postgresql://development@127.0.0.1/publish_relay',
    );
  });
});

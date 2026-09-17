import { describe, expect, it } from 'vitest';

import {
  loadRuntimeConfig,
  resolveWorkerDatabaseUrl,
  resolveXProviderCredentials,
} from '../src/config/runtime-config.js';
import {
  RuntimeMasterKeyProvider,
  resolveWorkerSecurityRuntime,
} from '../src/config/runtime-master-keys.js';

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

  it('requires the common master-key and HTTPS origin contract in production', () => {
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

  it('disables X when absent and fails closed for partial provider configuration', () => {
    const production = loadRuntimeConfig({
      NODE_ENV: 'production',
      PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION: 'v1',
      PUBLISH_RELAY_PUBLIC_ORIGIN: 'https://relay.example.test',
    });
    expect(resolveXProviderCredentials(production)).toBeNull();
    expect(() =>
      resolveXProviderCredentials({ ...production, PUBLISH_RELAY_X_CONSUMER_KEY: 'consumer' }),
    ).toThrow(/same namespace/);
    expect(() =>
      resolveXProviderCredentials({
        ...production,
        PUBLISH_RELAY_X_CONSUMER_KEY: 'current-key',
        X_API_SECRET: 'legacy-secret',
      }),
    ).toThrow(/same namespace/);
    expect(
      resolveXProviderCredentials({
        ...production,
        PUBLISH_RELAY_X_CONSUMER_KEY: 'consumer',
        PUBLISH_RELAY_X_CONSUMER_SECRET: 'secret',
      }),
    ).toEqual({ consumerKey: 'consumer', consumerSecret: 'secret' });
    expect(
      resolveXProviderCredentials({
        ...production,
        PUBLISH_RELAY_X_CONSUMER_KEY: 'current-key',
        PUBLISH_RELAY_X_CONSUMER_SECRET: 'current-secret',
        X_API_KEY: 'legacy-key',
        X_API_SECRET: 'legacy-secret',
      }),
    ).toEqual({ consumerKey: 'current-key', consumerSecret: 'current-secret' });
    const environment = { PUBLISH_RELAY_MASTER_KEY_v1: Buffer.alloc(32, 3).toString('base64') };
    expect(resolveWorkerSecurityRuntime(production, environment).xCredentials).toBeNull();
    expect(() => resolveWorkerSecurityRuntime(production, {})).toThrow(/Master key version v1/);
    expect(() =>
      resolveWorkerSecurityRuntime(production, {
        PUBLISH_RELAY_MASTER_KEY_v1: Buffer.alloc(31).toString('base64'),
      }),
    ).toThrow(/exactly 32 base64 bytes/);
  });

  it('requires a complete Meta app pair and pinned Graph version', () => {
    expect(() => loadRuntimeConfig({ NODE_ENV: 'test', PUBLISH_RELAY_META_APP_ID: 'app' })).toThrow(
      /both app ID and app secret/,
    );
    expect(() =>
      loadRuntimeConfig({
        NODE_ENV: 'test',
        PUBLISH_RELAY_META_APP_ID: 'app',
        PUBLISH_RELAY_META_APP_SECRET: 'secret',
      }),
    ).toThrow(/pinned Meta Graph API version/);
    expect(
      loadRuntimeConfig({
        NODE_ENV: 'test',
        PUBLISH_RELAY_META_APP_ID: 'app',
        PUBLISH_RELAY_META_APP_SECRET: 'secret',
        PUBLISH_RELAY_META_GRAPH_VERSION: 'v23.0',
      }),
    ).toMatchObject({ PUBLISH_RELAY_META_GRAPH_VERSION: 'v23.0' });
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

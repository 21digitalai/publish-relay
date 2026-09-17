import { describe, expect, it, vi } from 'vitest';

import {
  auditEvents,
  delegatedAuthorizationCodes,
  delegatedGrants,
} from '../src/database/schema.js';
import { createPostgresDelegatedAuthorizationStore } from '../src/modules/delegated-authorization/delegated-authorization.repository.js';

vi.mock('../src/database/tenant-transaction.js', () => ({
  withTenantTransaction: async (
    _database: unknown,
    _options: unknown,
    operation: (transaction: unknown) => Promise<unknown>,
  ) => operation(transaction),
}));

const scopes = [
  'destinations:read',
  'schedules:read',
  'schedules:write',
  'content:write',
  'publishes:retry',
];
const inserted = new Map<unknown, unknown>();
const transaction = {
  insert: vi.fn((table: unknown) => ({
    values: vi.fn((value: unknown) => {
      inserted.set(table, value);
      return Promise.resolve();
    }),
  })),
};

describe('delegated authorization repository', () => {
  it('binds the approved five scopes through typed PostgreSQL array columns', async () => {
    inserted.clear();
    transaction.insert.mockClear();
    const store = createPostgresDelegatedAuthorizationStore({} as never);

    await store.createGrantAndCode({
      requestId: 'request-1',
      grantId: '00000000-0000-4000-8000-000000000001',
      workspaceId: '00000000-0000-4000-8000-000000000002',
      userId: '00000000-0000-4000-8000-000000000003',
      clientId: 'example-client-dev',
      codeHash: 'code-hash',
      redirectUri: 'http://127.0.0.1:43123/callback',
      scopes,
      codeChallenge: 'challenge',
      expiresAt: new Date('2026-09-11T06:30:00Z'),
    });

    expect(transaction.insert).toHaveBeenCalledWith(delegatedGrants);
    expect(transaction.insert).toHaveBeenCalledWith(delegatedAuthorizationCodes);
    expect(transaction.insert).toHaveBeenCalledWith(auditEvents);
    expect(inserted.get(delegatedGrants)).toMatchObject({ scopes });
    expect(inserted.get(delegatedAuthorizationCodes)).toMatchObject({ scopes });
  });
});

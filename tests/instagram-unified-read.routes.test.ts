import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStandaloneApplication } from '../src/application/create-application.js';
import type { MasterKeyProvider } from '../src/modules/credentials/envelope.js';
import { AuthService, type AuthStore } from '../src/modules/identity/auth.service.js';

vi.mock('../src/modules/providers/instagram-unified-read.service.js', () => ({
  createInstagramUnifiedReadService: vi.fn(() => ({
    permissions: vi.fn(),
    media: vi.fn(),
    comments: vi.fn(),
    conversations: vi.fn(),
    messages: vi.fn(),
  })),
  instagramUnifiedReadStatus: vi.fn(() => ({ status: 502, error: 'Unified Instagram read failed' })),
}));

const applications: ReturnType<typeof createStandaloneApplication>[] = [];
afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
  vi.clearAllMocks();
});

function application() {
  const store = {
    register: vi.fn(),
    findLogin: vi.fn(),
    findReviewerLogin: vi.fn().mockResolvedValue(null),
    createSession: vi.fn(),
    revokeSessionsForUser: vi.fn(),
    revokeSession: vi.fn(),
    findSession: vi.fn().mockResolvedValue({
      userId: 'u1',
      workspaceId: 'w1',
      role: 'owner',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    }),
    findCurrentRole: vi.fn().mockResolvedValue('owner'),
    findShellProfile: vi.fn(),
    findWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    listWorkspaces: vi.fn(),
    rotateWorkspaceSession: vi.fn(),
    createWorkspace: vi.fn(),
    reorderWorkspaces: vi.fn(),
    deleteWorkspace: vi.fn(),
  } as AuthStore;
  const keys: MasterKeyProvider = {
    currentVersion: () => 'v1',
    getKey: () => Promise.resolve(Buffer.alloc(32)),
  };
  const app = createStandaloneApplication({
    config: { NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 3100, WORKER_POLL_INTERVAL_MS: 1000 },
    auth: new AuthService(store),
    database: {} as NodePgDatabase,
    instagramUnifiedOauth: {
      keys,
      client: {} as never,
      readClient: {} as never,
      callbackUrl: 'https://relay.test/callback',
    },
  });
  applications.push(app);
  return app;
}

describe('Instagram Unified read route boundaries', () => {
  it('rejects unauthenticated browser reads before loading an account', async () => {
    const response = await application().inject({
      method: 'GET',
      url: '/api/provider-accounts/00000000-0000-0000-0000-000000000001/instagram-unified/status',
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects malformed account and pagination input before invoking the read service', async () => {
    const response = await application().inject({
      method: 'GET',
      url: '/api/provider-accounts/not-a-uuid/instagram-unified-media?limit=101',
      headers: { cookie: 'publish_relay_session=w1.token' },
    });
    expect(response.statusCode).toBe(400);
    expect((JSON.parse(response.body) as { error: string }).error).toBe(
      'Invalid Unified Instagram read query',
    );
  });
});

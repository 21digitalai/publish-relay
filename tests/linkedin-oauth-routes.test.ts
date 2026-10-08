import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/providers/linkedin-oauth.service.js', () => ({
  beginLinkedInConnection: vi.fn(),
  completeLinkedInConnection: vi.fn(),
  failLinkedInConnection: vi.fn(),
  LinkedInMemberMismatchError: class LinkedInMemberMismatchError extends Error {},
}));

import { createStandaloneApplication } from '../src/application/create-application.js';
import type { MasterKeyProvider } from '../src/modules/credentials/envelope.js';
import { AuthService, type AuthStore } from '../src/modules/identity/auth.service.js';
import { allowAllActionPolicy } from '../src/modules/policy/action-policy.js';
import { LinkedInRequestError } from '../src/modules/providers/linkedin-http-client.js';
import {
  completeLinkedInConnection,
  failLinkedInConnection,
} from '../src/modules/providers/linkedin-oauth.service.js';

const applications = [] as ReturnType<typeof createStandaloneApplication>[];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(applications.splice(0).map((application) => application.close()));
});

function application() {
  const store = {
    findSession: vi.fn().mockResolvedValue({
      userId: 'u1',
      workspaceId: 'w1',
      role: 'owner',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    }),
    findCurrentRole: vi.fn().mockResolvedValue('owner'),
  } as unknown as AuthStore;
  const keys: MasterKeyProvider = {
    currentVersion: () => 'v1',
    getKey: () => Promise.resolve(Buffer.alloc(32)),
  };
  const app = createStandaloneApplication({
    config: { NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 3100, WORKER_POLL_INTERVAL_MS: 1000 },
    auth: new AuthService(store),
    database: {} as NodePgDatabase,
    actionPolicy: allowAllActionPolicy,
    linkedinOauth: {
      keys,
      client: {} as never,
      callbackUrl: 'https://relay.test/api/oauth/linkedin/callback',
    },
  });
  applications.push(app);
  return app;
}

const headers = { cookie: 'publish_relay_session=w1.token' };

describe('LinkedIn OAuth callback', () => {
  it('consumes denied state and shows only fixed permission guidance', async () => {
    vi.mocked(failLinkedInConnection).mockResolvedValue(true);
    const response = await application().inject({
      method: 'GET',
      url: '/api/oauth/linkedin/callback?state=secret-state&error=unauthorized_scope_error&error_description=Scope%20%26quot%3Bopenid%26quot%3B%20is%20not%20authorized%20secret-description',
      headers,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/app?oauth=linkedin-permission-unavailable');
    expect(response.body).not.toMatch(/secret-state|secret-description/);
    expect(failLinkedInConnection).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      workspaceId: 'w1',
      userId: 'u1',
      state: 'secret-state',
    });
  });

  it('uses generic guidance for unknown denials and expired state for replay', async () => {
    const app = application();
    vi.mocked(failLinkedInConnection)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const denied = await app.inject({
      method: 'GET',
      url: '/api/oauth/linkedin/callback?state=secret-state&error=unknown',
      headers,
    });
    const replayed = await app.inject({
      method: 'GET',
      url: '/api/oauth/linkedin/callback?state=secret-state&error=unauthorized_scope_error&error_description=Scope%20%26quot%3Bw_member_social%26quot%3B%20is%20not%20authorized',
      headers,
    });
    const expired = await app.inject({
      method: 'GET',
      url: '/api/oauth/linkedin/callback?state=secret-state&error=unknown',
      headers,
    });
    expect(denied.headers.location).toBe('/app?oauth=linkedin-denied');
    expect(replayed.headers.location).toBe('/app?oauth=linkedin-denied');
    expect(expired.headers.location).toBe('/app?oauth=linkedin-expired');
  });

  it('redirects successful and consumed success callbacks without exposing state or code', async () => {
    const app = application();
    vi.mocked(completeLinkedInConnection)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce(null);
    const first = await app.inject({
      method: 'GET',
      url: '/api/oauth/linkedin/callback?state=secret-state&code=secret-code',
      headers,
    });
    const replayed = await app.inject({
      method: 'GET',
      url: '/api/oauth/linkedin/callback?state=secret-state&code=secret-code',
      headers,
    });
    expect(first.headers.location).toBe('/app?oauth=linkedin-connected');
    expect(replayed.headers.location).toBe('/app?oauth=linkedin-expired');
  });

  it('hides a provider transport error behind fixed in-app guidance', async () => {
    vi.mocked(completeLinkedInConnection).mockRejectedValue(
      new LinkedInRequestError(400, 'validation', 'private provider detail'),
    );
    const response = await application().inject({
      method: 'GET',
      url: '/api/oauth/linkedin/callback?state=secret-state&code=secret-code',
      headers,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/app?oauth=linkedin-service-error');
    expect(response.body).not.toMatch(/private provider detail|secret-state|secret-code/);
  });
});

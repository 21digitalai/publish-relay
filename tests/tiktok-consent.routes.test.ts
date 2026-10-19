import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TikTokConsentInvalidError,
  TikTokConsentNotFoundError,
} from '../src/modules/providers/tiktok-consent.service.js';

const {
  authorizeRequest,
  verifyCsrfToken,
  issueTikTokPublicationConsentInTransaction,
  executeBrowserMutation,
  getTikTokPublicationConsent,
} = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  verifyCsrfToken: vi.fn(),
  issueTikTokPublicationConsentInTransaction: vi.fn(),
  executeBrowserMutation: vi.fn(),
  getTikTokPublicationConsent: vi.fn(),
}));

vi.mock('../src/modules/identity/auth.routes.js', () => ({
  authorizeRequest,
  CSRF_COOKIE: 'publish_relay_csrf',
}));
vi.mock('../src/modules/identity/session.js', () => ({ verifyCsrfToken }));
vi.mock('../src/modules/content/browser-idempotency.repository.js', () => ({
  executeBrowserMutation,
}));
vi.mock('../src/modules/providers/tiktok-consent.service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  issueTikTokPublicationConsentInTransaction,
  getTikTokPublicationConsent,
}));

const { registerTikTokConsentRoutes } =
  await import('../src/modules/providers/tiktok-consent.routes.js');

const workspaceId = '00000000-0000-4000-8000-000000000101';
const userId = '00000000-0000-4000-8000-000000000102';
const postId = '00000000-0000-4000-8000-000000000301';
const revisionId = '00000000-0000-4000-8000-000000000302';
const accountId = '00000000-0000-4000-8000-000000000501';
const capabilitySnapshotId = '00000000-0000-4000-8000-000000000801';
const receiptId = '00000000-0000-4000-8000-000000000901';
const body = {
  postId,
  revisionId,
  accountId,
  capabilitySnapshotId,
  options: {
    privacyLevel: 'SELF_ONLY',
    allowComment: false,
    allowDuet: false,
    allowStitch: false,
    commercialContent: 'none',
    aiGenerated: false,
  },
  musicUsageConfirmed: true,
  brandedContentPolicyConfirmed: false,
};

async function application() {
  const app = Fastify();
  await app.register(cookie);
  registerTikTokConsentRoutes(app, { auth: {} as never, database: {} as never });
  return app;
}

describe('human TikTok consent HTTP boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeRequest.mockResolvedValue({ workspaceId, userId, role: 'editor' });
    verifyCsrfToken.mockReturnValue(true);
    issueTikTokPublicationConsentInTransaction.mockResolvedValue({
      id: receiptId,
      payloadHash: 'a'.repeat(64),
      consentedAt: '2026-10-02T00:00:00.000Z',
    });
    executeBrowserMutation.mockImplementation(
      async (
        _database: unknown,
        _input: unknown,
        mutation: (transaction: unknown) => Promise<{ statusCode: number; body: unknown }>,
      ) => ({
        kind: 'executed',
        response: await mutation({}),
      }),
    );
  });

  it('derives human tenant identity from session and exposes only receipt metadata', async () => {
    const app = await application();
    const response = await app.inject({
      method: 'POST',
      url: '/api/workflow/tiktok-consents',
      headers: {
        cookie: 'publish_relay_csrf=token',
        'x-csrf-token': 'token',
        'idempotency-key': 'consent-one',
      },
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    expect(authorizeRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'content:write',
    );
    expect(issueTikTokPublicationConsentInTransaction).toHaveBeenCalledWith(expect.anything(), {
      ...body,
      workspaceId,
      userId,
      actor: { type: 'user', id: userId },
    });
    expect(Object.keys(response.json<{ data: Record<string, unknown> }>().data).sort()).toEqual([
      'consentedAt',
      'id',
      'payloadHash',
    ]);
    await app.close();
  });

  it('rejects unauthenticated, CSRF, caller identity, and incomplete options before issuance', async () => {
    const app = await application();
    authorizeRequest.mockResolvedValueOnce(null);
    expect(
      (await app.inject({ method: 'POST', url: '/api/workflow/tiktok-consents', payload: body }))
        .statusCode,
    ).toBe(401);
    verifyCsrfToken.mockReturnValueOnce(false);
    expect(
      (await app.inject({ method: 'POST', url: '/api/workflow/tiktok-consents', payload: body }))
        .statusCode,
    ).toBe(403);
    for (const payload of [
      { ...body, userId },
      { ...body, actor: { type: 'user', id: userId } },
      { ...body, options: { ...body.options, aiGenerated: undefined } },
      { ...body, options: { ...body.options, privacyLevel: undefined } },
    ])
      expect(
        (await app.inject({ method: 'POST', url: '/api/workflow/tiktok-consents', payload }))
          .statusCode,
      ).toBe(400);
    expect(issueTikTokPublicationConsentInTransaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('maps stale exact-revision consent to actionable conflict', async () => {
    const app = await application();
    issueTikTokPublicationConsentInTransaction.mockRejectedValueOnce(
      new TikTokConsentInvalidError(),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/workflow/tiktok-consents',
      headers: { 'idempotency-key': 'stale-consent' },
      payload: body,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toContain(
      'refresh the destination and confirm again',
    );
    await app.close();
  });

  it('reads only the session human receipt; missing and invalid receipts remain bounded', async () => {
    const app = await application();
    getTikTokPublicationConsent.mockResolvedValueOnce({
      id: receiptId,
      postId,
      revisionId,
      accountId,
      payloadHash: 'a'.repeat(64),
      consentedAt: '2026-10-02T00:00:00.000Z',
    });
    const url = `/api/workflow/tiktok-consents/${receiptId}`;
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(200);
    expect(getTikTokPublicationConsent).toHaveBeenCalledWith(expect.anything(), {
      workspaceId,
      userId,
      receiptId,
    });
    expect(response.body).not.toContain('mediaSha256');
    getTikTokPublicationConsent.mockRejectedValueOnce(new TikTokConsentNotFoundError());
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    getTikTokPublicationConsent.mockRejectedValueOnce(new TikTokConsentInvalidError());
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(409);
    await app.close();
  });
});

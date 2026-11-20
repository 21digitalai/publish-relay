import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createStandaloneApplication } from '../../src/application/create-application.js';
import {
  providerConnections,
  providerAccounts,
  posts,
  postRevisions,
  publicationAttempts,
  publicationJobs,
} from '../../src/database/schema.js';
import { withTenantTransaction } from '../../src/database/tenant-transaction.js';
import { FakeProviderConnectionAdapter } from '../../src/modules/credentials/provider-adapter.js';
import {
  FanvueHttpClient,
  FANVUE_CHAT_READ_SCOPES,
  FANVUE_CHAT_SEND_SCOPES,
  FANVUE_PAYMENT_SCOPE,
  FANVUE_AUDIENCE_SCOPE,
  FANVUE_PUBLISHING_SCOPES,
} from '../../src/modules/providers/fanvue-http-client.js';
import { connectProvider } from '../../src/modules/credentials/provider-connection.service.js';
import { authenticateRequest } from '../../src/modules/identity/auth.routes.js';
import { createPostgresAuthStore } from '../../src/modules/identity/auth.repository.js';
import { AuthService } from '../../src/modules/identity/auth.service.js';
import { ApiKeyService } from '../../src/modules/identity/api-key.service.js';
import { createPostgresApiKeyStore } from '../../src/modules/identity/api-key.repository.js';
import { FanvueReadClient } from '../../src/modules/providers/fanvue-read-client.js';
import { AuthEmailOutboxDelivery } from '../../src/modules/identity/auth-email-outbox.js';
import { createPostgresMagicLinkStore } from '../../src/modules/identity/magic-link.repository.js';
import { MagicLinkService } from '../../src/modules/identity/magic-link.service.js';
import { verifyCsrfToken } from '../../src/modules/identity/session.js';
import { createPostgresDelegatedAuthorizationStore } from '../../src/modules/delegated-authorization/delegated-authorization.repository.js';
import { DelegatedAuthorizationService } from '../../src/modules/delegated-authorization/delegated-authorization.service.js';

const port = Number(process.env.PUBLISH_RELAY_E2E_PORT ?? 43199);
const database = new PGlite(process.env.PUBLISH_RELAY_E2E_DATABASE_DIR);
const migrationNames = (await readdir(new URL('../../migrations/', import.meta.url)))
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort();
const schemaState = await database.query<{ exists: boolean }>(
  "select to_regclass('public.users') is not null as exists",
);
if (!schemaState.rows[0]?.exists)
  for (const name of migrationNames)
    await database.exec(
      await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'),
    );
await database.exec(`
  INSERT INTO registered_clients (id, display_name, client_type, redirect_uris, allowed_scopes)
  VALUES (
    'example-client-dev',
    'Example Client',
    'public',
    ARRAY['http://127.0.0.1:43123/callback'],
    ARRAY['destinations:read', 'schedules:read', 'schedules:write', 'content:write', 'publishes:retry']
  ) ON CONFLICT (id) DO NOTHING;
`);
await database.exec(`
  DO $$ BEGIN
    CREATE ROLE publish_relay_app NOLOGIN;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$;
  GRANT USAGE ON SCHEMA public TO publish_relay_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO publish_relay_app;
`);
const typedDatabase = drizzle(database) as unknown as NodePgDatabase;
const auth = new AuthService(createPostgresAuthStore(typedDatabase));
const fixtureKey = Buffer.alloc(32, 7);
const magicLinkMode = process.env.PUBLISH_RELAY_HUMAN_AUTH_MODE === 'magic_link';
const application = createStandaloneApplication({
  config: {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: port,
    CURSOR_SIGNING_SECRET: 'e2e-cursor-signing-secret-32-characters-minimum',
    WORKER_POLL_INTERVAL_MS: 1000,
    ...(process.env.PUBLISH_RELAY_ENABLED_ADAPTERS !== undefined
      ? { PUBLISH_RELAY_ENABLED_ADAPTERS: process.env.PUBLISH_RELAY_ENABLED_ADAPTERS }
      : {}),
    ...(magicLinkMode ? { PUBLISH_RELAY_HUMAN_AUTH_MODE: 'magic_link' } : {}),
  },
  auth,
  apiKeys: new ApiKeyService(createPostgresApiKeyStore(typedDatabase)),
  fanvueOauth: {
    keys: { currentVersion: () => 'e2e-v1', getKey: () => Promise.resolve(fixtureKey) },
    client: new FanvueHttpClient({
      clientId: 'fixture-client',
      clientSecret: 'fixture-secret',
      fetch: (url, options) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith(
                '/users/me',
              )
                ? {
                    uuid: 'd6ed1cac-e0cd-4109-bf04-539cb8591838',
                    displayName: 'Fixture Creator',
                    isCreator: true,
                  }
                : {
                    access_token: 'fixture-access',
                    refresh_token: 'fixture-refresh',
                    token_type: 'Bearer',
                    expires_in: 3600,
                    scope:
                      options?.body instanceof URLSearchParams &&
                      options.body.get('code') === 'fixture-audience'
                        ? [
                            ...FANVUE_CHAT_SEND_SCOPES,
                            FANVUE_PAYMENT_SCOPE,
                            FANVUE_AUDIENCE_SCOPE,
                          ].join(' ')
                        : options?.body instanceof URLSearchParams &&
                            options.body.get('code') === 'fixture-audience-no-scope'
                          ? [...FANVUE_CHAT_SEND_SCOPES, FANVUE_PAYMENT_SCOPE].join(' ')
                          : options?.body instanceof URLSearchParams &&
                              options.body.get('code') === 'fixture-payment'
                            ? [...FANVUE_CHAT_SEND_SCOPES, FANVUE_PAYMENT_SCOPE].join(' ')
                            : options?.body instanceof URLSearchParams &&
                                options.body.get('code') === 'fixture-payment-no-scope'
                              ? FANVUE_CHAT_SEND_SCOPES.join(' ')
                              : options?.body instanceof URLSearchParams &&
                                  options.body.get('code') === 'fixture-chat-read'
                                ? FANVUE_CHAT_READ_SCOPES.join(' ')
                                : options?.body instanceof URLSearchParams &&
                                    options.body.get('code') === 'fixture-chat-read-no-scope'
                                  ? FANVUE_PUBLISHING_SCOPES.join(' ')
                                  : options?.body instanceof URLSearchParams &&
                                      options.body.get('code') === 'fixture-chat-send-no-scope'
                                    ? FANVUE_CHAT_READ_SCOPES.join(' ')
                                    : options?.body instanceof URLSearchParams &&
                                        options.body.get('code') === 'fixture-chat-send'
                                      ? FANVUE_CHAT_SEND_SCOPES.join(' ')
                                      : FANVUE_PUBLISHING_SCOPES.join(' '),
                  },
            ),
          ),
        ),
    }),
    callbackUrl: 'https://publishrelay.app/api/oauth/fanvue/callback',
    readClient: new FanvueReadClient((url) => {
      const parsed = new URL(
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      );
      const fan = {
        uuid: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        handle: 'fixture-fan',
        displayName: 'Fixture Fan',
      };
      const body =
        parsed.pathname === '/followers'
          ? { data: [fan], pagination: { page: 1, size: 1, hasMore: false } }
          : parsed.pathname === '/subscribers'
            ? {
                data: [
                  {
                    ...fan,
                    subscription: { status: 'active' },
                    firstSubscribedAt: '2026-01-01T00:00:00Z',
                  },
                ],
                pagination: { page: 1, size: 1, hasMore: false, nextCursor: null },
              }
            : { data: [], pagination: { page: 1, size: 0, hasMore: false } };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }),
  },
  ...(magicLinkMode
    ? {
        magicLinks: new MagicLinkService(
          createPostgresMagicLinkStore(typedDatabase),
          new AuthEmailOutboxDelivery(typedDatabase, {
            currentVersion: () => 'e2e-v1',
            getKey: () => Promise.resolve(fixtureKey),
          }),
          {
            pepper: 'e2e-pepper-which-is-at-least-32-characters-long',
            publicOrigin: 'http://127.0.0.1:43199',
            exposeDevelopmentUrl: true,
          },
        ),
      }
    : {}),
  uiRoot: resolve(process.cwd(), 'dist/ui'),
  database: typedDatabase,
  delegatedAuthorization: new DelegatedAuthorizationService(
    createPostgresDelegatedAuthorizationStore(typedDatabase),
  ),
});
application.post('/api/oauth/x', async (request, reply) => {
  const identity = await authenticateRequest(request, auth);
  if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
  if (
    !verifyCsrfToken(
      request.cookies.publish_relay_csrf,
      request.headers['x-csrf-token'] as string | undefined,
    )
  )
    return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
  await connectProvider(
    typedDatabase,
    { currentVersion: () => 'e2e-v1', getKey: () => Promise.resolve(fixtureKey) },
    new FakeProviderConnectionAdapter([
      {
        providerAccountId: 'example-editorial',
        displayName: 'Example Editorial (@exampleeditorial)',
      },
      { providerAccountId: 'studio-notes', displayName: 'Studio Notes (@studionotes)' },
    ]),
    {
      workspaceId: identity.workspaceId,
      userId: identity.userId,
      provider: 'x',
      externalSubjectId: '123456789',
      accessToken: 'credential-free-e2e-token',
      requestId: request.id,
    },
  );
  const workspace = await auth.getWorkspace(identity);
  return {
    data: { authorizationUrl: `/w/${workspace?.slug ?? 'workspace'}/accounts` },
    error: null,
  };
});
application.post('/__test__/provider-reconnect-required', async (request, reply) => {
  const identity = await authenticateRequest(request, auth);
  if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
  await withTenantTransaction(typedDatabase, identity, (transaction) =>
    transaction
      .update(providerConnections)
      .set({ status: 'reconnect_required', updatedAt: new Date() })
      .where(eq(providerConnections.workspaceId, identity.workspaceId)),
  );
  return { data: { updated: true }, error: null };
});
application.post('/__test__/block-account-disconnect', async (request, reply) => {
  const identity = await authenticateRequest(request, auth);
  if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
  await withTenantTransaction(typedDatabase, identity, async (transaction) => {
    const [account] = await transaction
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.workspaceId, identity.workspaceId),
          eq(providerAccounts.displayName, 'Example Editorial (@exampleeditorial)'),
        ),
      )
      .limit(1);
    if (!account) throw new Error('Fixture account is required');
    const [post] = await transaction
      .insert(posts)
      .values({ workspaceId: identity.workspaceId, createdByUserId: identity.userId })
      .returning({ id: posts.id });
    if (!post) throw new Error('Fixture post was not created');
    const [revision] = await transaction
      .insert(postRevisions)
      .values({
        workspaceId: identity.workspaceId,
        postId: post.id,
        revisionNumber: 1,
        content: { type: 'text', text: 'Fixture' },
      })
      .returning({ id: postRevisions.id });
    if (!revision) throw new Error('Fixture revision was not created');
    await transaction.insert(publicationJobs).values({
      workspaceId: identity.workspaceId,
      postId: post.id,
      revisionId: revision.id,
      providerAccountId: account.id,
      scheduledAt: new Date(Date.now() + 60_000),
    });
  });
  return { data: { blocked: true }, error: null };
});
application.post('/__test__/seed-disabled-adapter-history', async (request, reply) => {
  const identity = await authenticateRequest(request, auth);
  if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
  await connectProvider(
    typedDatabase,
    { currentVersion: () => 'e2e-v1', getKey: () => Promise.resolve(fixtureKey) },
    new FakeProviderConnectionAdapter([
      { providerAccountId: 'existing-x-account', displayName: 'Existing X account' },
    ]),
    {
      workspaceId: identity.workspaceId,
      userId: identity.userId,
      provider: 'x',
      externalSubjectId: 'existing-x-subject',
      accessToken: 'credential-free-e2e-token',
      requestId: request.id,
    },
  );
  const result = await withTenantTransaction(typedDatabase, identity, async (transaction) => {
    const [account] = await transaction
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.workspaceId, identity.workspaceId),
          eq(providerAccounts.providerAccountId, 'existing-x-account'),
        ),
      )
      .limit(1);
    if (!account) throw new Error('Fixture account is required');
    const [post] = await transaction
      .insert(posts)
      .values({ workspaceId: identity.workspaceId, createdByUserId: identity.userId })
      .returning({ id: posts.id });
    if (!post) throw new Error('Fixture post was not created');
    const [revision] = await transaction
      .insert(postRevisions)
      .values({
        workspaceId: identity.workspaceId,
        postId: post.id,
        revisionNumber: 1,
        content: { type: 'text', text: 'Existing Story history' },
      })
      .returning({ id: postRevisions.id });
    if (!revision) throw new Error('Fixture revision was not created');
    const [job] = await transaction
      .insert(publicationJobs)
      .values({
        workspaceId: identity.workspaceId,
        postId: post.id,
        revisionId: revision.id,
        providerAccountId: account.id,
        effectivePayload: {
          schemaVersion: 1,
          kind: 'story_image',
          mediaId: '00000000-0000-4000-8000-000000000913',
        },
        scheduledAt: new Date(),
        state: 'dispatching',
        attemptNumber: 1,
        reconciliationRequired: true,
      })
      .returning({ id: publicationJobs.id });
    if (!job) throw new Error('Fixture job was not created');
    await transaction.insert(publicationAttempts).values({
      workspaceId: identity.workspaceId,
      jobId: job.id,
      attemptNumber: 1,
      idempotencyKey: `fixture-${job.id}`,
      requestFingerprint: `fixture-${job.id}`,
      startedAt: new Date(),
      finishedAt: new Date(),
      outcome: 'unknown',
      providerRequestId: 'existing-x-request',
    });
    return { jobId: job.id };
  });
  return { data: result, error: null };
});
application.addHook('onClose', async () => database.close());
await application.listen({ host: '127.0.0.1', port });

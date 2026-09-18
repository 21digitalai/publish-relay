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
  publicationJobs,
} from '../../src/database/schema.js';
import { withTenantTransaction } from '../../src/database/tenant-transaction.js';
import { FakeProviderConnectionAdapter } from '../../src/modules/credentials/provider-adapter.js';
import { connectProvider } from '../../src/modules/credentials/provider-connection.service.js';
import { authenticateRequest } from '../../src/modules/identity/auth.routes.js';
import { createPostgresAuthStore } from '../../src/modules/identity/auth.repository.js';
import { AuthService } from '../../src/modules/identity/auth.service.js';
import { verifyCsrfToken } from '../../src/modules/identity/session.js';
import { createPostgresDelegatedAuthorizationStore } from '../../src/modules/delegated-authorization/delegated-authorization.repository.js';
import { DelegatedAuthorizationService } from '../../src/modules/delegated-authorization/delegated-authorization.service.js';

const database = new PGlite();
const migrationNames = (await readdir(new URL('../../migrations/', import.meta.url)))
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort();
for (const name of migrationNames)
  await database.exec(await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
await database.exec(`
  INSERT INTO registered_clients (id, display_name, client_type, redirect_uris, allowed_scopes)
  VALUES (
    'example-client-dev',
    'Example Client',
    'public',
    ARRAY['http://127.0.0.1:43123/callback'],
    ARRAY['destinations:read', 'schedules:read', 'schedules:write', 'content:write', 'publishes:retry']
  );
`);
await database.exec(`
  CREATE ROLE publish_relay_app NOLOGIN;
  GRANT USAGE ON SCHEMA public TO publish_relay_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO publish_relay_app;
`);
const typedDatabase = drizzle(database) as unknown as NodePgDatabase;
const auth = new AuthService(createPostgresAuthStore(typedDatabase));
const application = createStandaloneApplication({
  config: {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 43199,
    WORKER_POLL_INTERVAL_MS: 1000,
    PUBLISH_RELAY_HUMAN_AUTH_MODE: 'magic_link',
  },
  auth,
  uiRoot: resolve(process.cwd(), 'dist/ui'),
  database: typedDatabase,
  delegatedAuthorization: new DelegatedAuthorizationService(
    createPostgresDelegatedAuthorizationStore(typedDatabase),
  ),
});
const fixtureKey = Buffer.alloc(32, 7);
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
application.addHook('onClose', async () => database.close());
await application.listen({ host: '127.0.0.1', port: 43199 });

import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { authorizeRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { verifyCsrfToken } from '../identity/session.js';
import { youtubeDestinationDefaultsSchema } from '../providers/youtube-settings.js';
import {
  PAGE_ENGAGEMENT_CAPABILITIES,
  readPageEngagementState,
  setPageEngagementModule,
} from '../providers/facebook-page-engagement.service.js';
import {
  listPageEngagementPrincipals,
  setPageEngagementPrincipalGrants,
} from '../providers/facebook-page-engagement-grants.service.js';
import type { MasterKeyProvider } from './envelope.js';
import type { TikTokHttpClient } from '../providers/tiktok-http-client.js';
import { TikTokRequestError } from '../providers/tiktok-http-client.js';
import {
  fetchTikTokCapabilitySnapshot,
  TikTokCapabilityUnavailableError,
} from '../providers/tiktok-capabilities.service.js';
import {
  disconnectProviderAccount,
  listProviderAccountsPage,
  availableWithTikTokRuntime,
  InvalidAccountPageCursorError,
  updateYouTubeAccountDefaults,
  updateXLongPostDeclaration,
} from './provider-account.service.js';
import {
  editFacebookPageExposure,
  listFacebookPageExposureTargets,
  setExposedPageCalendarVisibility,
} from './provider-account-exposure.service.js';

const accountParamsSchema = z.object({ accountId: z.uuid() });
const xLongPostDeclarationSchema = z.strictObject({ allowed: z.boolean() });
const exposureParamsSchema = z.object({ accountId: z.uuid(), workspaceId: z.uuid() });
const exposureBodySchema = z.strictObject({ expose: z.boolean() });
const calendarVisibilitySchema = z.strictObject({ showPosts: z.boolean() });
const engagementModuleSchema = z.strictObject({
  module: z.enum(['comments', 'dms']),
  enabled: z.boolean(),
});
const engagementGrantSchema = z.strictObject({
  principalKind: z.enum(['api-key', 'delegated']),
  principalId: z.uuid(),
  capabilities: z
    .array(z.enum(PAGE_ENGAGEMENT_CAPABILITIES))
    .max(6)
    .refine((items) => new Set(items).size === items.length),
});

export function registerProviderAccountRoutes(
  application: FastifyInstance,
  dependencies: {
    auth: AuthService;
    database: NodePgDatabase;
    tiktok?: { keys: MasterKeyProvider; client: TikTokHttpClient };
  },
): void {
  application.get('/api/provider-accounts/:accountId/engagement', async (request, reply) => {
    const identity = await authorizeRequest(request, dependencies.auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const params = accountParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ data: null, error: 'Invalid Page account' });
    const state = await readPageEngagementState(dependencies.database, {
      workspaceId: identity.workspaceId,
      accountId: params.data.accountId,
    });
    void reply.header('Cache-Control', 'no-store');
    return state
      ? { data: state, error: null }
      : reply.code(404).send({ data: null, error: 'Owned Facebook Page not found' });
  });

  application.patch('/api/provider-accounts/:accountId/engagement', async (request, reply) => {
    const identity = await authorizeRequest(request, dependencies.auth, 'workspace:manage');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (
      !verifyCsrfToken(
        request.cookies[CSRF_COOKIE],
        request.headers['x-csrf-token'] as string | undefined,
      )
    )
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const params = accountParamsSchema.safeParse(request.params);
    const body = engagementModuleSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send({ data: null, error: 'Invalid Page module setting' });
    const state = await setPageEngagementModule(dependencies.database, {
      workspaceId: identity.workspaceId,
      accountId: params.data.accountId,
      userId: identity.userId,
      requestId: request.id,
      module: body.data.module,
      enabled: body.data.enabled,
    });
    void reply.header('Cache-Control', 'no-store');
    return state
      ? { data: state, error: null }
      : reply.code(404).send({ data: null, error: 'Owned Facebook Page not found' });
  });

  application.get(
    '/api/provider-accounts/:accountId/engagement/principals',
    async (request, reply) => {
      const identity = await authorizeRequest(request, dependencies.auth, 'workspace:manage');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      const params = accountParamsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ data: null, error: 'Invalid Page account' });
      const principals = await listPageEngagementPrincipals(dependencies.database, {
        workspaceId: identity.workspaceId,
        accountId: params.data.accountId,
        userId: identity.userId,
      });
      void reply.header('Cache-Control', 'no-store');
      return principals
        ? { data: principals, error: null }
        : reply.code(404).send({ data: null, error: 'Owned Facebook Page not found' });
    },
  );

  application.put('/api/provider-accounts/:accountId/engagement/grants', async (request, reply) => {
    const identity = await authorizeRequest(request, dependencies.auth, 'workspace:manage');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (
      !verifyCsrfToken(
        request.cookies[CSRF_COOKIE],
        request.headers['x-csrf-token'] as string | undefined,
      )
    )
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const params = accountParamsSchema.safeParse(request.params);
    const body = engagementGrantSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send({ data: null, error: 'Invalid Page access selection' });
    const saved = await setPageEngagementPrincipalGrants(dependencies.database, {
      workspaceId: identity.workspaceId,
      accountId: params.data.accountId,
      userId: identity.userId,
      requestId: request.id,
      ...body.data,
    });
    void reply.header('Cache-Control', 'no-store');
    return saved
      ? { data: { saved: true }, error: null }
      : reply.code(404).send({ data: null, error: 'Owned Page or active credential not found' });
  });

  application.get('/api/provider-accounts', async (request, reply) => {
    const identity = await authorizeRequest(request, dependencies.auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const query = z
      .object({
        cursor: z.string().max(1024).optional(),
        provider: z.literal('linkedin').optional(),
      })
      .safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ data: null, error: 'Invalid account page cursor' });
    try {
      const page = await listProviderAccountsPage(
        dependencies.database,
        identity.workspaceId,
        identity.userId,
        query.data.cursor,
        query.data.provider,
      );
      return {
        data: {
          ...page,
          accounts: page.accounts.map((account) =>
            availableWithTikTokRuntime(account, Boolean(dependencies.tiktok)),
          ),
        },
        error: null,
      };
    } catch (error) {
      if (error instanceof InvalidAccountPageCursorError)
        return reply.code(400).send({ data: null, error: error.message });
      throw error;
    }
  });

  application.get(
    '/api/provider-accounts/:accountId/tiktok-capabilities',
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      const identity = await authorizeRequest(request, dependencies.auth, 'content:read');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      const params = accountParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ data: null, error: 'Invalid account' });
      if (!dependencies.tiktok)
        return reply.code(503).send({ data: null, error: 'TikTok options are unavailable' });
      try {
        const snapshot = await fetchTikTokCapabilitySnapshot(
          dependencies.database,
          dependencies.tiktok.keys,
          dependencies.tiktok.client,
          {
            workspaceId: identity.workspaceId,
            accountId: params.data.accountId,
            requestId: request.id,
          },
        );
        return { data: snapshot, error: null };
      } catch (error) {
        if (error instanceof TikTokCapabilityUnavailableError)
          return reply.code(409).send({ data: null, error: 'Reconnect this TikTok account' });
        if (error instanceof TikTokRequestError)
          return reply
            .code(502)
            .send({ data: null, error: 'TikTok options could not be refreshed' });
        throw error;
      }
    },
  );

  application.delete('/api/provider-accounts/:accountId', async (request, reply) => {
    const identity = await authorizeRequest(request, dependencies.auth, 'workspace:manage');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (
      !verifyCsrfToken(
        request.cookies[CSRF_COOKIE],
        request.headers['x-csrf-token'] as string | undefined,
      )
    )
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const params = accountParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ data: null, error: 'Invalid account' });
    const result = await disconnectProviderAccount(dependencies.database, {
      workspaceId: identity.workspaceId,
      userId: identity.userId,
      accountId: params.data.accountId,
      requestId: request.id,
    });
    if (result === 'missing')
      return reply.code(404).send({ data: null, error: 'Account was not found' });
    if (result === 'scheduled')
      return reply.code(409).send({
        data: null,
        error: 'Cancel scheduled jobs for this account before disconnecting it',
      });
    if (result === 'revoking')
      return reply.code(409).send({
        data: null,
        error: 'This Meta grant is being revoked; retry the grant revoke first',
      });
    return { data: { disconnected: true }, error: null };
  });

  application.patch(
    '/api/provider-accounts/:accountId/exposures/:workspaceId',
    async (request, reply) => {
      const identity = await authorizeRequest(request, dependencies.auth, 'workspace:manage');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      if (
        !verifyCsrfToken(
          request.cookies[CSRF_COOKIE],
          request.headers['x-csrf-token'] as string | undefined,
        )
      )
        return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
      const params = exposureParamsSchema.safeParse(request.params);
      const body = exposureBodySchema.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ data: null, error: 'Invalid Page exposure selection' });
      const result = await editFacebookPageExposure(dependencies.database, {
        originWorkspaceId: identity.workspaceId,
        targetWorkspaceId: params.data.workspaceId,
        accountId: params.data.accountId,
        userId: identity.userId,
        requestId: request.id,
        expose: body.data.expose,
      });
      if (result === 'unavailable')
        return reply.code(404).send({ data: null, error: 'Page or target workspace unavailable' });
      if (result === 'active_jobs')
        return reply.code(409).send({
          data: null,
          error: 'Resolve scheduled jobs before hiding this Page from the workspace',
        });
      return { data: { exposed: body.data.expose }, error: null };
    },
  );

  application.get('/api/provider-accounts/:accountId/exposures', async (request, reply) => {
    const identity = await authorizeRequest(request, dependencies.auth, 'workspace:manage');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const params = accountParamsSchema.safeParse(request.params);
    const query = z.object({ cursor: z.uuid().optional() }).safeParse(request.query);
    if (!params.success || !query.success)
      return reply.code(400).send({ data: null, error: 'Invalid Page exposure query' });
    const page = await listFacebookPageExposureTargets(dependencies.database, {
      originWorkspaceId: identity.workspaceId,
      accountId: params.data.accountId,
      userId: identity.userId,
      ...(query.data.cursor ? { afterId: query.data.cursor } : {}),
    });
    return { data: page, error: null };
  });

  application.patch(
    '/api/provider-accounts/:accountId/calendar-visibility',
    async (request, reply) => {
      const identity = await authorizeRequest(request, dependencies.auth, 'workspace:manage');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      if (
        !verifyCsrfToken(
          request.cookies[CSRF_COOKIE],
          request.headers['x-csrf-token'] as string | undefined,
        )
      )
        return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
      const params = accountParamsSchema.safeParse(request.params);
      const body = calendarVisibilitySchema.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ data: null, error: 'Invalid calendar visibility' });
      const updated = await setExposedPageCalendarVisibility(dependencies.database, {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        accountId: params.data.accountId,
        showPosts: body.data.showPosts,
      });
      return updated
        ? { data: { showPosts: body.data.showPosts }, error: null }
        : reply.code(404).send({ data: null, error: 'Shared Page was not found' });
    },
  );

  application.patch('/api/provider-accounts/:accountId/x-long-posts', async (request, reply) => {
    const identity = await authorizeRequest(request, dependencies.auth, 'workspace:manage');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (
      !verifyCsrfToken(
        request.cookies[CSRF_COOKIE],
        request.headers['x-csrf-token'] as string | undefined,
      )
    )
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const params = accountParamsSchema.safeParse(request.params);
    const declaration = xLongPostDeclarationSchema.safeParse(request.body);
    if (!params.success || !declaration.success)
      return reply.code(400).send({ data: null, error: 'Invalid X long-post declaration' });
    const result = await updateXLongPostDeclaration(dependencies.database, {
      workspaceId: identity.workspaceId,
      userId: identity.userId,
      accountId: params.data.accountId,
      requestId: request.id,
      allowed: declaration.data.allowed,
    });
    if (result === 'missing')
      return reply.code(404).send({ data: null, error: 'X account was not found' });
    return {
      data: {
        xLongPosts: { allowed: declaration.data.allowed, source: 'self_declared', verified: false },
      },
      error: null,
    };
  });

  application.patch(
    '/api/provider-accounts/:accountId/youtube-defaults',
    async (request, reply) => {
      const identity = await authorizeRequest(request, dependencies.auth, 'workspace:manage');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      if (
        !verifyCsrfToken(
          request.cookies[CSRF_COOKIE],
          request.headers['x-csrf-token'] as string | undefined,
        )
      )
        return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
      const params = accountParamsSchema.safeParse(request.params);
      const defaults = youtubeDestinationDefaultsSchema.safeParse(request.body);
      if (!params.success || !defaults.success)
        return reply.code(400).send({ data: null, error: 'Invalid YouTube defaults' });
      const result = await updateYouTubeAccountDefaults(dependencies.database, {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        accountId: params.data.accountId,
        requestId: request.id,
        defaults: defaults.data,
      });
      if (result === 'missing')
        return reply.code(404).send({ data: null, error: 'YouTube account was not found' });
      return { data: { adapterDefaults: defaults.data }, error: null };
    },
  );
}

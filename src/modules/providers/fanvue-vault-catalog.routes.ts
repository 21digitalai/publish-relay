import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import { authorizeRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import { authorizeMachineRequest, MachineAuthorizationError } from '../identity/machine-auth.js';
import { verifyCsrfToken } from '../identity/session.js';
import { WorkspaceAuthorizationError } from '../identity/authorization.js';
import { FanvueRequestError } from './fanvue-http-client.js';
import { FanvueReadUnavailableError, type FanvueReadService } from './fanvue-read.service.js';
import {
  FanvueVaultCatalogService,
  FanvueVaultPriceConflictError,
} from './fanvue-vault-catalog.service.js';

const params = z.object({
  accountId: z.uuid(),
  folderName: z.string().min(1).max(255).optional(),
  mediaUuid: z.uuid().optional(),
});
const query = z.object({
  page: z.coerce.number().int().positive().max(1_000_000).optional(),
  size: z.coerce.number().int().positive().max(50).optional(),
});
const priceBody = z.strictObject({
  manualPriceCents: z.number().int().positive().nullable(),
  expectedVersion: z.number().int().positive().nullable(),
});

function input(request: FastifyRequest, workspaceId: string) {
  const path = params.safeParse(request.params);
  const search = query.safeParse(request.query);
  if (!path.success || !search.success || !path.data.folderName) return null;
  return {
    workspaceId,
    accountId: path.data.accountId,
    folderName: path.data.folderName,
    ...(search.data.page === undefined ? {} : { page: search.data.page }),
    ...(search.data.size === undefined ? {} : { size: search.data.size }),
  };
}

function priceInput(request: FastifyRequest, workspaceId: string) {
  const path = params.safeParse(request.params);
  const body = priceBody.safeParse(request.body);
  if (!path.success || !body.success || !path.data.mediaUuid) return null;
  return {
    workspaceId,
    accountId: path.data.accountId,
    providerMediaUuid: path.data.mediaUuid,
    ...body.data,
  };
}

async function errorReply(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
    return await reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
  if (error instanceof WorkspaceAuthorizationError)
    return await reply.code(403).send(errorEnvelope('forbidden', 'Access denied', request.id));
  if (error instanceof FanvueVaultPriceConflictError)
    return await reply.code(409).send(errorEnvelope('version_conflict', error.message, request.id));
  if (error instanceof FanvueReadUnavailableError)
    return await reply
      .code(error.reason === 'account_not_found' ? 404 : 409)
      .send(errorEnvelope(error.reason, error.message, request.id));
  if (error instanceof FanvueRequestError)
    return await reply
      .code(error.status === 404 ? 404 : 502)
      .send(errorEnvelope('provider_read_failed', 'Fanvue media read failed', request.id));
  throw error;
}

export function registerFanvueVaultCatalogRoutes(
  application: FastifyInstance,
  dependencies: {
    database: NodePgDatabase;
    reads: FanvueReadService;
    apiKeys: ApiKeyService;
    rateLimiter: ApiRateLimiter;
    auth?: AuthService;
    delegatedAuthorization?: DelegatedAuthorizationService;
    fetch?: typeof fetch;
    catalog?: FanvueVaultCatalogService;
  },
): void {
  const catalog =
    dependencies.catalog ??
    new FanvueVaultCatalogService(dependencies.database, dependencies.reads);
  application.get(
    '/api/v1/fanvue/accounts/:accountId/vault/catalog/:folderName',
    async (request, reply) => {
      try {
        const principal = await authorizeMachineRequest(
          request,
          dependencies.apiKeys,
          dependencies.delegatedAuthorization,
          'fanvue:media:read',
        );
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const parsed = input(request, principal.workspaceId);
        if (!parsed)
          return await reply
            .code(400)
            .send(errorEnvelope('invalid_request', 'Invalid catalog request', request.id));
        return await reply.send(successEnvelope(await catalog.listFolderMedia(parsed), request.id));
      } catch (error) {
        return await errorReply(error, request, reply);
      }
    },
  );
  application.patch(
    '/api/v1/fanvue/accounts/:accountId/vault/media/:mediaUuid/price',
    async (request, reply) => {
      try {
        const principal = await authorizeMachineRequest(
          request,
          dependencies.apiKeys,
          dependencies.delegatedAuthorization,
          'fanvue:chats:send',
        );
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const parsed = priceInput(request, principal.workspaceId);
        if (!parsed)
          return await reply
            .code(400)
            .send(errorEnvelope('invalid_request', 'Invalid price request', request.id));
        return await reply.send(successEnvelope(await catalog.savePrice(parsed), request.id));
      } catch (error) {
        return await errorReply(error, request, reply);
      }
    },
  );

  if (!dependencies.auth) return;
  const auth = dependencies.auth;
  application.get(
    '/api/fanvue/accounts/:accountId/vault/catalog/:folderName',
    async (request, reply) => {
      void reply.header('Cache-Control', 'private, no-store');
      try {
        const identity = await authorizeRequest(request, auth, 'workspace:manage');
        if (!identity)
          return await reply.code(401).send({ data: null, error: 'Authentication required' });
        const parsed = input(request, identity.workspaceId);
        if (!parsed)
          return await reply.code(400).send({ data: null, error: 'Invalid catalog request' });
        return await reply.send(successEnvelope(await catalog.listFolderMedia(parsed), request.id));
      } catch (error) {
        return await errorReply(error, request, reply);
      }
    },
  );
  application.patch(
    '/api/fanvue/accounts/:accountId/vault/media/:mediaUuid/price',
    async (request, reply) => {
      void reply.header('Cache-Control', 'private, no-store');
      try {
        const identity = await authorizeRequest(request, auth, 'workspace:manage');
        if (!identity)
          return await reply.code(401).send({ data: null, error: 'Authentication required' });
        if (
          !verifyCsrfToken(
            request.cookies[CSRF_COOKIE],
            request.headers['x-csrf-token'] as string | undefined,
          )
        )
          return await reply.code(403).send({ data: null, error: 'CSRF validation failed' });
        const parsed = priceInput(request, identity.workspaceId);
        if (!parsed)
          return await reply.code(400).send({ data: null, error: 'Invalid price request' });
        return await reply.send(successEnvelope(await catalog.savePrice(parsed), request.id));
      } catch (error) {
        return await errorReply(error, request, reply);
      }
    },
  );
  application.get(
    '/api/fanvue/accounts/:accountId/vault/media/:mediaUuid/preview',
    async (request, reply) => {
      void reply.header('Cache-Control', 'private, no-store');
      const identity = await authorizeRequest(request, auth, 'workspace:manage');
      if (!identity)
        return await reply.code(401).send({ data: null, error: 'Authentication required' });
      const path = params.safeParse(request.params);
      if (!path.success || !path.data.mediaUuid)
        return await reply.code(400).send({ data: null, error: 'Invalid preview request' });
      try {
        const media = await dependencies.reads.getMediaThumbnail({
          workspaceId: identity.workspaceId,
          accountId: path.data.accountId,
          mediaUuid: path.data.mediaUuid,
        });
        if (media.status !== 'ready' || !media.url)
          return await reply.code(404).send({ data: null, error: 'Preview unavailable' });
        const url = new URL(media.url);
        if (url.protocol !== 'https:' || url.hostname !== 'media.fanvue.com')
          return await reply.code(502).send({ data: null, error: 'Preview unavailable' });
        const response = await (dependencies.fetch ?? fetch)(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        const type = response.headers.get('content-type')?.split(';', 1)[0] ?? '';
        const length = Number(response.headers.get('content-length') ?? '0');
        if (
          !response.ok ||
          !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type) ||
          length > 5_000_000
        )
          return await reply.code(502).send({ data: null, error: 'Preview unavailable' });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 5_000_000)
          return await reply.code(502).send({ data: null, error: 'Preview unavailable' });
        void reply.header('Content-Type', type);
        return await reply.send(bytes);
      } catch (error) {
        return await errorReply(error, request, reply);
      }
    },
  );
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import { authorizeRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import { authorizeMachineRequest, MachineAuthorizationError } from '../identity/machine-auth.js';
import { verifyCsrfToken } from '../identity/session.js';
import {
  FANVUE_GUIDANCE_LIMIT,
  getFanvueGuidance,
  updateFanvueGuidance,
  type GuidanceActor,
} from './fanvue-guidance.service.js';

const paramsSchema = z.object({ accountId: z.uuid() });
const bodySchema = z.strictObject({
  guidance: z.string().refine((value) => Array.from(value).length <= FANVUE_GUIDANCE_LIMIT),
});

function parseAccountId(request: FastifyRequest): string | null {
  const parsed = paramsSchema.safeParse(request.params);
  return parsed.success ? parsed.data.accountId : null;
}

function sendGuidance(guidance: string | null, request: FastifyRequest, reply: FastifyReply) {
  void reply.header('Cache-Control', 'no-store');
  return guidance === null
    ? reply
        .code(404)
        .send(errorEnvelope('account_not_found', 'Fanvue account not found', request.id))
    : reply.send(successEnvelope({ guidance }, request.id));
}

function sendMachineError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
    return reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
  throw error;
}

function checkMachineRate(
  limiter: ApiRateLimiter,
  principal: { workspaceId: string; actorId: string },
  kind: 'read' | 'mutation',
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const decision = limiter.check(principal.workspaceId, principal.actorId, kind);
  if (decision.allowed) return null;
  void reply.header('Retry-After', decision.retryAfterSeconds ?? 1);
  return reply
    .code(429)
    .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
}

export function registerFanvueGuidanceRoutes(
  application: FastifyInstance,
  database: NodePgDatabase,
  auth: AuthService | undefined,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  delegatedAuthorization?: DelegatedAuthorizationService,
): void {
  application.get('/api/v1/fanvue/accounts/:accountId/guidance', async (request, reply) => {
    try {
      const principal = await authorizeMachineRequest(
        request,
        apiKeys,
        delegatedAuthorization,
        'fanvue:guidance:read',
      );
      if (!principal)
        return await reply
          .code(401)
          .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      const limited = checkMachineRate(rateLimiter, principal, 'read', request, reply);
      if (limited) return await limited;
      const accountId = parseAccountId(request);
      if (!accountId)
        return await reply
          .code(400)
          .send(errorEnvelope('invalid_request', 'Invalid account', request.id));
      return await sendGuidance(
        await getFanvueGuidance(database, { workspaceId: principal.workspaceId, accountId }),
        request,
        reply,
      );
    } catch (error) {
      return sendMachineError(error, request, reply);
    }
  });

  application.patch('/api/v1/fanvue/accounts/:accountId/guidance', async (request, reply) => {
    try {
      const principal = await authorizeMachineRequest(
        request,
        apiKeys,
        delegatedAuthorization,
        'fanvue:guidance:write',
      );
      if (!principal)
        return await reply
          .code(401)
          .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      const limited = checkMachineRate(rateLimiter, principal, 'mutation', request, reply);
      if (limited) return await limited;
      const accountId = parseAccountId(request);
      const body = bodySchema.safeParse(request.body);
      if (!accountId || !body.success)
        return await reply
          .code(400)
          .send(
            errorEnvelope(
              'invalid_request',
              `DM guidance must be at most ${String(FANVUE_GUIDANCE_LIMIT)} characters`,
              request.id,
            ),
          );
      const actor: GuidanceActor = {
        type: principal.kind === 'api-key' ? 'api_key' : 'delegated',
        id: principal.actorId,
      };
      return await sendGuidance(
        await updateFanvueGuidance(database, {
          workspaceId: principal.workspaceId,
          accountId,
          guidance: body.data.guidance,
          actor,
          requestId: request.id,
        }),
        request,
        reply,
      );
    } catch (error) {
      return sendMachineError(error, request, reply);
    }
  });

  if (!auth) return;
  application.get('/api/fanvue/accounts/:accountId/guidance', async (request, reply) => {
    const identity = await authorizeRequest(request, auth, 'workspace:manage');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const accountId = parseAccountId(request);
    if (!accountId) return reply.code(400).send({ data: null, error: 'Invalid account' });
    return sendGuidance(
      await getFanvueGuidance(database, { workspaceId: identity.workspaceId, accountId }),
      request,
      reply,
    );
  });
  application.patch('/api/fanvue/accounts/:accountId/guidance', async (request, reply) => {
    const identity = await authorizeRequest(request, auth, 'workspace:manage');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (
      !verifyCsrfToken(
        request.cookies[CSRF_COOKIE],
        request.headers['x-csrf-token'] as string | undefined,
      )
    )
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const accountId = parseAccountId(request);
    const body = bodySchema.safeParse(request.body);
    if (!accountId || !body.success)
      return reply.code(400).send({
        data: null,
        error: `DM guidance must be at most ${String(FANVUE_GUIDANCE_LIMIT)} characters`,
      });
    const guidance = await updateFanvueGuidance(database, {
      workspaceId: identity.workspaceId,
      accountId,
      guidance: body.data.guidance,
      actor: { type: 'user', id: identity.userId },
      requestId: request.id,
    });
    return sendGuidance(guidance, request, reply);
  });
}

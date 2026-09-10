import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { AuthService } from '../identity/auth.service.js';
import { authenticateRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import { verifyCsrfToken } from '../identity/session.js';
import { DelegatedTokenError } from './delegated-authorization.service.js';
import type { DelegatedAuthorizationService } from './delegated-authorization.service.js';
import { DelegatedAuthorizationError, type AuthorizationRequest } from './protocol.js';

const authorizationSchema = z.object({
  client_id: z.string().trim().min(1).max(200),
  redirect_uri: z.url(),
  state: z.string().min(1).max(500),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  scope: z.string().trim().min(1).max(1_000),
});
const approvalSchema = authorizationSchema;
const tokenSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1),
    client_id: z.string().min(1),
    redirect_uri: z.url(),
    code_verifier: z.string().min(43).max(128),
  }),
  z.object({ grant_type: z.literal('refresh_token'), refresh_token: z.string().min(1) }),
]);
const grantParamsSchema = z.object({ grantId: z.uuid() });

function hasValidCsrf(request: FastifyRequest): boolean {
  return verifyCsrfToken(
    request.cookies[CSRF_COOKIE],
    request.headers['x-csrf-token'] as string | undefined,
  );
}

function toAuthorizationRequest(input: z.infer<typeof authorizationSchema>): AuthorizationRequest {
  return {
    clientId: input.client_id,
    redirectUri: input.redirect_uri,
    state: input.state,
    codeChallenge: input.code_challenge,
    codeChallengeMethod: input.code_challenge_method,
    requestedScopes: input.scope.split(/\s+/).filter(Boolean),
  };
}

export function registerDelegatedAuthorizationRoutes(
  application: FastifyInstance,
  service: DelegatedAuthorizationService,
  auth: AuthService,
): void {
  application.get('/connect/authorize', async (request, reply) => {
    const identity = await authenticateRequest(request, auth);
    if (!identity) return reply.code(401).send({ data: null, error: { code: 'login_required' } });
    const parsed = authorizationSchema.safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ data: null, error: { code: 'invalid_request' } });
    try {
      const client = await service.inspectAuthorization(toAuthorizationRequest(parsed.data));
      return {
        data: {
          client: { id: client.id },
          workspaceId: identity.workspaceId,
          scopes: [...new Set(parsed.data.scope.split(/\s+/).filter(Boolean))],
          state: parsed.data.state,
        },
        error: null,
      };
    } catch (error) {
      return sendProtocolError(reply, error);
    }
  });

  application.post('/connect/authorize', async (request, reply) => {
    const identity = await authenticateRequest(request, auth);
    if (!identity) return reply.code(401).send({ data: null, error: { code: 'login_required' } });
    if (!hasValidCsrf(request))
      return reply.code(403).send({ data: null, error: { code: 'csrf_failed' } });
    const parsed = approvalSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ data: null, error: { code: 'invalid_request' } });
    const input = toAuthorizationRequest(parsed.data);
    try {
      const result = await service.approve({
        ...input,
        grantId: randomUUID(),
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        scopes: input.requestedScopes as string[],
      });
      const redirect = new URL(input.redirectUri);
      redirect.searchParams.set('code', result.code);
      redirect.searchParams.set('state', input.state);
      void reply.header('Cache-Control', 'no-store');
      return await reply.redirect(redirect.toString());
    } catch (error) {
      return sendProtocolError(reply, error);
    }
  });

  application.post('/connect/token', async (request, reply) => {
    const parsed = tokenSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: 'invalid_request', error_description: 'Invalid token request' });
    try {
      const token =
        parsed.data.grant_type === 'authorization_code'
          ? await service.exchangeCode({
              code: parsed.data.code,
              clientId: parsed.data.client_id,
              redirectUri: parsed.data.redirect_uri,
              codeVerifier: parsed.data.code_verifier,
            })
          : await service.refresh(parsed.data.refresh_token);
      void reply.header('Cache-Control', 'no-store');
      return {
        access_token: token.accessToken,
        refresh_token: token.refreshToken,
        token_type: token.tokenType,
        expires_in: token.expiresIn,
      };
    } catch (error) {
      if (error instanceof DelegatedTokenError)
        return reply.code(400).send({ error: error.code, error_description: error.message });
      throw error;
    }
  });

  application.delete('/api/settings/delegated-grants/:grantId', async (request, reply) => {
    const identity = await authenticateRequest(request, auth);
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (!hasValidCsrf(request))
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const parsed = grantParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ data: null, error: 'Grant not found' });
    const revoked = await service.revoke(
      identity.workspaceId,
      identity.userId,
      parsed.data.grantId,
    );
    return revoked
      ? { data: { revoked: true }, error: null }
      : reply.code(404).send({ data: null, error: 'Grant not found' });
  });
}

function sendProtocolError(reply: FastifyReply, error: unknown) {
  if (error instanceof DelegatedAuthorizationError)
    return reply.code(error.code === 'invalid_client' ? 401 : 400).send({
      data: null,
      error: { code: error.code, message: error.message },
    });
  throw error;
}

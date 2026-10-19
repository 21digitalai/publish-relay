import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';

import { mutationFingerprint, validateIdempotencyKey } from '../api/idempotency.js';
import { executeBrowserMutation } from '../content/browser-idempotency.repository.js';
import { authorizeRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { WorkspaceAuthorizationError } from '../identity/authorization.js';
import { verifyCsrfToken } from '../identity/session.js';
import { ActionPolicyDeniedError, type ActionPolicy } from '../policy/action-policy.js';
import { TikTokConsentInvalidError } from './tiktok-consent.service.js';
import {
  prepareTikTokDraftInTransaction,
  tiktokDraftRequestSchema,
} from './tiktok-draft.service.js';

export function registerTikTokDraftRoutes(
  application: FastifyInstance,
  dependencies: {
    auth: AuthService;
    database: NodePgDatabase;
    actionPolicy: ActionPolicy;
  },
): void {
  application.post('/api/workflow/tiktok-drafts', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    try {
      const identity = await authorizeRequest(request, dependencies.auth, 'content:write');
      if (!identity)
        return await reply.code(401).send({ data: null, error: 'Authentication required' });
      if (
        !verifyCsrfToken(
          request.cookies[CSRF_COOKIE],
          request.headers['x-csrf-token'] as string | undefined,
        )
      )
        return await reply.code(403).send({ data: null, error: 'CSRF validation failed' });
      const parsed = tiktokDraftRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return await reply.code(400).send({ data: null, error: 'Invalid TikTok draft' });
      let key: string;
      try {
        key = validateIdempotencyKey(request.headers['idempotency-key'] as string | undefined);
      } catch {
        return await reply.code(400).send({ data: null, error: 'Idempotency-Key is required' });
      }
      const result = await executeBrowserMutation(
        dependencies.database,
        {
          workspaceId: identity.workspaceId,
          userId: identity.userId,
          operation: 'prepare-tiktok-draft',
          idempotencyKey: key,
          requestFingerprint: mutationFingerprint(parsed.data),
        },
        async (transaction) => {
          const draft = await prepareTikTokDraftInTransaction(
            transaction,
            {
              ...parsed.data,
              workspaceId: identity.workspaceId,
              userId: identity.userId,
              requestId: request.id,
            },
            dependencies.actionPolicy,
          );
          return { statusCode: 201, body: { data: draft, error: null } };
        },
      );
      if (result.kind === 'conflict')
        return await reply
          .code(409)
          .send({ data: null, error: 'Idempotency key was already used' });
      if (result.kind === 'replayed') reply.header('idempotency-replayed', 'true');
      return await reply.code(result.response.statusCode).send(result.response.body);
    } catch (error) {
      if (error instanceof WorkspaceAuthorizationError || error instanceof ActionPolicyDeniedError)
        return await reply.code(403).send({ data: null, error: 'TikTok draft is not allowed' });
      if (error instanceof TikTokConsentInvalidError)
        return await reply
          .code(409)
          .send({ data: null, error: 'TikTok destination or media changed' });
      throw error;
    }
  });
}

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { mutationFingerprint, validateIdempotencyKey } from '../api/idempotency.js';
import { executeBrowserMutation } from '../content/browser-idempotency.repository.js';
import { PostNotFoundError, PostValidationError } from '../content/post.errors.js';
import { authorizeRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { WorkspaceAuthorizationError } from '../identity/authorization.js';
import { verifyCsrfToken } from '../identity/session.js';
import { ActionPolicyDeniedError, type ActionPolicy } from '../policy/action-policy.js';
import { TikTokConsentInvalidError } from './tiktok-consent.service.js';
import {
  getPreparedTikTokDraft,
  listPreparedTikTokDrafts,
  prepareTikTokDraftInTransaction,
  revisePreparedTikTokDraftInTransaction,
  TikTokDraftUnavailableError,
  tiktokDraftRevisionSchema,
  tiktokDraftRequestSchema,
} from './tiktok-draft.service.js';

const postParamsSchema = z.strictObject({ postId: z.uuid() });
const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    before: z.iso.datetime().optional(),
    beforeId: z.uuid().optional(),
  })
  .refine((query) => Boolean(query.before) === Boolean(query.beforeId));

export function registerTikTokDraftRoutes(
  application: FastifyInstance,
  dependencies: {
    auth: AuthService;
    database: NodePgDatabase;
    actionPolicy: ActionPolicy;
  },
): void {
  application.get('/api/workflow/tiktok-drafts', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    try {
      const identity = await authorizeRequest(request, dependencies.auth, 'content:read');
      if (!identity)
        return await reply.code(401).send({ data: null, error: 'Authentication required' });
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success)
        return await reply.code(400).send({ data: null, error: 'Invalid draft query' });
      const drafts = await listPreparedTikTokDrafts(dependencies.database, {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        limit: query.data.limit,
        ...(query.data.before ? { before: query.data.before } : {}),
        ...(query.data.beforeId ? { beforeId: query.data.beforeId } : {}),
      });
      return await reply.send({ data: drafts, error: null });
    } catch (error) {
      if (
        error instanceof WorkspaceAuthorizationError ||
        error instanceof TikTokDraftUnavailableError
      )
        return await reply.code(403).send({ data: null, error: 'TikTok drafts are not available' });
      throw error;
    }
  });

  application.get('/api/workflow/tiktok-drafts/:postId', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    try {
      const identity = await authorizeRequest(request, dependencies.auth, 'content:read');
      if (!identity)
        return await reply.code(401).send({ data: null, error: 'Authentication required' });
      const params = postParamsSchema.safeParse(request.params);
      if (!params.success)
        return await reply.code(400).send({ data: null, error: 'Invalid draft id' });
      const draft = await getPreparedTikTokDraft(dependencies.database, {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        postId: params.data.postId,
      });
      return await reply.send({ data: draft, error: null });
    } catch (error) {
      if (error instanceof WorkspaceAuthorizationError)
        return await reply.code(403).send({ data: null, error: 'TikTok draft is not allowed' });
      if (error instanceof TikTokDraftUnavailableError)
        return await reply.code(404).send({ data: null, error: 'TikTok draft was not found' });
      throw error;
    }
  });

  application.patch('/api/workflow/tiktok-drafts/:postId', async (request, reply) => {
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
      const params = postParamsSchema.safeParse(request.params);
      const body = tiktokDraftRevisionSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return await reply.code(400).send({ data: null, error: 'Invalid TikTok revision' });
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
          operation: `revise-tiktok-draft:${params.data.postId}`,
          idempotencyKey: key,
          requestFingerprint: mutationFingerprint(body.data),
        },
        async (transaction) => {
          const revision = await revisePreparedTikTokDraftInTransaction(
            transaction,
            {
              workspaceId: identity.workspaceId,
              userId: identity.userId,
              postId: params.data.postId,
              content: body.data.content,
              requestId: request.id,
            },
            dependencies.actionPolicy,
          );
          return { statusCode: 200, body: { data: revision, error: null } };
        },
      );
      if (result.kind === 'conflict')
        return await reply
          .code(409)
          .send({ data: null, error: 'Idempotency key was already used' });
      if (result.kind === 'replayed') reply.header('idempotency-replayed', 'true');
      return await reply.code(result.response.statusCode).send(result.response.body);
    } catch (error) {
      if (
        error instanceof WorkspaceAuthorizationError ||
        error instanceof ActionPolicyDeniedError ||
        error instanceof TikTokDraftUnavailableError
      )
        return await reply.code(403).send({ data: null, error: 'TikTok draft is not allowed' });
      if (error instanceof TikTokConsentInvalidError)
        return await reply.code(409).send({ data: null, error: 'TikTok draft changed' });
      if (error instanceof PostNotFoundError)
        return await reply.code(404).send({ data: null, error: 'TikTok draft was not found' });
      if (error instanceof PostValidationError)
        return await reply.code(409).send({ data: null, error: error.message });
      throw error;
    }
  });

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

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { authorizeRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { WorkspaceAuthorizationError } from '../identity/authorization.js';
import { verifyCsrfToken } from '../identity/session.js';
import {
  resolveSnapchatStoryEvidence,
  SnapchatStoryResolutionConflict,
  SnapchatStoryResolutionNotFound,
  snapchatStoryResolutionSchema,
} from './snapchat-story-resolution.service.js';

const paramsSchema = z.strictObject({ jobId: z.uuid() });

export function registerSnapchatStoryResolutionRoutes(
  application: FastifyInstance,
  dependencies: { auth: AuthService; database: NodePgDatabase },
): void {
  application.post(
    '/api/workflow/jobs/:jobId/snapchat-story-resolution',
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      try {
        const identity = await authorizeRequest(request, dependencies.auth, 'workspace:manage');
        if (!identity)
          return await reply.code(401).send({ data: null, error: 'Authentication required' });
        if (
          !verifyCsrfToken(
            request.cookies[CSRF_COOKIE],
            request.headers['x-csrf-token'] as string | undefined,
          )
        )
          return await reply.code(403).send({ data: null, error: 'CSRF validation failed' });
        const params = paramsSchema.safeParse(request.params);
        const body = snapchatStoryResolutionSchema.safeParse(request.body);
        if (!params.success || !body.success)
          return await reply.code(400).send({ data: null, error: 'Invalid Story evidence' });
        const result = await resolveSnapchatStoryEvidence(dependencies.database, {
          workspaceId: identity.workspaceId,
          userId: identity.userId,
          jobId: params.data.jobId,
          requestId: request.id,
          evidence: body.data,
        });
        return await reply.send({ data: result, error: null });
      } catch (error) {
        if (error instanceof WorkspaceAuthorizationError)
          return await reply
            .code(403)
            .send({ data: null, error: 'Story resolution is not allowed' });
        if (error instanceof SnapchatStoryResolutionNotFound)
          return await reply.code(404).send({ data: null, error: 'Story job was not found' });
        if (error instanceof SnapchatStoryResolutionConflict)
          return await reply.code(409).send({ data: null, error: error.message });
        throw error;
      }
    },
  );
}

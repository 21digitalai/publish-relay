import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { authorizeRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { verifyCsrfToken } from '../identity/session.js';
import type { DmUploadKey } from './fanvue-dm-upload-init.repository.js';
import {
  EngagementProposalError,
  getEngagementProposal,
} from './engagement-proposal.repository.js';
import { FanvueReadUnavailableError } from './fanvue-read.service.js';

const params = z.strictObject({ proposalId: z.uuid(), mediaId: z.uuid() });
const body = z.strictObject({ expectedRevision: z.number().int().positive() });
const mediaContent = z.object({ mediaIds: z.array(z.uuid()).max(10).optional() });
type Stage = (
  input: DmUploadKey,
) => Promise<'uploading' | 'processing' | 'ready' | 'unknown' | 'failed'>;

/** Browser staging derives account and action ownership from the saved proposal, never the request. */
export function registerEngagementDmMediaRoutes(
  application: FastifyInstance,
  dependencies: { database: NodePgDatabase; auth: AuthService; stage: Stage },
): void {
  application.post(
    '/api/engagement-proposals/:proposalId/media/:mediaId/stage',
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      const identity = await authorizeRequest(request, dependencies.auth, 'workspace:manage');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      if (
        !verifyCsrfToken(
          request.cookies[CSRF_COOKIE],
          request.headers['x-csrf-token'] as string | undefined,
        )
      )
        return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
      const path = params.safeParse(request.params);
      const input = body.safeParse(request.body);
      if (!path.success || !input.success)
        return reply.code(400).send({ data: null, error: 'Invalid proposal media stage request' });
      const proposal = await getEngagementProposal(
        dependencies.database,
        identity.workspaceId,
        path.data.proposalId,
      );
      if (!proposal)
        return reply
          .code(409)
          .send({ data: null, error: 'Proposal media is stale or unavailable' });
      const content = mediaContent.safeParse(proposal.content);
      if (
        proposal.status !== 'pending' ||
        proposal.revision !== input.data.expectedRevision ||
        proposal.provider !== 'fanvue' ||
        proposal.kind !== 'dm' ||
        !content.success ||
        !content.data.mediaIds?.includes(path.data.mediaId)
      )
        return reply
          .code(409)
          .send({ data: null, error: 'Proposal media is stale or unavailable' });
      try {
        const state = await dependencies.stage({
          workspaceId: identity.workspaceId,
          accountId: proposal.accountId,
          clientActionId: proposal.clientActionId,
          mediaId: path.data.mediaId,
        });
        return await reply
          .code(state === 'ready' ? 200 : 202)
          .send({ data: { state }, error: null });
      } catch (error) {
        if (error instanceof FanvueReadUnavailableError)
          return reply
            .code(409)
            .send({ data: null, error: 'Fanvue account or consent unavailable' });
        if (error instanceof EngagementProposalError)
          return reply.code(error.statusCode).send({ data: null, error: error.message });
        request.log.error({ err: error }, 'Proposal media staging failed');
        return reply
          .code(409)
          .send({ data: null, error: 'Media stage unavailable; refresh before retry' });
      }
    },
  );
}

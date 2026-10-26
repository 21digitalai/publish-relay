import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { authorizeRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { verifyCsrfToken } from '../identity/session.js';
import { EngagementProposalError } from './engagement-proposal.repository.js';
import {
  approveEngagementProposal,
  type EngagementSendCommands,
} from './engagement-approval.service.js';

const paramsSchema = z.strictObject({ proposalId: z.uuid() });
const approvalSchema = z.strictObject({ expectedRevision: z.number().int().positive() });

export function registerEngagementApprovalRoutes(
  application: FastifyInstance,
  dependencies: {
    database: NodePgDatabase;
    auth: AuthService;
    comments: EngagementSendCommands['comments'];
    messages: EngagementSendCommands['messages'];
  },
): void {
  application.post('/api/engagement-proposals/:proposalId/approve', async (request, reply) => {
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
    const params = paramsSchema.safeParse(request.params);
    const body = approvalSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send({ data: null, error: 'Invalid proposal approval' });

    try {
      const outcome = await approveEngagementProposal(dependencies.database, dependencies, {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        proposalId: params.data.proposalId,
        expectedRevision: body.data.expectedRevision,
      });
      return await reply
        .code(outcome.status === 'unknown' ? 202 : 200)
        .send({ data: outcome, error: null });
    } catch (error) {
      if (error instanceof EngagementProposalError)
        return reply.code(error.statusCode).send({ data: null, error: error.message });
      throw error;
    }
  });
}

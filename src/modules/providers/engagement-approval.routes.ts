import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { authorizeRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { verifyCsrfToken } from '../identity/session.js';
import {
  EngagementProposalError,
  getEngagementProposal,
} from './engagement-proposal.repository.js';
import {
  PendingDmConflictError,
  PendingDmNoGoError,
  cancelScheduledProposalPageDm,
  scheduleApprovedPageDm,
} from './facebook-dm-pending.repository.js';
import { PageDmScheduleWindowError } from './facebook-dm-schedule-time.js';
import {
  inboundFingerprint,
  previewApprovedPageDm,
} from './facebook-dm-approval-preview.service.js';
import {
  FacebookDmConversationChangedError,
  FacebookDmWindowClosedError,
} from './facebook-messenger-send.service.js';
import { PageReadUnavailableError } from './facebook-page-read-context.service.js';
import {
  cancelScheduledProposalPageComment,
  PendingCommentConflictError,
} from './facebook-comment-pending.repository.js';
import {
  approveEngagementProposal,
  type EngagementSendCommands,
} from './engagement-approval.service.js';

const paramsSchema = z.strictObject({ proposalId: z.uuid() });
const approvalSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  sendMode: z.enum(['scheduled', 'immediate']).optional(),
  dueAt: z.iso.datetime().optional(),
  previewedAt: z.iso.datetime().optional(),
  latestInboundFingerprint: z.string().length(64).optional(),
});

export function registerEngagementApprovalRoutes(
  application: FastifyInstance,
  dependencies: {
    database: NodePgDatabase;
    auth: AuthService;
  } & EngagementSendCommands,
): void {
  application.get('/api/engagement-proposals/:proposalId/reply-window', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    const identity = await authorizeRequest(request, dependencies.auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ data: null, error: 'Proposal not found' });
    const proposal = await getEngagementProposal(
      dependencies.database,
      identity.workspaceId,
      params.data.proposalId,
    );
    if (proposal?.provider !== 'facebook_page' || proposal.kind !== 'dm')
      return reply.code(404).send({ data: null, error: 'Proposal not found' });
    if (!dependencies.facebook) return { data: { state: 'unavailable' }, error: null };
    try {
      const window = await dependencies.facebook.previewDmWindow({
        workspaceId: identity.workspaceId,
        accountId: proposal.accountId,
        conversationId: proposal.targetId,
      });
      const source = proposal.sourceContext as { sourceMessageId?: unknown };
      if (
        typeof source.sourceMessageId === 'string' &&
        source.sourceMessageId !== window.latestInboundMessageId
      )
        return { data: { state: 'stale' }, error: null };
      return {
        data: {
          state: 'open',
          latestInboundAt: window.latestInboundAt.toISOString(),
          windowDeadline: window.windowDeadline.toISOString(),
        },
        error: null,
      };
    } catch (error) {
      if (error instanceof FacebookDmWindowClosedError)
        return { data: { state: 'closed' }, error: null };
      if (error instanceof PageReadUnavailableError)
        return { data: { state: 'unavailable' }, error: null };
      throw error;
    }
  });
  application.post(
    '/api/engagement-proposals/:proposalId/approve-preview',
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
      const params = paramsSchema.safeParse(request.params);
      const body = z
        .strictObject({ expectedRevision: z.number().int().positive() })
        .safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ data: null, error: 'Invalid approval preview' });
      if (!dependencies.facebook)
        return reply.code(409).send({ data: null, error: 'Proposal cannot be scheduled' });
      try {
        const preview = await previewApprovedPageDm(
          dependencies.database,
          dependencies.facebook.previewDmWindow,
          {
            workspaceId: identity.workspaceId,
            proposalId: params.data.proposalId,
            expectedRevision: body.data.expectedRevision,
          },
        );
        return { data: preview, error: null };
      } catch (error) {
        if (
          error instanceof PageDmScheduleWindowError ||
          error instanceof PendingDmConflictError ||
          error instanceof PageReadUnavailableError ||
          error instanceof FacebookDmWindowClosedError ||
          error instanceof FacebookDmConversationChangedError
        )
          return reply.code(409).send({ data: null, error: error.message });
        throw error;
      }
    },
  );
  application.post(
    '/api/engagement-proposals/:proposalId/cancel-scheduled',
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
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ data: null, error: 'Invalid proposal' });
      const proposal = await getEngagementProposal(
        dependencies.database,
        identity.workspaceId,
        params.data.proposalId,
      );
      const cancelled = await (proposal?.provider === 'facebook_page' && proposal.kind === 'comment'
        ? cancelScheduledProposalPageComment(dependencies.database, {
            workspaceId: identity.workspaceId,
            proposalId: params.data.proposalId,
          })
        : cancelScheduledProposalPageDm(dependencies.database, {
            workspaceId: identity.workspaceId,
            proposalId: params.data.proposalId,
          }));
      if (!cancelled)
        return reply
          .code(409)
          .send({ data: null, error: 'Reply is no longer pending cancellation' });
      return { data: { status: 'cancelled' }, error: null };
    },
  );

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
      const proposal = await getEngagementProposal(
        dependencies.database,
        identity.workspaceId,
        params.data.proposalId,
      );
      if (
        proposal?.provider === 'facebook_page' &&
        proposal.kind === 'dm' &&
        body.data.sendMode === 'immediate' &&
        typeof proposal.content === 'object' &&
        proposal.content !== null &&
        'followUps' in proposal.content
      )
        return await reply
          .code(409)
          .send({ data: null, error: 'Grouped replies must be approved as one scheduled plan' });
      if (
        proposal?.provider === 'facebook_page' &&
        proposal.kind === 'dm' &&
        body.data.sendMode !== 'immediate'
      ) {
        if (
          !body.data.dueAt ||
          !body.data.previewedAt ||
          !body.data.latestInboundFingerprint ||
          !dependencies.facebook
        )
          return await reply
            .code(409)
            .send({ data: null, error: 'Preview the final send time first' });
        const window = await dependencies.facebook.previewDmWindow({
          workspaceId: identity.workspaceId,
          accountId: proposal.accountId,
          conversationId: proposal.targetId,
        });
        if (
          inboundFingerprint(window.latestInboundMessageId) !== body.data.latestInboundFingerprint
        )
          throw new FacebookDmConversationChangedError();
        const source = proposal.sourceContext as { sourceMessageId?: unknown };
        if (
          typeof source.sourceMessageId === 'string' &&
          source.sourceMessageId !== window.latestInboundMessageId
        )
          throw new FacebookDmConversationChangedError();
        const scheduled = await scheduleApprovedPageDm(dependencies.database, {
          workspaceId: identity.workspaceId,
          userId: identity.userId,
          proposalId: params.data.proposalId,
          expectedRevision: body.data.expectedRevision,
          dueAt: new Date(body.data.dueAt),
          previewedAt: new Date(body.data.previewedAt),
          windowDeadline: window.windowDeadline,
          latestInboundMessageId: window.latestInboundMessageId,
        });
        return await reply.code(202).send({ data: scheduled, error: null });
      }
      if (
        proposal?.provider === 'facebook_page' &&
        proposal.kind === 'comment' &&
        body.data.sendMode !== 'immediate'
      ) {
        if (proposal.status !== 'pending' || proposal.revision !== body.data.expectedRevision)
          return await reply
            .code(409)
            .send({ data: null, error: 'Proposal is stale or unavailable' });
        if (!dependencies.facebook?.scheduleComment)
          return await reply
            .code(409)
            .send({ data: null, error: 'Page comment scheduling is unavailable' });
        const scheduled = await dependencies.facebook.scheduleComment({
          workspaceId: identity.workspaceId,
          userId: identity.userId,
          proposalId: params.data.proposalId,
          expectedRevision: body.data.expectedRevision,
        });
        return await reply.code(202).send({ data: scheduled, error: null });
      }
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
      if (
        error instanceof PendingDmConflictError ||
        error instanceof PendingCommentConflictError ||
        error instanceof PendingDmNoGoError ||
        error instanceof PageReadUnavailableError ||
        error instanceof FacebookDmWindowClosedError ||
        error instanceof FacebookDmConversationChangedError
      )
        return reply.code(409).send({ data: null, error: error.message });
      throw error;
    }
  });
}

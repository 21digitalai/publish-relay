import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import { authorizeRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { authorizeMachineRequest, MachineAuthorizationError } from '../identity/machine-auth.js';
import { verifyCsrfToken } from '../identity/session.js';
import {
  createEngagementProposal,
  dismissEngagementProposal,
  EngagementProposalError,
  getEngagementProposal,
  listEngagementReviewQueue,
  reviseEngagementProposal,
  type ProposalContent,
} from './engagement-proposal.repository.js';
import { authorizePageEngagement } from './facebook-page-engagement.service.js';
import { listPageDmHistory } from './facebook-dm-history.repository.js';
import {
  isPageConversationNoGo,
  listWorkspacePageNoGo,
  setPageConversationNoGo,
} from './facebook-dm-no-go.repository.js';
import {
  getPageDmDelayWindow,
  getScheduledProposalPageDm,
  setPageDmDelayWindow,
} from './facebook-dm-pending.repository.js';
import { getScheduledProposalPageComment } from './facebook-comment-pending.repository.js';
import {
  listPageCommentHistory,
  pageCommentPostLink,
} from './facebook-comment-history.repository.js';
import { listFanvueActionHistory } from './fanvue-action-history.repository.js';

const contentSchema = z.strictObject({
  text: z.string().trim().min(1).max(5000),
  followUps: z
    .tuple([z.string().trim().min(1).max(2000), z.string().trim().min(1).max(2000)])
    .optional(),
  mediaIds: z.array(z.uuid()).max(10).optional(),
  priceCents: z.number().int().nonnegative().max(100000000).optional(),
});
export const createEngagementProposalSchema = z.strictObject({
  accountId: z.uuid(),
  clientActionId: z.uuid(),
  provider: z.string().trim().min(1).max(50),
  kind: z.enum(['dm', 'comment']),
  targetId: z.string().trim().min(1).max(200),
  sourceContext: z
    .strictObject({
      text: z.string().max(5000).optional(),
      authorLabel: z.string().max(200).optional(),
      postId: z
        .string()
        .regex(/^[0-9]+(?:_[0-9]+)*$/)
        .max(256)
        .optional(),
      sourceMessageId: z.string().max(256).optional(),
    })
    .optional(),
  content: contentSchema,
  plannedDueAt: z.iso.datetime({ offset: true }).optional(),
});
const paramsSchema = z.strictObject({ proposalId: z.uuid() });
const reviseSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  content: contentSchema,
});
const dismissSchema = z.strictObject({ expectedRevision: z.number().int().positive() });
const cursorSchema = z.strictObject({ createdAt: z.iso.datetime(), id: z.uuid() });
const PAGE_SIZE = 50;

function validFacebookProposal(input: z.infer<typeof createEngagementProposalSchema>): boolean {
  if (input.provider !== 'facebook_page') return !input.content.followUps;
  if (
    input.content.mediaIds?.length ||
    input.content.priceCents !== undefined ||
    input.content.text.length > 2000 ||
    (input.content.followUps && input.kind !== 'dm')
  )
    return false;
  if (input.kind === 'comment')
    return /^[0-9]+(?:_[0-9]+)*$/.test(input.targetId) && Boolean(input.sourceContext?.postId);
  return (
    /^[A-Za-z0-9_]+$/.test(input.targetId) &&
    (!input.content.followUps || Boolean(input.sourceContext?.sourceMessageId)) &&
    Boolean(input.plannedDueAt) &&
    Date.parse(input.plannedDueAt ?? '') > Date.now()
  );
}

function parseCursor(value: string | undefined): z.infer<typeof cursorSchema> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return cursorSchema.parse(parsed);
  } catch {
    throw new Error('Invalid proposal cursor');
  }
}

function validCsrf(request: FastifyRequest): boolean {
  return verifyCsrfToken(
    request.cookies[CSRF_COOKIE],
    request.headers['x-csrf-token'] as string | undefined,
  );
}

function normalizeContent(input: z.infer<typeof contentSchema>): ProposalContent {
  return {
    text: input.text,
    ...(input.followUps ? { followUps: input.followUps } : {}),
    ...(input.mediaIds !== undefined ? { mediaIds: input.mediaIds } : {}),
    ...(input.priceCents !== undefined ? { priceCents: input.priceCents } : {}),
  };
}

function representation(
  row: Awaited<ReturnType<typeof createEngagementProposal>> & { accountDisplayName?: string },
) {
  return {
    id: row.id,
    accountId: row.accountId,
    ...(row.accountDisplayName ? { accountDisplayName: row.accountDisplayName } : {}),
    provider: row.provider,
    kind: row.kind,
    targetId: row.targetId,
    sourceContext: row.sourceContext,
    content: row.content,
    ...(row.plannedDueAt ? { plannedDueAt: row.plannedDueAt.toISOString() } : {}),
    proposerType: row.proposerType,
    status: row.status,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function previewText(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('text' in value)) return '';
  return typeof value.text === 'string' ? value.text.slice(0, 280) : '';
}

function bubbleCount(value: unknown): number {
  if (typeof value !== 'object' || value === null || !('followUps' in value)) return 1;
  return Array.isArray(value.followUps) && value.followUps.length === 2 ? 3 : 1;
}

function summary(
  row: Awaited<ReturnType<typeof createEngagementProposal>> & { accountDisplayName: string },
) {
  return {
    id: row.id,
    accountId: row.accountId,
    accountDisplayName: row.accountDisplayName,
    provider: row.provider,
    kind: row.kind,
    status: row.status,
    sourcePreview: previewText(row.sourceContext),
    ...(row.plannedDueAt ? { plannedDueAt: row.plannedDueAt.toISOString() } : {}),
    contentPreview: previewText(row.content),
    bubbleCount:
      row.provider === 'facebook_page' && row.kind === 'dm' ? bubbleCount(row.content) : 1,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
  };
}

function proposalError(error: unknown): { status: number; message: string } | null {
  if (error instanceof MachineAuthorizationError || error instanceof ApiKeyAuthorizationError)
    return { status: 403, message: 'Proposal capability is required' };
  if (error instanceof EngagementProposalError)
    return { status: error.statusCode, message: error.message };
  return null;
}

export function registerEngagementProposalRoutes(
  application: FastifyInstance,
  dependencies: {
    database: NodePgDatabase;
    auth?: AuthService;
    apiKeys?: ApiKeyService;
    rateLimiter?: ApiRateLimiter;
    delegatedAuthorization?: DelegatedAuthorizationService;
  },
): void {
  const { database, auth, apiKeys, rateLimiter, delegatedAuthorization } = dependencies;

  if (apiKeys)
    application.get('/api/v1/facebook-page-dm-delay-default/:accountId', async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      try {
        const principal = await authorizeMachineRequest(
          request,
          apiKeys,
          delegatedAuthorization,
          'engagement:propose',
        );
        if (!principal)
          return await reply.code(401).send({ data: null, error: 'Authentication required' });
        const params = z.strictObject({ accountId: z.uuid() }).safeParse(request.params);
        if (!params.success)
          return await reply.code(400).send({ data: null, error: 'Invalid Page account' });
        const allowed = await authorizePageEngagement(database, {
          workspaceId: principal.workspaceId,
          accountId: params.data.accountId,
          principal: {
            kind: principal.kind,
            actorId: principal.actorId,
            workspaceId: principal.workspaceId,
          },
          capability: 'dms:propose',
        });
        if (!allowed)
          return await reply
            .code(403)
            .send({ data: null, error: 'Page proposal access is unavailable' });
        const window = await getPageDmDelayWindow(database, {
          workspaceId: principal.workspaceId,
          accountId: params.data.accountId,
        });
        return { data: window, error: null };
      } catch (error) {
        const known = proposalError(error);
        if (known) return reply.code(known.status).send({ data: null, error: known.message });
        throw error;
      }
    });

  if (apiKeys)
    application.post('/api/v1/engagement-proposals', async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      try {
        const principal = await authorizeMachineRequest(
          request,
          apiKeys,
          delegatedAuthorization,
          'engagement:propose',
        );
        if (!principal)
          return await reply.code(401).send({ data: null, error: 'Authentication required' });
        const decision = rateLimiter?.check(principal.workspaceId, principal.actorId, 'mutation');
        if (decision && !decision.allowed)
          return await reply.code(429).send({ data: null, error: 'Rate limit exceeded' });
        const input = createEngagementProposalSchema.safeParse(request.body);
        if (!input.success || !validFacebookProposal(input.data))
          return await reply.code(400).send({ data: null, error: 'Invalid proposal' });
        if (input.data.provider === 'facebook_page') {
          const allowed = await authorizePageEngagement(database, {
            workspaceId: principal.workspaceId,
            accountId: input.data.accountId,
            principal: {
              kind: principal.kind,
              actorId: principal.actorId,
              workspaceId: principal.workspaceId,
            },
            capability: input.data.kind === 'comment' ? 'comments:propose' : 'dms:propose',
          });
          if (!allowed) throw new MachineAuthorizationError('Page proposal access is unavailable');
        }
        const row = await createEngagementProposal(database, {
          ...input.data,
          plannedDueAt: undefined,
          content: normalizeContent(input.data.content),
          ...(input.data.plannedDueAt ? { plannedDueAt: new Date(input.data.plannedDueAt) } : {}),
          sourceContext: input.data.sourceContext ?? {},
          workspaceId: principal.workspaceId,
          proposerType: principal.kind === 'api-key' ? 'api_key' : 'delegated',
          proposerId: principal.actorId,
        });
        return await reply.code(201).send({ data: representation(row), error: null });
      } catch (error) {
        const known = proposalError(error);
        if (known) return await reply.code(known.status).send({ data: null, error: known.message });
        throw error;
      }
    });

  if (apiKeys)
    application.get('/api/v1/engagement-proposals/:proposalId/status', async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      try {
        const principal = await authorizeMachineRequest(
          request,
          apiKeys,
          delegatedAuthorization,
          'engagement:propose',
        );
        if (!principal)
          return await reply.code(401).send({ data: null, error: 'Authentication required' });
        const params = paramsSchema.safeParse(request.params);
        if (!params.success)
          return await reply.code(400).send({ data: null, error: 'Invalid proposal' });
        const row = await getEngagementProposal(
          database,
          principal.workspaceId,
          params.data.proposalId,
        );
        if (row?.provider !== 'facebook_page' || row.kind !== 'dm')
          return await reply.code(404).send({ data: null, error: 'Proposal not found' });
        const allowed = await authorizePageEngagement(database, {
          workspaceId: principal.workspaceId,
          accountId: row.accountId,
          principal: {
            kind: principal.kind,
            actorId: principal.actorId,
            workspaceId: principal.workspaceId,
          },
          capability: 'dms:propose',
        });
        if (!allowed)
          return await reply
            .code(403)
            .send({ data: null, error: 'Page proposal access is unavailable' });
        return {
          data: {
            id: row.id,
            status: row.status,
            ...(row.plannedDueAt ? { plannedDueAt: row.plannedDueAt.toISOString() } : {}),
          },
          error: null,
        };
      } catch (error) {
        const known = proposalError(error);
        if (known) return await reply.code(known.status).send({ data: null, error: known.message });
        throw error;
      }
    });

  if (!auth) return;
  application.get('/api/facebook-page-dm-history', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    const identity = await authorizeRequest(request, auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const query = z
      .strictObject({
        accountId: z.uuid().optional(),
        conversationId: z
          .string()
          .regex(/^[A-Za-z0-9_]+$/)
          .max(256)
          .optional(),
        cursor: z.string().max(512).optional(),
      })
      .safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ data: null, error: 'Invalid DM history filter' });
    let cursor: { createdAt: Date; id: string } | null = null;
    if (query.data.cursor) {
      try {
        const parsed: unknown = JSON.parse(
          Buffer.from(query.data.cursor, 'base64url').toString('utf8'),
        );
        const value = cursorSchema.parse(parsed);
        cursor = { createdAt: new Date(value.createdAt), id: value.id };
      } catch {
        return reply.code(400).send({ data: null, error: 'Invalid DM history cursor' });
      }
    }
    const rows = await listPageDmHistory(database, {
      workspaceId: identity.workspaceId,
      accountId: query.data.accountId,
      conversationId: query.data.conversationId,
      beforeCreatedAt: cursor?.createdAt,
      beforeId: cursor?.id,
      limit: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    const nextCursor =
      rows.length > PAGE_SIZE && last
        ? Buffer.from(
            JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
          ).toString('base64url')
        : null;
    return {
      data: {
        items: page.map((row) => ({
          id: row.id,
          kind: row.kind,
          accountId: row.accountId,
          accountDisplayName: row.accountDisplayName,
          conversationId: row.conversationId,
          receiverLabel: row.receiverLabel,
          ...(row.kind === 'send' ? { outboundText: row.outboundText } : {}),
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
        nextCursor,
      },
      error: null,
    };
  });
  application.get('/api/facebook-page-comment-history', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    const identity = await authorizeRequest(request, auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const query = z
      .strictObject({
        accountId: z.uuid().optional(),
        status: z
          .enum(['pending', 'claimed', 'cancelled', 'reserved', 'confirmed', 'failed', 'unknown'])
          .optional(),
        cursor: z.string().max(512).optional(),
      })
      .safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ data: null, error: 'Invalid comment history filter' });
    let cursor: { createdAt: Date; id: string } | null = null;
    if (query.data.cursor) {
      try {
        const parsed: unknown = JSON.parse(
          Buffer.from(query.data.cursor, 'base64url').toString('utf8'),
        );
        const value = cursorSchema.parse(parsed);
        cursor = { createdAt: new Date(value.createdAt), id: value.id };
      } catch {
        return reply.code(400).send({ data: null, error: 'Invalid comment history cursor' });
      }
    }
    const rows = await listPageCommentHistory(database, {
      workspaceId: identity.workspaceId,
      accountId: query.data.accountId,
      status: query.data.status,
      beforeCreatedAt: cursor?.createdAt,
      beforeId: cursor?.id,
      limit: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    const nextCursor =
      rows.length > PAGE_SIZE && last
        ? Buffer.from(
            JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
          ).toString('base64url')
        : null;
    return {
      data: {
        items: page.map((row) => ({
          id: row.id,
          kind: row.kind,
          accountId: row.accountId,
          accountDisplayName: row.accountDisplayName,
          postId: row.postId,
          commentId: row.commentId,
          targetExcerpt: row.targetText?.slice(0, 280) ?? null,
          outboundText: row.outboundText,
          status: row.status,
          dueAt: row.dueAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          postUrl: pageCommentPostLink(row.postId),
        })),
        nextCursor,
      },
      error: null,
    };
  });
  application.get('/api/fanvue-engagement-history', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    const identity = await authorizeRequest(request, auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const query = z
      .strictObject({
        accountId: z.uuid().optional(),
        kind: z.enum(['message', 'comment']).optional(),
        status: z.enum(['reserved', 'confirmed', 'failed', 'unknown']).optional(),
        cursor: z.string().max(512).optional(),
      })
      .safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ data: null, error: 'Invalid Fanvue history filter' });
    let cursor: { createdAt: Date; id: string } | null = null;
    if (query.data.cursor) {
      try {
        const parsed: unknown = JSON.parse(
          Buffer.from(query.data.cursor, 'base64url').toString('utf8'),
        );
        const value = cursorSchema.parse(parsed);
        cursor = { createdAt: new Date(value.createdAt), id: value.id };
      } catch {
        return reply.code(400).send({ data: null, error: 'Invalid Fanvue history cursor' });
      }
    }
    const rows = await listFanvueActionHistory(database, {
      workspaceId: identity.workspaceId,
      accountId: query.data.accountId,
      kind: query.data.kind,
      status: query.data.status,
      beforeCreatedAt: cursor?.createdAt,
      beforeId: cursor?.id,
      limit: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    const nextCursor =
      rows.length > PAGE_SIZE && last
        ? Buffer.from(
            JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
          ).toString('base64url')
        : null;
    return {
      data: {
        items: page.map((row) => ({
          id: row.id,
          accountId: row.accountId,
          accountDisplayName: row.accountDisplayName,
          kind: row.kind,
          outboundText: row.outboundText,
          mediaCount: row.mediaCount,
          priceCents: row.priceCents,
          status: row.status,
          providerReceipt: row.providerReceipt,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          destinationUrl: null,
        })),
        nextCursor,
      },
      error: null,
    };
  });
  application.get('/api/facebook-page-dm-no-go', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    const identity = await authorizeRequest(request, auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const query = z
      .strictObject({ cursor: z.string().max(512).optional() })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ data: null, error: 'Invalid no-go cursor' });
    let cursor: { createdAt: string; accountId: string; conversationId: string } | null = null;
    try {
      if (query.data.cursor)
        cursor = z
          .strictObject({
            createdAt: z.iso.datetime(),
            accountId: z.uuid(),
            conversationId: z
              .string()
              .regex(/^[A-Za-z0-9_]+$/)
              .max(256),
          })
          .parse(JSON.parse(Buffer.from(query.data.cursor, 'base64url').toString('utf8')));
    } catch {
      return reply.code(400).send({ data: null, error: 'Invalid no-go cursor' });
    }
    const rows = await listWorkspacePageNoGo(database, {
      workspaceId: identity.workspaceId,
      limit: PAGE_SIZE + 1,
      ...(cursor
        ? {
            beforeCreatedAt: new Date(cursor.createdAt),
            beforeAccountId: cursor.accountId,
            beforeConversationId: cursor.conversationId,
          }
        : {}),
    });
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    const nextCursor =
      rows.length > PAGE_SIZE && last
        ? Buffer.from(
            JSON.stringify({
              createdAt: last.createdAt.toISOString(),
              accountId: last.accountId,
              conversationId: last.conversationId,
            }),
          ).toString('base64url')
        : null;
    return {
      data: {
        canManage: identity.role === 'owner' || identity.role === 'admin',
        nextCursor,
        items: page.map((row) => ({
          accountId: row.accountId,
          conversationId: row.conversationId,
          displayName: row.displayName,
          accountDisplayName: row.accountDisplayName,
          createdAt: row.createdAt.toISOString(),
        })),
      },
      error: null,
    };
  });
  application.delete(
    '/api/facebook-page-dm-no-go/:accountId/:conversationId',
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      const identity = await authorizeRequest(request, auth, 'content:write');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      if (identity.role !== 'owner' && identity.role !== 'admin')
        return reply.code(403).send({ data: null, error: 'Workspace admin required' });
      if (!validCsrf(request))
        return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
      const params = z
        .strictObject({
          accountId: z.uuid(),
          conversationId: z
            .string()
            .regex(/^[A-Za-z0-9_]+$/)
            .max(256),
        })
        .safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ data: null, error: 'Invalid Page conversation' });
      await setPageConversationNoGo(database, {
        workspaceId: identity.workspaceId,
        ...params.data,
        blocked: false,
      });
      return { data: { noGo: false }, error: null };
    },
  );
  application.get('/api/engagement-proposals', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    const identity = await authorizeRequest(request, auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const query = z
      .strictObject({ cursor: z.string().max(512).optional() })
      .safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ data: null, error: 'Invalid proposal cursor' });
    let cursor: ReturnType<typeof parseCursor>;
    try {
      cursor = parseCursor(query.data.cursor);
    } catch {
      return reply.code(400).send({ data: null, error: 'Invalid proposal cursor' });
    }
    const rows = await listEngagementReviewQueue(database, identity.workspaceId, {
      ...(cursor ? { beforeCreatedAt: new Date(cursor.createdAt), beforeId: cursor.id } : {}),
      limit: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    const nextCursor =
      rows.length > PAGE_SIZE && last
        ? Buffer.from(
            JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
          ).toString('base64url')
        : null;
    return { data: { items: page.map(summary), nextCursor }, error: null };
  });

  application.get('/api/engagement-proposals/:proposalId', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    const identity = await authorizeRequest(request, auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ data: null, error: 'Proposal not found' });
    const row = await getEngagementProposal(database, identity.workspaceId, params.data.proposalId);
    if (!row) return reply.code(404).send({ data: null, error: 'Proposal not found' });
    const noGo =
      row.provider === 'facebook_page' && row.kind === 'dm'
        ? await isPageConversationNoGo(database, {
            workspaceId: identity.workspaceId,
            accountId: row.accountId,
            conversationId: row.targetId,
          })
        : false;
    const schedule =
      row.provider === 'facebook_page' && row.status === 'scheduled'
        ? row.kind === 'comment'
          ? await getScheduledProposalPageComment(database, {
              workspaceId: identity.workspaceId,
              clientActionId: row.clientActionId,
            })
          : await getScheduledProposalPageDm(database, {
              workspaceId: identity.workspaceId,
              clientActionId: row.clientActionId,
            })
        : null;
    const scheduleWindow =
      row.provider === 'facebook_page' && row.kind === 'dm'
        ? await getPageDmDelayWindow(database, {
            workspaceId: identity.workspaceId,
            accountId: row.accountId,
          })
        : null;
    return {
      data: {
        ...representation(row),
        canApprove: identity.role === 'owner' || identity.role === 'admin',
        noGo,
        schedule,
        scheduleWindow,
      },
      error: null,
    };
  });

  application.put(
    '/api/engagement-proposals/:proposalId/schedule-default',
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      const identity = await authorizeRequest(request, auth, 'workspace:manage');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      if (!validCsrf(request))
        return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
      const params = paramsSchema.safeParse(request.params);
      const window = z
        .strictObject({
          earliestDelaySeconds: z.number().int().min(0).max(82_800),
          latestDelaySeconds: z.number().int().min(0).max(82_800),
        })
        .safeParse(request.body);
      if (
        !params.success ||
        !window.success ||
        window.data.latestDelaySeconds < window.data.earliestDelaySeconds
      )
        return reply.code(400).send({ data: null, error: 'Invalid Page delay window' });
      const proposal = await getEngagementProposal(
        database,
        identity.workspaceId,
        params.data.proposalId,
      );
      if (proposal?.provider !== 'facebook_page' || proposal.kind !== 'dm')
        return reply.code(404).send({ data: null, error: 'Page proposal not found' });
      const updated = await setPageDmDelayWindow(database, {
        workspaceId: identity.workspaceId,
        accountId: proposal.accountId,
        ...window.data,
      });
      return { data: updated, error: null };
    },
  );

  for (const blocked of [true, false])
    application.route({
      method: blocked ? 'POST' : 'DELETE',
      url: '/api/engagement-proposals/:proposalId/no-go',
      handler: async (request, reply) => {
        void reply.header('Cache-Control', 'no-store');
        const identity = await authorizeRequest(request, auth, 'content:write');
        if (!identity)
          return reply.code(401).send({ data: null, error: 'Authentication required' });
        if (identity.role !== 'owner' && identity.role !== 'admin')
          return reply.code(403).send({ data: null, error: 'Workspace admin required' });
        if (!validCsrf(request))
          return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
        const params = paramsSchema.safeParse(request.params);
        if (!params.success)
          return reply.code(404).send({ data: null, error: 'Proposal not found' });
        const row = await getEngagementProposal(
          database,
          identity.workspaceId,
          params.data.proposalId,
        );
        if (row?.provider !== 'facebook_page' || row.kind !== 'dm')
          return reply.code(404).send({ data: null, error: 'Page conversation not found' });
        await setPageConversationNoGo(database, {
          workspaceId: identity.workspaceId,
          accountId: row.accountId,
          conversationId: row.targetId,
          displayName:
            typeof row.sourceContext === 'object' &&
            row.sourceContext !== null &&
            'authorLabel' in row.sourceContext &&
            typeof row.sourceContext.authorLabel === 'string'
              ? row.sourceContext.authorLabel
              : undefined,
          blocked,
        });
        return { data: { noGo: blocked }, error: null };
      },
    });

  application.post('/api/engagement-proposals', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    const identity = await authorizeRequest(request, auth, 'content:write');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (!validCsrf(request))
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const input = createEngagementProposalSchema.safeParse(request.body);
    if (!input.success || !validFacebookProposal(input.data))
      return reply.code(400).send({ data: null, error: 'Invalid proposal' });
    try {
      const row = await createEngagementProposal(database, {
        ...input.data,
        plannedDueAt: undefined,
        content: normalizeContent(input.data.content),
        ...(input.data.plannedDueAt ? { plannedDueAt: new Date(input.data.plannedDueAt) } : {}),
        sourceContext: input.data.sourceContext ?? {},
        workspaceId: identity.workspaceId,
        proposerType: 'user',
        proposerId: identity.userId,
      });
      return await reply.code(201).send({ data: representation(row), error: null });
    } catch (error) {
      const known = proposalError(error);
      if (known) return await reply.code(known.status).send({ data: null, error: known.message });
      throw error;
    }
  });

  application.patch('/api/engagement-proposals/:proposalId', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    const identity = await authorizeRequest(request, auth, 'content:write');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (!validCsrf(request))
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const params = paramsSchema.safeParse(request.params);
    const body = reviseSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send({ data: null, error: 'Invalid proposal edit' });
    try {
      const current = await getEngagementProposal(
        database,
        identity.workspaceId,
        params.data.proposalId,
      );
      if (
        body.data.content.followUps &&
        (current?.provider !== 'facebook_page' ||
          current.kind !== 'dm' ||
          !current.sourceContext ||
          typeof current.sourceContext !== 'object' ||
          !('sourceMessageId' in current.sourceContext) ||
          !current.sourceContext.sourceMessageId)
      )
        return await reply
          .code(400)
          .send({ data: null, error: 'Grouped reply requires a Page DM with a source message' });
      const row = await reviseEngagementProposal(database, {
        workspaceId: identity.workspaceId,
        id: params.data.proposalId,
        expectedRevision: body.data.expectedRevision,
        content: normalizeContent(body.data.content),
      });
      return { data: representation(row), error: null };
    } catch (error) {
      const known = proposalError(error);
      if (known) return await reply.code(known.status).send({ data: null, error: known.message });
      throw error;
    }
  });

  application.post('/api/engagement-proposals/:proposalId/dismiss', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    const identity = await authorizeRequest(request, auth, 'content:write');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (!validCsrf(request))
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const params = paramsSchema.safeParse(request.params);
    const body = dismissSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send({ data: null, error: 'Invalid dismissal' });
    try {
      const row = await dismissEngagementProposal(database, {
        workspaceId: identity.workspaceId,
        id: params.data.proposalId,
        ...body.data,
      });
      return { data: representation(row), error: null };
    } catch (error) {
      const known = proposalError(error);
      if (known) return await reply.code(known.status).send({ data: null, error: known.message });
      throw error;
    }
  });
}

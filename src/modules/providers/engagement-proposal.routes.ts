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

const contentSchema = z.strictObject({
  text: z.string().trim().min(1).max(5000),
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
    })
    .optional(),
  content: contentSchema,
});
const paramsSchema = z.strictObject({ proposalId: z.uuid() });
const reviseSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  content: contentSchema,
});
const dismissSchema = z.strictObject({ expectedRevision: z.number().int().positive() });
const cursorSchema = z.strictObject({ createdAt: z.iso.datetime(), id: z.uuid() });
const PAGE_SIZE = 50;

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
    contentPreview: previewText(row.content),
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
        if (!input.success)
          return await reply.code(400).send({ data: null, error: 'Invalid proposal' });
        const row = await createEngagementProposal(database, {
          ...input.data,
          content: normalizeContent(input.data.content),
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

  if (!auth) return;
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
    return {
      data: {
        ...representation(row),
        canApprove: identity.role === 'owner' || identity.role === 'admin',
      },
      error: null,
    };
  });

  application.post('/api/engagement-proposals', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    const identity = await authorizeRequest(request, auth, 'content:write');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (!validCsrf(request))
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const input = createEngagementProposalSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ data: null, error: 'Invalid proposal' });
    try {
      const row = await createEngagementProposal(database, {
        ...input.data,
        content: normalizeContent(input.data.content),
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

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  createPostRequestSchema,
  jobDetailResponseSchema,
  postCollectionResponseSchema,
  postDetailResponseSchema,
  postMutationResponseSchema,
} from '../content/post.contract.js';
import { errorResponseSchema, openApiJsonSchema, successResponseSchema } from './contract.js';

const accountSchema = z.union([
  z.object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    workspaceLabel: z.string().min(1),
    prefix: z.string().min(1),
    capabilities: z.array(z.string()),
    expiresAt: z.date().nullable(),
  }),
  z.object({
    principalType: z.literal('delegated'),
    clientId: z.string().min(1),
    grantId: z.uuid(),
    workspaceId: z.uuid(),
    workspaceLabel: z.string().min(1),
    capabilities: z.array(z.string()),
    expiresAt: z.date(),
  }),
]);
const destinationCollectionSchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      provider: z.string().min(1),
      displayName: z.string().min(1),
      status: z.string().min(1),
      updatedAt: z.iso.datetime(),
    }),
  ),
});
const mediaMutationSchema = z.object({
  id: z.uuid(),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 * 1024 * 1024),
  durationMs: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  videoCodec: z.string().min(1).optional(),
  audioCodec: z.string().min(1).nullable().optional(),
  container: z.literal('mp4').optional(),
  state: z.literal('ready'),
});
const externalDraftRequestSchema = z.object({
  externalId: z.string().min(1).max(200),
  mediaIds: z.array(z.uuid()).min(1).max(20),
  label: z.string().max(200).optional(),
  returnUrl: z.url().startsWith('https://').optional(),
});
const externalDraftSchema = z.object({
  id: z.uuid(),
  externalId: z.string(),
  label: z.string().nullable(),
  returnUrl: z.string().nullable(),
  mediaIds: z.array(z.uuid()),
  postId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  links: z.object({ self: z.string(), cockpit: z.string(), post: z.string().optional() }),
});

export function apiV1OpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Publish Relay API', version: '1.1.0' },
    paths: {
      '/connect/revoke': {
        post: {
          operationId: 'revokeDelegatedGrant',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['token', 'client_id'], properties: { token: { type: 'string' }, client_id: { type: 'string' }, client_secret: { type: 'string' }, token_type_hint: { enum: ['access_token', 'refresh_token'] } } } } },
          },
          responses: { '200': { description: 'Grant family revoked or token already invalid' }, '400': { description: 'Invalid request' }, '401': { description: 'Invalid confidential client authentication' } },
        },
      },
      '/api/v1/drafts': {
        post: {
          operationId: 'createExternalDraft',
          security: [{ bearerAuth: [], workspace: [] }],
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string', minLength: 8, maxLength: 200 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: openApiJsonSchema(externalDraftRequestSchema) },
            },
          },
          responses: {
            '201': {
              description: 'External draft created',
              content: {
                'application/json': {
                  schema: openApiJsonSchema(successResponseSchema(externalDraftSchema)),
                },
              },
            },
            '400': { description: 'Invalid draft input' },
            '401': { description: 'Authentication required' },
            '403': { description: 'Missing content:write capability' },
            '409': { description: 'External ID conflicts with existing input' },
            '429': { description: 'Mutation rate limit exceeded' },
          },
        },
      },
      '/api/v1/drafts/{draftId}': {
        get: {
          operationId: 'getExternalDraft',
          security: [{ bearerAuth: [], workspace: [] }],
          parameters: [
            {
              name: 'draftId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': {
              description: 'Principal-owned external draft',
              content: {
                'application/json': {
                  schema: openApiJsonSchema(successResponseSchema(externalDraftSchema)),
                },
              },
            },
            '401': { description: 'Authentication required' },
            '403': { description: 'Missing content:write capability' },
            '404': { description: 'Draft not found' },
          },
        },
      },
      '/api/v1/destinations': {
        get: {
          operationId: 'listDestinations',
          security: [{ bearerAuth: [], workspace: [] }],
          responses: {
            '200': {
              description: 'Connected destination summaries',
              content: {
                'application/json': {
                  schema: openApiJsonSchema(successResponseSchema(destinationCollectionSchema)),
                },
              },
            },
            '401': {
              description: 'Authentication required',
              content: { 'application/json': { schema: openApiJsonSchema(errorResponseSchema) } },
            },
            '403': {
              description: 'Missing destinations:read capability',
              content: { 'application/json': { schema: openApiJsonSchema(errorResponseSchema) } },
            },
            '429': {
              description: 'Read rate limit exceeded',
              content: { 'application/json': { schema: openApiJsonSchema(errorResponseSchema) } },
            },
          },
        },
      },
      '/api/v1/media': {
        post: {
          operationId: 'uploadMedia',
          security: [{ bearerAuth: [], workspace: [] }],
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string', minLength: 8, maxLength: 200 },
            },
            {
              name: 'X-File-Name',
              in: 'header',
              required: true,
              schema: { type: 'string', minLength: 1, maxLength: 255 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'image/png': { schema: { type: 'string', format: 'binary', maxLength: 5242880 } },
              'image/jpeg': { schema: { type: 'string', format: 'binary', maxLength: 5242880 } },
              'image/gif': { schema: { type: 'string', format: 'binary', maxLength: 5242880 } },
              'image/webp': { schema: { type: 'string', format: 'binary', maxLength: 5242880 } },
              'video/mp4': { schema: { type: 'string', format: 'binary', maxLength: 2147483648 } },
            },
          },
          responses: {
            '201': {
              description: 'Workspace media stored and ready for post creation',
              headers: { 'Idempotency-Replayed': { schema: { type: 'boolean' } } },
              content: {
                'application/json': {
                  schema: openApiJsonSchema(successResponseSchema(mediaMutationSchema)),
                },
              },
            },
            '400': {
              description: 'Invalid content, headers, or idempotency key',
              content: { 'application/json': { schema: openApiJsonSchema(errorResponseSchema) } },
            },
            '401': {
              description: 'Authentication required',
              content: { 'application/json': { schema: openApiJsonSchema(errorResponseSchema) } },
            },
            '403': {
              description: 'Missing content:write capability',
              content: { 'application/json': { schema: openApiJsonSchema(errorResponseSchema) } },
            },
            '409': {
              description: 'Idempotency key reused for different content',
              content: { 'application/json': { schema: openApiJsonSchema(errorResponseSchema) } },
            },
            '413': {
              description: 'Media exceeds its configured technical byte ceiling',
              content: { 'application/json': { schema: openApiJsonSchema(errorResponseSchema) } },
            },
            '429': {
              description: 'Mutation rate limit exceeded',
              content: { 'application/json': { schema: openApiJsonSchema(errorResponseSchema) } },
            },
          },
        },
      },
      '/api/v1/account': {
        get: {
          operationId: 'getAccount',
          security: [{ bearerAuth: [], workspace: [] }],
          responses: {
            '200': {
              description: 'Authenticated API key or delegated connection identity',
              content: {
                'application/json': {
                  schema: openApiJsonSchema(successResponseSchema(accountSchema)),
                },
              },
            },
            '401': {
              description: 'Authentication required',
              content: {
                'application/json': { schema: openApiJsonSchema(errorResponseSchema) },
              },
            },
            '429': {
              description: 'Rate limit exceeded',
              headers: {
                'Retry-After': { schema: { type: 'integer', minimum: 1 } },
                'X-RateLimit-Limit': { schema: { type: 'integer', minimum: 1 } },
                'X-RateLimit-Remaining': { schema: { type: 'integer', minimum: 0 } },
              },
              content: {
                'application/json': { schema: openApiJsonSchema(errorResponseSchema) },
              },
            },
          },
        },
      },
      '/api/v1/posts': {
        get: {
          operationId: 'listPosts',
          security: [{ bearerAuth: [], workspace: [] }],
          parameters: [
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
            },
          ],
          responses: {
            '200': {
              description: 'Bounded post summaries',
              content: {
                'application/json': {
                  schema: openApiJsonSchema(successResponseSchema(postCollectionResponseSchema)),
                },
              },
            },
            '400': {
              description: 'Invalid or filter-mismatched cursor',
              content: { 'application/json': { schema: openApiJsonSchema(errorResponseSchema) } },
            },
            '401': {
              description: 'Authentication required',
              content: { 'application/json': { schema: openApiJsonSchema(errorResponseSchema) } },
            },
            '403': {
              description: 'Missing schedules:read capability',
              content: { 'application/json': { schema: openApiJsonSchema(errorResponseSchema) } },
            },
            '429': {
              description: 'Read rate limit exceeded',
              headers: {
                'Retry-After': { schema: { type: 'integer', minimum: 1 } },
                'X-RateLimit-Limit': { schema: { type: 'integer', minimum: 1 } },
                'X-RateLimit-Remaining': { schema: { type: 'integer', minimum: 0 } },
              },
              content: { 'application/json': { schema: openApiJsonSchema(errorResponseSchema) } },
            },
          },
        },
        post: {
          operationId: 'createPost',
          security: [{ bearerAuth: [], workspace: [] }],
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string', minLength: 8, maxLength: 200 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: openApiJsonSchema(createPostRequestSchema) },
            },
          },
          responses: {
            '201': {
              description: 'Post and independent publication jobs created',
              headers: {
                'Idempotency-Replayed': { schema: { type: 'boolean' } },
              },
              content: {
                'application/json': {
                  schema: openApiJsonSchema(successResponseSchema(postMutationResponseSchema)),
                },
              },
            },
            '400': {
              description: 'Invalid request or idempotency key',
              content: {
                'application/json': { schema: openApiJsonSchema(errorResponseSchema) },
              },
            },
            '401': {
              description: 'Authentication required',
              content: {
                'application/json': { schema: openApiJsonSchema(errorResponseSchema) },
              },
            },
            '403': {
              description: 'Missing schedules:write capability',
              content: {
                'application/json': { schema: openApiJsonSchema(errorResponseSchema) },
              },
            },
            '409': {
              description: 'Idempotency key reused for a different request',
              content: {
                'application/json': { schema: openApiJsonSchema(errorResponseSchema) },
              },
            },
            '429': {
              description: 'Mutation rate limit exceeded',
              headers: {
                'Retry-After': { schema: { type: 'integer', minimum: 1 } },
                'X-RateLimit-Limit': { schema: { type: 'integer', minimum: 1 } },
                'X-RateLimit-Remaining': { schema: { type: 'integer', minimum: 0 } },
              },
              content: {
                'application/json': { schema: openApiJsonSchema(errorResponseSchema) },
              },
            },
          },
        },
      },
      '/api/v1/posts/{postId}': {
        get: {
          operationId: 'getPost',
          security: [{ bearerAuth: [], workspace: [] }],
          parameters: [
            {
              name: 'postId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': {
              description: 'Post detail',
              content: {
                'application/json': {
                  schema: openApiJsonSchema(successResponseSchema(postDetailResponseSchema)),
                },
              },
            },
            '404': {
              description: 'Post not found',
              content: { 'application/json': { schema: openApiJsonSchema(errorResponseSchema) } },
            },
          },
        },
      },
      '/api/v1/jobs/{jobId}': {
        get: {
          operationId: 'getJob',
          security: [{ bearerAuth: [], workspace: [] }],
          parameters: [
            {
              name: 'jobId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': {
              description: 'Publication job detail',
              content: {
                'application/json': {
                  schema: openApiJsonSchema(successResponseSchema(jobDetailResponseSchema)),
                },
              },
            },
            '404': {
              description: 'Job not found',
              content: { 'application/json': { schema: openApiJsonSchema(errorResponseSchema) } },
            },
          },
        },
      },
      '/api/v1/jobs/{jobId}/retry': {
        post: {
          operationId: 'retryPublication',
          security: [{ bearerAuth: [], workspace: [] }],
          parameters: [
            {
              name: 'jobId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string', minLength: 8, maxLength: 200 },
            },
          ],
          responses: {
            '202': { description: 'Failed publication queued for safe retry' },
            '400': { description: 'Invalid job ID or idempotency key' },
            '403': { description: 'Missing publishes:retry capability' },
            '409': { description: 'Job is not safely retryable or idempotency key conflicts' },
            '429': { description: 'Mutation rate limit exceeded' },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        workspace: { type: 'apiKey', in: 'header', name: 'X-Publish-Relay-Workspace' },
      },
    },
  };
}

export function registerApiDocumentationRoute(application: FastifyInstance): void {
  application.get('/api/v1/openapi.json', () => apiV1OpenApiDocument());
}

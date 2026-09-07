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

const accountSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  workspaceLabel: z.string().min(1),
  prefix: z.string().min(1),
  capabilities: z.array(z.string()),
  expiresAt: z.date().nullable(),
});
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

export function apiV1OpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Publish Relay API', version: '1.0.0' },
    paths: {
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
              description: 'Authenticated API key identity',
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

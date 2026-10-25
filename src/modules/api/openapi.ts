import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  createPostRequestSchema,
  jobDetailResponseSchema,
  jobCollectionResponseSchema,
  postCollectionResponseSchema,
  postDetailResponseSchema,
  postMutationResponseSchema,
  postValidationResponseSchema,
  postValidationRequestSchema,
} from '../content/post.contract.js';
import { tiktokConsentRequestSchema } from '../providers/tiktok-consent.service.js';
import { fanvueMessageRequestSchema } from '../providers/fanvue-message.routes.js';
import { updateCapabilitiesSchema } from '../identity/api-key.routes.js';
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
  nextCursor: z.string().nullable(),
  items: z.array(
    z.object({
      id: z.uuid(),
      provider: z.string().min(1),
      destinationProvider: z.enum(['x', 'youtube', 'linkedin', 'instagram', 'facebook_page']),
      displayName: z.string().min(1),
      status: z.string().min(1),
      availability: z.enum([
        'active',
        'reauth_required',
        'permission_lost',
        'remote_missing',
        'publishing_unavailable',
      ]),
      remoteParentAccountId: z.string().nullable(),
      capabilitySnapshot: z.object({
        schemaVersion: z.literal(1),
        contentKinds: z.array(z.enum(['text', 'video', 'single_image', 'carousel', 'link'])),
        media: z.object({ minImages: z.number().optional(), maxImages: z.number().optional() }),
      }),
      capabilitiesCheckedAt: z.iso.datetime().nullable(),
      capabilityFreshness: z.enum(['fresh', 'stale', 'unknown']),
      updatedAt: z.iso.datetime(),
    }),
  ),
});
const tiktokCapabilitySchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  nickname: z.string().min(1),
  privacyOptions: z
    .array(
      z.enum(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']),
    )
    .min(1),
  commentDisabled: z.boolean(),
  duetDisabled: z.boolean(),
  stitchDisabled: z.boolean(),
  maxVideoDurationSeconds: z.number().int().positive(),
  fetchedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
const tiktokConsentReceiptSchema = z.object({
  id: z.uuid(),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  consentedAt: z.iso.datetime(),
});
const tiktokConsentDetailSchema = tiktokConsentReceiptSchema.extend({
  postId: z.uuid(),
  revisionId: z.uuid(),
  accountId: z.uuid(),
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
const fanvueMessageResultSchema = z.union([
  z.object({ state: z.literal('confirmed'), messageUuid: z.uuid() }),
  z.object({ state: z.literal('failed'), failureStatus: z.number().int().min(400).max(499) }),
  z.object({ state: z.literal('unknown') }),
]);
const fanvuePaymentSignalCollectionSchema = z.object({
  items: z
    .array(
      z.object({
        eventId: z.uuid(),
        fanUuid: z.uuid(),
        invoiceId: z.string(),
        source: z.enum(['post', 'message', 'media', 'tip', 'subscription']),
        grossMinor: z.number().int().nonnegative(),
        currency: z.string().nullable(),
        paidAt: z.iso.datetime().nullable(),
        eventAt: z.iso.datetime(),
        postUuid: z.uuid().nullable(),
        messageUuid: z.uuid().nullable(),
        tipContext: z.enum(['post', 'message']).nullable(),
      }),
    )
    .max(50),
  nextCursor: z.string().nullable(),
});

export function apiV1OpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Publish Relay API', version: '1.1.0' },
    paths: {
      '/api/settings/api-keys/{keyId}': {
        patch: {
          operationId: 'updateApiKeyCapabilities',
          security: [{ browserSession: [], csrfToken: [] }],
          description:
            'Browser-session owner/admin exact permission replacement; never returns key material. Not available to API keys.',
          parameters: [
            {
              name: 'keyId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            { name: 'X-CSRF-Token', in: 'header', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: openApiJsonSchema(updateCapabilitiesSchema) },
            },
          },
          responses: {
            '200': {
              description:
                'Capabilities replaced; returns updated flag and new capability version only',
            },
            '400': { description: 'Invalid, empty, or duplicate capability set or version' },
            '401': { description: 'Browser authentication or workspace-management role required' },
            '403': { description: 'CSRF validation failed' },
            '404': { description: 'Key absent from active workspace' },
            '409': { description: 'Version stale or key revoked' },
          },
        },
      },
      '/api/workflow/tiktok-consents': {
        post: {
          operationId: 'issueTikTokPublicationConsent',
          description: 'Authenticated human browser only. Does not schedule or dispatch a post.',
          security: [{ browserSession: [], csrfToken: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: openApiJsonSchema(tiktokConsentRequestSchema) },
            },
          },
          responses: {
            '201': {
              description: 'Immutable exact-revision consent receipt',
              content: {
                'application/json': {
                  schema: openApiJsonSchema(successResponseSchema(tiktokConsentReceiptSchema)),
                },
              },
            },
            '400': { description: 'Required explicit consent choice or identifier missing' },
            '401': { description: 'Human session required' },
            '403': { description: 'CSRF or membership denied' },
            '409': {
              description:
                'Revision, account, media, or capability state changed; refresh and reconfirm',
            },
          },
        },
      },
      '/api/workflow/tiktok-consents/{receiptId}': {
        get: {
          operationId: 'readTikTokPublicationConsent',
          security: [{ browserSession: [] }],
          parameters: [
            {
              name: 'receiptId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': {
              description:
                'Current receipt metadata for the same consenting human; no payload or secrets',
              content: {
                'application/json': {
                  schema: openApiJsonSchema(successResponseSchema(tiktokConsentDetailSchema)),
                },
              },
            },
            '401': { description: 'Human session required' },
            '403': { description: 'Membership denied' },
            '404': { description: 'Receipt not found for this human and workspace' },
            '409': { description: 'Receipt invalidated; refresh and reconfirm' },
          },
        },
      },
      '/connect/revoke': {
        post: {
          operationId: 'revokeDelegatedGrant',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['token', 'client_id'],
                  properties: {
                    token: { type: 'string' },
                    client_id: { type: 'string' },
                    client_secret: { type: 'string' },
                    token_type_hint: { enum: ['access_token', 'refresh_token'] },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Grant family revoked or token already invalid' },
            '400': { description: 'Invalid request' },
            '401': { description: 'Invalid confidential client authentication' },
          },
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
      '/api/v1/fanvue/accounts/{accountId}/chats/{fanUuid}/messages': {
        post: {
          operationId: 'sendFanvueMessage',
          description:
            'Send one-to-one text or account-verified ready Fanvue media; native priced media may include an attached free preview. Unknown outcomes must not be blindly resent.',
          security: [{ bearerAuth: [], workspace: [] }],
          parameters: [
            {
              name: 'accountId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'fanUuid',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: openApiJsonSchema(fanvueMessageRequestSchema) },
            },
          },
          responses: {
            '201': {
              description: 'Provider message confirmed',
              content: {
                'application/json': {
                  schema: openApiJsonSchema(successResponseSchema(fanvueMessageResultSchema)),
                },
              },
            },
            '202': { description: 'Provider outcome unknown; no automatic resend' },
            '400': { description: 'Invalid message or price/preview shape' },
            '401': { description: 'Authentication required' },
            '403': { description: 'Missing fanvue:chats:send capability' },
            '409': { description: 'Account, media or action unavailable' },
            '429': { description: 'Mutation rate limit exceeded' },
          },
        },
      },
      '/api/v1/fanvue/accounts/{accountId}/payment-signals': {
        get: {
          operationId: 'listFanvuePaymentSignals',
          description:
            'Account-scoped verified payment/tip facts; a tip does not prove an offer match.',
          security: [{ bearerAuth: [], workspace: [] }],
          parameters: [
            {
              name: 'accountId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            { name: 'cursor', in: 'query', schema: { type: 'string', maxLength: 512 } },
          ],
          responses: {
            '200': {
              description: 'At most 50 verified provider facts',
              content: {
                'application/json': {
                  schema: openApiJsonSchema(
                    successResponseSchema(fanvuePaymentSignalCollectionSchema),
                  ),
                },
              },
            },
            '400': { description: 'Invalid account or cursor' },
            '401': { description: 'Authentication required' },
            '403': { description: 'Missing fanvue:payments:read capability' },
            '429': { description: 'Read rate limit exceeded' },
          },
        },
      },
      '/api/v1/destinations': {
        get: {
          operationId: 'listDestinations',
          security: [{ bearerAuth: [], workspace: [] }],
          parameters: [
            { name: 'cursor', in: 'query', schema: { type: 'string', maxLength: 1024 } },
          ],
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
      '/api/v1/destinations/{accountId}/tiktok-capabilities': {
        get: {
          operationId: 'fetchTikTokDestinationCapabilities',
          security: [{ bearerAuth: [], workspace: [] }],
          parameters: [
            {
              name: 'accountId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': {
              description: 'Fresh account-bound creator capabilities; no privacy default',
              content: {
                'application/json': {
                  schema: openApiJsonSchema(successResponseSchema(tiktokCapabilitySchema)),
                },
              },
            },
            '401': { description: 'Authentication required' },
            '403': { description: 'Missing destinations:read capability' },
            '409': { description: 'Destination or grant unavailable' },
            '429': { description: 'Rate limited' },
            '502': { description: 'Provider lookup failed; no fallback capabilities returned' },
            '503': { description: 'TikTok transport not configured' },
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
            description:
              'Use destination plus versioned provider content for new integrations. The providerAccountIds shape remains supported for existing clients but is deprecated.',
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
      '/api/v1/posts/validate': {
        post: {
          operationId: 'validatePost',
          description:
            'Read-only technical admission preview using the create candidate body. Optional validationPreview: { xMediaPresent: true } admits X object-thread parts separately before upload, with no media IDs. This does not validate future media ownership or content; create must revalidate after upload. No post, media, job, or audit write.',
          security: [{ bearerAuth: [], workspace: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: openApiJsonSchema(postValidationRequestSchema) },
            },
          },
          responses: {
            '200': {
              description: 'Per-destination admission result',
              content: {
                'application/json': {
                  schema: openApiJsonSchema(successResponseSchema(postValidationResponseSchema)),
                },
              },
            },
            '400': {
              description: 'Invalid candidate shape',
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
              content: { 'application/json': { schema: openApiJsonSchema(errorResponseSchema) } },
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
      '/api/v1/jobs': {
        get: {
          operationId: 'listJobs',
          security: [{ bearerAuth: [], workspace: [] }],
          parameters: [
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
            },
            {
              name: 'states',
              in: 'query',
              description: 'Comma-separated publication states',
              schema: { type: 'string' },
            },
            { name: 'providerAccountId', in: 'query', schema: { type: 'string', format: 'uuid' } },
            {
              name: 'scheduledAfter',
              in: 'query',
              schema: { type: 'string', format: 'date-time' },
            },
            {
              name: 'scheduledBefore',
              in: 'query',
              schema: { type: 'string', format: 'date-time' },
            },
          ],
          responses: {
            '200': {
              description:
                'Tenant-scoped past and future publication jobs in descending scheduled-time order',
              content: {
                'application/json': {
                  schema: openApiJsonSchema(successResponseSchema(jobCollectionResponseSchema)),
                },
              },
            },
            '400': { description: 'Invalid filter or signed cursor' },
            '401': { description: 'Authentication required' },
            '403': { description: 'Missing schedules:read capability' },
            '429': { description: 'Read rate limit exceeded' },
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
        browserSession: { type: 'apiKey', in: 'cookie', name: 'publish_relay_session' },
        csrfToken: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' },
        bearerAuth: { type: 'http', scheme: 'bearer' },
        workspace: { type: 'apiKey', in: 'header', name: 'X-Publish-Relay-Workspace' },
      },
    },
  };
}

export function registerApiDocumentationRoute(application: FastifyInstance): void {
  application.get('/api/v1/openapi.json', () => apiV1OpenApiDocument());
}

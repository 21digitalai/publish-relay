import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import {
  createExternalDraft,
  ExternalDraftValidationError,
} from '../src/modules/content/external-draft.service.js';

const database = {} as NodePgDatabase;
const principal = {
  kind: 'delegated' as const,
  actorId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
  clientId: 'external-client',
  capabilities: ['content:write' as const],
};

describe('external draft validation', () => {
  it('requires a bounded opaque external ID and media attachment', async () => {
    await expect(
      createExternalDraft(database, principal, {
        externalId: ' ',
        mediaIds: [],
        requestId: 'request-1',
      }),
    ).rejects.toBeInstanceOf(ExternalDraftValidationError);
  });

  it('rejects duplicate media references before persistence', async () => {
    const mediaId = '44444444-4444-4444-8444-444444444444';
    await expect(
      createExternalDraft(database, principal, {
        externalId: 'clip-1',
        mediaIds: [mediaId, mediaId],
        requestId: 'request-2',
      }),
    ).rejects.toThrow('mediaIds must be unique');
  });

  it('accepts only HTTPS return links', async () => {
    await expect(
      createExternalDraft(database, principal, {
        externalId: 'clip-2',
        mediaIds: ['55555555-5555-4555-8555-555555555555'],
        returnUrl: 'http://client.example/drafts/clip-2',
        requestId: 'request-3',
      }),
    ).rejects.toThrow('returnUrl must use HTTPS');
  });
});

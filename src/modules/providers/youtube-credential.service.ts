import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { getActiveCredential, rotateCredential } from '../credentials/credential.repository.js';
import {
  decryptCredential,
  encryptCredential,
  type MasterKeyProvider,
} from '../credentials/envelope.js';
import type { YouTubeCredential, YouTubeHttpClient } from './youtube-http-client.js';

const credentialSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.iso.datetime(),
  scope: z.string().optional(),
});
const REFRESH_SKEW_MS = 60_000;

async function readCredential(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  workspaceId: string,
  credentialId: string,
) {
  const stored = await withTenantTransaction(database, { workspaceId }, (transaction) =>
    getActiveCredential(transaction, workspaceId, credentialId),
  );
  if (!stored) throw new Error('YouTube credential is unavailable');
  const plaintext = await decryptCredential(stored, keys);
  try {
    const parsed = credentialSchema.parse(JSON.parse(plaintext.toString('utf8')));
    const credential: YouTubeCredential = {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      ...(parsed.scope ? { scope: parsed.scope } : {}),
    };
    return { stored, credential };
  } finally {
    plaintext.fill(0);
  }
}

export async function getFreshYouTubeCredential(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: YouTubeHttpClient,
  input: { workspaceId: string; credentialId: string; now?: Date },
): Promise<YouTubeCredential> {
  const current = await readCredential(database, keys, input.workspaceId, input.credentialId);
  const now = input.now ?? new Date();
  if (Date.parse(current.credential.expiresAt) > now.getTime() + REFRESH_SKEW_MS)
    return current.credential;

  const refreshed = await client.refresh(current.credential);
  const refreshedPlaintext = Buffer.from(JSON.stringify(refreshed));
  let encrypted;
  try {
    encrypted = await encryptCredential(refreshedPlaintext, keys);
  } finally {
    refreshedPlaintext.fill(0);
  }
  const rotated = await withTenantTransaction(database, { workspaceId: input.workspaceId }, (transaction) =>
    rotateCredential(
      transaction,
      input.workspaceId,
      input.credentialId,
      current.stored.version,
      encrypted,
    ),
  );
  if (rotated) return refreshed;

  const winner = await readCredential(database, keys, input.workspaceId, input.credentialId);
  if (Date.parse(winner.credential.expiresAt) <= now.getTime() + REFRESH_SKEW_MS)
    throw new Error('Concurrent YouTube credential refresh did not produce a usable token');
  return winner.credential;
}

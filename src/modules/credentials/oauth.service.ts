import { createHash, randomBytes } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { createCredential, createOauthTransaction } from './credential.repository.js';
import { encryptCredential, type MasterKeyProvider } from './envelope.js';
import { assertActiveMembership } from './provider-connection.repository.js';

const OAUTH_TTL_MS = 10 * 60 * 1000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function issueOauthTransaction(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: { workspaceId: string; userId: string; provider: string; redirectUri: string; now?: Date },
): Promise<{ state: string; codeChallenge: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + OAUTH_TTL_MS);
  const encryptedVerifier = await encryptCredential(Buffer.from(verifier), keys);
  await withTenantTransaction(
    database,
    { workspaceId: input.workspaceId, userId: input.userId },
    async (transaction) => {
      await assertActiveMembership(transaction, input.workspaceId, input.userId);
      const credential = await createCredential(transaction, input.workspaceId, encryptedVerifier);
      await createOauthTransaction(transaction, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        provider: input.provider,
        stateHash: sha256(state),
        pkceCredentialId: credential.id,
        redirectUri: input.redirectUri,
        expiresAt,
      });
    },
  );
  return {
    state,
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    expiresAt,
  };
}

export function hashOauthState(state: string): string {
  return sha256(state);
}

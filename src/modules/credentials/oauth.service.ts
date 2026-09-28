import { createHash, randomBytes } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  consumeOauthTransaction,
  createCredential,
  createOauthTransaction,
  deleteConsumedOauthSecret,
  deleteExpiredOauthSecrets,
  getActiveCredential,
} from './credential.repository.js';
import { decryptCredential, encryptCredential, type MasterKeyProvider } from './envelope.js';
import { assertActiveMembership } from './provider-connection.repository.js';

const OAUTH_TTL_MS = 10 * 60 * 1000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function issueOauthTransaction(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: {
    workspaceId: string;
    userId: string;
    provider: string;
    redirectUri: string;
    intent?: string;
    now?: Date;
  },
): Promise<{ state: string; codeChallenge: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + OAUTH_TTL_MS);
  const secret = input.intent ? JSON.stringify({ verifier, intent: input.intent }) : verifier;
  const encryptedVerifier = await encryptCredential(Buffer.from(secret), keys);
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
        secretCredentialId: credential.id,
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

export async function consumeOauthCallback(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: { workspaceId: string; state: string; userId?: string; provider?: string; now?: Date },
): Promise<{
  userId: string;
  provider: string;
  redirectUri: string;
  codeVerifier: string;
  intent?: string | null;
} | null> {
  const now = input.now ?? new Date();
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const consumed = await consumeOauthTransaction(
        transaction,
        input.workspaceId,
        hashOauthState(input.state),
        now,
        input.userId,
        input.provider,
      );
      if (!consumed) return null;
      const credential = await getActiveCredential(
        transaction,
        input.workspaceId,
        consumed.secretCredentialId,
      );
      if (!credential) throw new Error('OAuth PKCE credential is unavailable');
      const verifier = await decryptCredential(credential, keys);
      try {
        await deleteConsumedOauthSecret(
          transaction,
          input.workspaceId,
          consumed.id,
          consumed.secretCredentialId,
        );
        const secret = verifier.toString('utf8');
        const payload = secret.startsWith('{')
          ? (JSON.parse(secret) as { verifier: string; intent?: string })
          : { verifier: secret };
        return {
          userId: consumed.userId,
          provider: consumed.provider,
          redirectUri: consumed.redirectUri,
          codeVerifier: payload.verifier,
          intent: payload.intent ?? null,
        };
      } finally {
        verifier.fill(0);
      }
    },
  );
}

export async function cleanupExpiredOauthTransactions(
  database: NodePgDatabase,
  workspaceId: string,
  now = new Date(),
): Promise<number> {
  return withTenantTransaction(database, { workspaceId }, (transaction) =>
    deleteExpiredOauthSecrets(transaction, workspaceId, now),
  );
}

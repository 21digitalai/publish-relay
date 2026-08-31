import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  consumeOauthTransaction,
  createCredential,
  createOauthTransaction,
  deleteConsumedOauthSecret,
  getActiveCredential,
} from '../credentials/credential.repository.js';
import {
  decryptCredential,
  encryptCredential,
  type MasterKeyProvider,
} from '../credentials/envelope.js';
import { hashOauthState } from '../credentials/oauth.service.js';
import { connectProvider } from '../credentials/provider-connection.service.js';
import { assertActiveMembership } from '../credentials/provider-connection.repository.js';
import type { XHttpClient } from './x-http-client.js';

const X_OAUTH_TTL_MS = 10 * 60 * 1000;

export async function beginXOauthConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: XHttpClient,
  input: { workspaceId: string; userId: string; callbackUrl: string; now?: Date },
): Promise<{ authorizationUrl: string; expiresAt: Date }> {
  const requestToken = await client.beginConnection(input.callbackUrl);
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + X_OAUTH_TTL_MS);
  const encryptedSecret = await encryptCredential(
    Buffer.from(requestToken.requestTokenSecret),
    keys,
  );
  await withTenantTransaction(
    database,
    { workspaceId: input.workspaceId, userId: input.userId },
    async (transaction) => {
      await assertActiveMembership(transaction, input.workspaceId, input.userId);
      const credential = await createCredential(transaction, input.workspaceId, encryptedSecret);
      await createOauthTransaction(transaction, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        provider: 'x',
        stateHash: hashOauthState(requestToken.requestToken),
        secretCredentialId: credential.id,
        redirectUri: input.callbackUrl,
        expiresAt,
      });
    },
  );
  return { authorizationUrl: requestToken.authorizationUrl, expiresAt };
}

export async function completeXOauthConnection(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: XHttpClient,
  input: {
    workspaceId: string;
    requestToken: string;
    verifier: string;
    requestId: string;
    now?: Date;
  },
): Promise<{
  connectionId: string;
  accounts: { providerAccountId: string; displayName: string }[];
} | null> {
  const consumed = await withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const transactionRecord = await consumeOauthTransaction(
        transaction,
        input.workspaceId,
        hashOauthState(input.requestToken),
        input.now ?? new Date(),
      );
      if (transactionRecord?.provider !== 'x') return null;
      const credential = await getActiveCredential(
        transaction,
        input.workspaceId,
        transactionRecord.secretCredentialId,
      );
      if (!credential) throw new Error('X OAuth request-token secret is unavailable');
      const secret = await decryptCredential(credential, keys);
      try {
        await deleteConsumedOauthSecret(
          transaction,
          input.workspaceId,
          transactionRecord.id,
          transactionRecord.secretCredentialId,
        );
        return { userId: transactionRecord.userId, requestTokenSecret: secret.toString('utf8') };
      } finally {
        secret.fill(0);
      }
    },
  );
  if (!consumed) return null;
  const completed = await client.completeConnection(
    input.requestToken,
    consumed.requestTokenSecret,
    input.verifier,
  );
  return connectProvider(
    database,
    keys,
    {
      discoverAccounts: async (credential) => {
        const account = await client.currentAccount(credential);
        return [
          { providerAccountId: account.id, displayName: `${account.name} (@${account.username})` },
        ];
      },
    },
    {
      workspaceId: input.workspaceId,
      userId: consumed.userId,
      provider: 'x',
      accessToken: completed.credential,
      requestId: input.requestId,
    },
  );
}

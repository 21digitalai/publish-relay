import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { createCredential, revokeCredential } from './credential.repository.js';
import { encryptCredential, type MasterKeyProvider } from './envelope.js';
import {
  assertActiveMembership,
  replaceProviderConnection,
} from './provider-connection.repository.js';
import type { ProviderConnectionAdapter } from './provider-adapter.js';

export async function connectProvider(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  adapter: ProviderConnectionAdapter,
  input: {
    workspaceId: string;
    userId: string;
    provider: string;
    accessToken: string;
    requestId: string;
  },
): Promise<{
  connectionId: string;
  accounts: { providerAccountId: string; displayName: string }[];
}> {
  const accounts = await adapter.discoverAccounts(input.accessToken);
  const encrypted = await encryptCredential(Buffer.from(input.accessToken), keys);
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId, userId: input.userId },
    async (transaction) => {
      await assertActiveMembership(transaction, input.workspaceId, input.userId);
      const credential = await createCredential(transaction, input.workspaceId, encrypted);
      const connection = await replaceProviderConnection(transaction, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        provider: input.provider,
        credentialId: credential.id,
        accounts,
        requestId: input.requestId,
      });
      if (connection.replacedCredentialId)
        await revokeCredential(
          transaction,
          input.workspaceId,
          connection.replacedCredentialId,
          new Date(),
        );
      return {
        connectionId: connection.connectionId,
        accounts: accounts.map((account) => ({ ...account })),
      };
    },
  );
}

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { MasterKeyProvider } from '../credentials/envelope.js';
import { connectProvider } from '../credentials/provider-connection.service.js';
import type { XHttpClient } from './x-http-client.js';

export function parseLegacyXCredential(value: string): string {
  const trimmed = value.trim();
  const parts = trimmed.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1])
    throw new Error('Legacy X credential must contain exactly one non-empty delimiter');
  return JSON.stringify({ accessToken: parts[0], accessTokenSecret: parts[1] });
}

export async function importLegacyXCredential(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: XHttpClient,
  input: {
    workspaceId: string;
    userId: string;
    sourceIntegrationId: string;
    expectedUsername: string;
    credentialValue: string;
    requestId: string;
  },
): Promise<{
  connectionId: string;
  accounts: { providerAccountId: string; displayName: string }[];
}> {
  if (!input.sourceIntegrationId) throw new Error('Source integration identity is required');
  const credential = parseLegacyXCredential(input.credentialValue);
  const account = await client.currentAccount(credential);
  if (account.username.toLowerCase() !== input.expectedUsername.replace(/^@/, '').toLowerCase())
    throw new Error('X account identity did not match the expected account');
  return connectProvider(
    database,
    keys,
    {
      discoverAccounts: () =>
        Promise.resolve([
          {
            providerAccountId: account.id,
            displayName: account.name + ' (@' + account.username + ')',
          },
        ]),
    },
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
      provider: 'x',
      accessToken: credential,
      requestId: input.requestId,
    },
  );
}

import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  facebookPageEngagementModules,
  providerAccounts,
  providerConnections,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { getActiveCredential } from '../credentials/credential.repository.js';
import { decryptCredential, type MasterKeyProvider } from '../credentials/envelope.js';
import type { FacebookHttpClient } from './facebook-http-client.js';

const REQUIRED_SCOPES = ['pages_messaging', 'pages_manage_metadata', 'pages_read_engagement'];

export interface MessengerPageEvidence {
  accountId: string;
  pageId: string;
  credentialId: string | null;
  availability: string;
  localEnabled: boolean;
  providerGrant: string;
  connectionStatus: string;
  connectionRevokedAt: Date | null;
  scopes: unknown;
  capabilitySnapshot: unknown;
}

export function isMessengerPageEligible(evidence: MessengerPageEvidence): boolean {
  const scopes = Array.isArray(evidence.scopes) ? evidence.scopes : [];
  const tasks =
    evidence.capabilitySnapshot && typeof evidence.capabilitySnapshot === 'object'
      ? (evidence.capabilitySnapshot as { tasks?: unknown }).tasks
      : null;
  return (
    evidence.availability === 'active' &&
    evidence.localEnabled &&
    evidence.providerGrant === 'verified' &&
    evidence.connectionStatus === 'active' &&
    evidence.connectionRevokedAt === null &&
    evidence.credentialId !== null &&
    REQUIRED_SCOPES.every((scope) => scopes.includes(scope)) &&
    Array.isArray(tasks) &&
    tasks.includes('MESSAGING')
  );
}

async function loadMessengerPage(
  database: NodePgDatabase,
  workspaceId: string,
  accountId: string,
): Promise<MessengerPageEvidence | null> {
  return withTenantTransaction(database, { workspaceId }, async (transaction) => {
    const [page] = await transaction
      .select({
        accountId: providerAccounts.id,
        pageId: providerAccounts.remoteAccountId,
        credentialId: providerAccounts.credentialId,
        availability: providerAccounts.availability,
        localEnabled: facebookPageEngagementModules.dmsEnabled,
        providerGrant: facebookPageEngagementModules.dmsProviderGrant,
        connectionStatus: providerConnections.status,
        connectionRevokedAt: providerConnections.revokedAt,
        scopes: providerConnections.scopes,
        capabilitySnapshot: providerAccounts.capabilitySnapshot,
      })
      .from(providerAccounts)
      .innerJoin(
        providerConnections,
        and(
          eq(providerConnections.workspaceId, providerAccounts.workspaceId),
          eq(providerConnections.id, providerAccounts.connectionId),
        ),
      )
      .innerJoin(
        facebookPageEngagementModules,
        and(
          eq(facebookPageEngagementModules.workspaceId, providerAccounts.workspaceId),
          eq(facebookPageEngagementModules.accountId, providerAccounts.id),
        ),
      )
      .where(
        and(
          eq(providerAccounts.workspaceId, workspaceId),
          eq(providerAccounts.id, accountId),
          eq(providerAccounts.destinationProvider, 'facebook_page'),
          isNull(providerAccounts.disconnectedAt),
          eq(providerConnections.grantFamily, 'facebook_pages'),
        ),
      )
      .limit(1);
    return page ?? null;
  });
}

export async function listAccountPageConversations(
  runtime: { database: NodePgDatabase; keys: MasterKeyProvider; client: FacebookHttpClient },
  input: { workspaceId: string; accountId: string; limit?: number; after?: string },
) {
  const page = await loadMessengerPage(runtime.database, input.workspaceId, input.accountId);
  if (!page || !isMessengerPageEligible(page) || !page.credentialId)
    throw new Error('Facebook Page Messenger access is unavailable');
  const credentialId = page.credentialId;
  const stored = await withTenantTransaction(
    runtime.database,
    { workspaceId: input.workspaceId },
    (transaction) => getActiveCredential(transaction, input.workspaceId, credentialId),
  );
  if (!stored) throw new Error('Facebook Page Messenger access is unavailable');
  const plaintext = await decryptCredential(stored, runtime.keys);
  try {
    const credential = JSON.parse(plaintext.toString('utf8')) as {
      accessToken?: unknown;
      pageId?: unknown;
    };
    if (credential.pageId !== page.pageId || typeof credential.accessToken !== 'string')
      throw new Error('Facebook Page Messenger access is unavailable');
    return await runtime.client.listPageConversations({
      pageId: page.pageId,
      accessToken: credential.accessToken,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
    });
  } finally {
    plaintext.fill(0);
  }
}

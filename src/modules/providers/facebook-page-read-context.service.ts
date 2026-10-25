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

export type PageReadModule = 'comments' | 'dms';

export class PageReadUnavailableError extends Error {
  constructor() {
    super('Facebook Page engagement access is unavailable');
  }
}

export interface PageReadEvidence {
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

const MODULE_REQUIREMENTS = {
  comments: { scopes: ['pages_show_list', 'pages_read_engagement'], task: 'CREATE_CONTENT' },
  dms: {
    scopes: [
      'pages_show_list',
      'pages_messaging',
      'pages_manage_metadata',
      'pages_read_engagement',
    ],
    task: 'MESSAGING',
  },
} as const;

export function isPageReadEligible(
  evidence: PageReadEvidence,
  module: PageReadModule,
  additionalScopes: readonly string[] = [],
): boolean {
  const scopes = Array.isArray(evidence.scopes) ? evidence.scopes : [];
  const tasks =
    evidence.capabilitySnapshot && typeof evidence.capabilitySnapshot === 'object'
      ? (evidence.capabilitySnapshot as { tasks?: unknown }).tasks
      : null;
  const requirement = MODULE_REQUIREMENTS[module];
  return (
    evidence.availability === 'active' &&
    evidence.localEnabled &&
    evidence.providerGrant === 'verified' &&
    evidence.connectionStatus === 'active' &&
    evidence.connectionRevokedAt === null &&
    evidence.credentialId !== null &&
    [...requirement.scopes, ...additionalScopes].every((scope) => scopes.includes(scope)) &&
    Array.isArray(tasks) &&
    tasks.includes(requirement.task)
  );
}

async function loadPageReadEvidence(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; module: PageReadModule },
): Promise<PageReadEvidence | null> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const [page] = await transaction
        .select({
          pageId: providerAccounts.remoteAccountId,
          credentialId: providerAccounts.credentialId,
          availability: providerAccounts.availability,
          localEnabled:
            input.module === 'comments'
              ? facebookPageEngagementModules.commentsEnabled
              : facebookPageEngagementModules.dmsEnabled,
          providerGrant:
            input.module === 'comments'
              ? facebookPageEngagementModules.commentsProviderGrant
              : facebookPageEngagementModules.dmsProviderGrant,
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
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.id, input.accountId),
            eq(providerAccounts.destinationProvider, 'facebook_page'),
            isNull(providerAccounts.disconnectedAt),
            eq(providerConnections.grantFamily, 'facebook_pages'),
          ),
        )
        .limit(1);
      return page ?? null;
    },
  );
}

export async function withPageReadToken<T>(
  runtime: { database: NodePgDatabase; keys: MasterKeyProvider },
  input: {
    workspaceId: string;
    accountId: string;
    module: PageReadModule;
    additionalScopes?: readonly string[];
  },
  read: (pageId: string, accessToken: string) => Promise<T>,
): Promise<T> {
  const page = await loadPageReadEvidence(runtime.database, input);
  if (
    !page ||
    !isPageReadEligible(page, input.module, input.additionalScopes) ||
    !page.credentialId
  )
    throw new PageReadUnavailableError();
  const credentialId = page.credentialId;
  const stored = await withTenantTransaction(
    runtime.database,
    { workspaceId: input.workspaceId },
    (transaction) => getActiveCredential(transaction, input.workspaceId, credentialId),
  );
  if (!stored) throw new PageReadUnavailableError();
  const plaintext = await decryptCredential(stored, runtime.keys);
  try {
    const credential = JSON.parse(plaintext.toString('utf8')) as {
      accessToken?: unknown;
      pageId?: unknown;
    };
    if (
      credential.pageId !== page.pageId ||
      typeof credential.accessToken !== 'string' ||
      credential.accessToken.length === 0
    )
      throw new PageReadUnavailableError();
    return await read(page.pageId, credential.accessToken);
  } finally {
    plaintext.fill(0);
  }
}

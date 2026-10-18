import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  auditEvents,
  credentials,
  providerAccounts,
  providerConnections,
  workspaces,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { hasActiveProviderAccountJobs } from './provider-account-exposure.service.js';
import { z } from 'zod';
import type { youtubeDestinationDefaultsSchema } from '../providers/youtube-settings.js';
import {
  capabilityFreshness,
  destinationCapabilities,
  type DestinationCapabilitySnapshot,
} from '../providers/destination-capabilities.js';

export interface ProviderAccountSummary {
  id: string;
  provider: string;
  destinationProvider: string;
  displayName: string;
  status: string;
  availability: string;
  remoteParentAccountId: string | null;
  capabilitySnapshot: DestinationCapabilitySnapshot;
  capabilitiesCheckedAt: Date | null;
  capabilityFreshness: 'fresh' | 'stale' | 'unknown';
  adapterDefaults: unknown;
  xLongPosts: { allowed: boolean; source: 'self_declared'; verified: false } | null;
  updatedAt: Date;
  expiresAt?: Date | null;
  originWorkspaceName?: string;
  isExposed?: boolean;
}

const EXPOSED_PAGE_LIST_LIMIT = 100;

export class InvalidAccountPageCursorError extends Error {}

type AccountCursor = ['local', string, string, string] | ['exposed', string, string];

function decodePageCursor(cursor?: string): AccountCursor | null {
  if (!cursor) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return z
      .union([
        z.tuple([z.literal('local'), z.string(), z.string(), z.uuid()]),
        z.tuple([z.literal('exposed'), z.string(), z.uuid()]),
      ])
      .parse(decoded);
  } catch {
    throw new InvalidAccountPageCursorError('Invalid account page cursor');
  }
}

export async function listProviderAccounts(
  database: NodePgDatabase,
  workspaceId: string,
  userId?: string,
): Promise<ProviderAccountSummary[]> {
  const accounts: ProviderAccountSummary[] = [];
  let cursor: string | null = null;
  do {
    const page = await listProviderAccountsPage(database, workspaceId, userId, cursor ?? undefined);
    accounts.push(...page.accounts);
    cursor = page.nextCursor;
  } while (cursor);
  return accounts;
}

export function listProviderAccountsPage(
  database: NodePgDatabase,
  workspaceId: string,
  userId?: string,
  cursor?: string,
): Promise<{ accounts: ProviderAccountSummary[]; nextCursor: string | null }> {
  const after = decodePageCursor(cursor);
  return withTenantTransaction(
    database,
    { workspaceId, ...(userId ? { userId } : {}) },
    async (transaction) => {
      const localAfter = after?.[0] === 'local' ? after : null;
      const rows =
        after?.[0] === 'exposed'
          ? []
          : await transaction
              .select({
                id: providerAccounts.id,
                provider: providerConnections.provider,
                grantFamily: providerConnections.grantFamily,
                destinationProvider: providerAccounts.destinationProvider,
                displayName: providerAccounts.displayName,
                status: providerConnections.status,
                availability: providerAccounts.availability,
                remoteParentAccountId: providerAccounts.remoteParentAccountId,
                capabilitiesCheckedAt: providerAccounts.capabilitiesCheckedAt,
                adapterDefaults: providerAccounts.adapterDefaults,
                xLongPostsAllowed: providerAccounts.xLongPostsAllowed,
                updatedAt: providerAccounts.updatedAt,
                expiresAt: providerConnections.expiresAt,
                disconnectedAt: providerAccounts.disconnectedAt,
                accessExpiresAt: providerConnections.accessExpiresAt,
                refreshExpiresAt: providerConnections.refreshExpiresAt,
              })
              .from(providerAccounts)
              .innerJoin(
                providerConnections,
                and(
                  eq(providerConnections.workspaceId, providerAccounts.workspaceId),
                  eq(providerConnections.id, providerAccounts.connectionId),
                ),
              )
              .where(
                and(
                  eq(providerAccounts.workspaceId, workspaceId),
                  or(
                    isNull(providerAccounts.disconnectedAt),
                    eq(providerConnections.provider, 'tiktok'),
                  ),
                  localAfter
                    ? sql`(${providerConnections.provider}, ${providerAccounts.displayName}, ${providerAccounts.id}) > (${localAfter[1]}, ${localAfter[2]}, ${localAfter[3]}::uuid)`
                    : undefined,
                ),
              )
              .orderBy(
                providerConnections.provider,
                providerAccounts.displayName,
                providerAccounts.id,
              )
              .limit(EXPOSED_PAGE_LIST_LIMIT + 1);
      const localRows = rows.slice(0, EXPOSED_PAGE_LIST_LIMIT);
      const local = localRows.map(
        ({ accessExpiresAt, refreshExpiresAt, disconnectedAt, xLongPostsAllowed, ...row }) => ({
          ...row,
          xLongPosts:
            row.destinationProvider === 'x'
              ? {
                  allowed: xLongPostsAllowed,
                  source: 'self_declared' as const,
                  verified: false as const,
                }
              : null,
          status:
            disconnectedAt && row.provider === 'tiktok'
              ? 'disconnected'
              : row.provider === 'tiktok' && row.status === 'active'
                ? refreshExpiresAt && refreshExpiresAt.getTime() <= Date.now()
                  ? 'renewal_required'
                  : accessExpiresAt && accessExpiresAt.getTime() <= Date.now()
                    ? 'expired'
                    : 'active'
                : row.status,
          capabilitySnapshot: destinationCapabilities(row.destinationProvider),
          capabilityFreshness: capabilityFreshness(row.capabilitiesCheckedAt),
        }),
      );
      const lastLocal = localRows.at(-1);
      const localCursor = lastLocal
        ? Buffer.from(
            JSON.stringify(['local', lastLocal.provider, lastLocal.displayName, lastLocal.id]),
          ).toString('base64url')
        : null;
      if (rows.length > EXPOSED_PAGE_LIST_LIMIT || local.length === EXPOSED_PAGE_LIST_LIMIT)
        return { accounts: local, nextCursor: localCursor };
      if (!userId) return { accounts: local, nextCursor: null };
      const remaining = EXPOSED_PAGE_LIST_LIMIT - local.length;
      const exposedAfter = after?.[0] === 'exposed' ? after : null;
      const result = await transaction.execute<{
        id: string;
        displayName: string;
        originWorkspaceName: string;
        availability: string;
        connectionStatus: string;
        updatedAt: Date;
      }>(sql`
      SELECT id, display_name AS "displayName",
        origin_workspace_name AS "originWorkspaceName", availability,
        connection_status AS "connectionStatus", updated_at AS "updatedAt"
      FROM public.list_visible_exposed_facebook_pages_page(
        ${workspaceId}::uuid, ${exposedAfter?.[1] ?? null}::text,
        ${exposedAfter?.[2] ?? null}::uuid, ${remaining + 1}
      )
    `);
      const rawRows: unknown = Array.isArray(result) ? result : result.rows;
      const exposed = z
        .array(
          z.object({
            id: z.uuid(),
            displayName: z.string(),
            originWorkspaceName: z.string(),
            availability: z.string(),
            connectionStatus: z.string(),
            updatedAt: z.coerce.date(),
          }),
        )
        .parse(rawRows);
      const page = exposed.slice(0, remaining);
      const last = page.at(-1);
      return {
        accounts: [
          ...local,
          ...page.map((page) => ({
            id: page.id,
            provider: 'meta',
            destinationProvider: 'facebook_page',
            displayName: page.displayName,
            status: page.connectionStatus,
            availability: page.availability,
            remoteParentAccountId: null,
            capabilitySnapshot: destinationCapabilities('facebook_page'),
            capabilitiesCheckedAt: null,
            capabilityFreshness: 'unknown' as const,
            adapterDefaults: {},
            xLongPosts: null,
            updatedAt: new Date(page.updatedAt),
            originWorkspaceName: page.originWorkspaceName,
            isExposed: true,
          })),
        ],
        nextCursor:
          exposed.length > remaining && last
            ? Buffer.from(JSON.stringify(['exposed', last.displayName, last.id])).toString(
                'base64url',
              )
            : null,
      };
    },
  );
}

export async function updateXLongPostDeclaration(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    userId: string;
    accountId: string;
    requestId: string;
    allowed: boolean;
  },
): Promise<'updated' | 'missing'> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId, userId: input.userId },
    async (transaction) => {
      const rows = await transaction
        .select({ id: providerAccounts.id, allowed: providerAccounts.xLongPostsAllowed })
        .from(providerAccounts)
        .innerJoin(
          providerConnections,
          and(
            eq(providerConnections.workspaceId, providerAccounts.workspaceId),
            eq(providerConnections.id, providerAccounts.connectionId),
          ),
        )
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.id, input.accountId),
            eq(providerAccounts.destinationProvider, 'x'),
            eq(providerConnections.provider, 'x'),
            eq(providerConnections.status, 'active'),
            isNull(providerAccounts.disconnectedAt),
          ),
        )
        .for('update')
        .limit(1);
      if (!rows[0]) return 'missing';
      if (rows[0].allowed === input.allowed) return 'updated';
      await transaction
        .update(providerAccounts)
        .set({ xLongPostsAllowed: input.allowed, updatedAt: new Date() })
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.id, input.accountId),
          ),
        );
      await transaction.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.userId,
        action: 'provider_account.x_long_posts_declaration_updated',
        targetType: 'provider_account',
        targetId: input.accountId,
        requestId: input.requestId,
        metadata: {
          provider: 'x',
          allowed: input.allowed,
          source: 'self_declared',
          verified: false,
        },
      });
      return 'updated';
    },
  );
}

export async function updateYouTubeAccountDefaults(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    userId: string;
    accountId: string;
    requestId: string;
    defaults: z.infer<typeof youtubeDestinationDefaultsSchema>;
  },
): Promise<'updated' | 'missing'> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId, userId: input.userId },
    async (transaction) => {
      const accounts = await transaction
        .select({ id: providerAccounts.id })
        .from(providerAccounts)
        .innerJoin(
          providerConnections,
          and(
            eq(providerConnections.workspaceId, providerAccounts.workspaceId),
            eq(providerConnections.id, providerAccounts.connectionId),
          ),
        )
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.id, input.accountId),
            eq(providerConnections.provider, 'youtube'),
            eq(providerConnections.status, 'active'),
            isNull(providerAccounts.disconnectedAt),
          ),
        )
        .limit(1);
      if (!accounts[0]) return 'missing';
      await transaction
        .update(providerAccounts)
        .set({ adapterDefaults: input.defaults, updatedAt: new Date() })
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.id, input.accountId),
          ),
        );
      await transaction.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.userId,
        action: 'provider_account.defaults_updated',
        targetType: 'provider_account',
        targetId: input.accountId,
        requestId: input.requestId,
        metadata: { provider: 'youtube' },
      });
      return 'updated';
    },
  );
}

export async function disconnectProviderAccount(
  database: NodePgDatabase,
  input: { workspaceId: string; userId: string; accountId: string; requestId: string },
): Promise<'disconnected' | 'missing' | 'scheduled' | 'revoking'> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId, userId: input.userId },
    async (transaction) => {
      await transaction
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId))
        .for('update');
      const rows = await transaction
        .select({
          connectionId: providerAccounts.connectionId,
          credentialId: providerConnections.credentialId,
          connectionStatus: providerConnections.status,
        })
        .from(providerAccounts)
        .innerJoin(
          providerConnections,
          and(
            eq(providerConnections.workspaceId, providerAccounts.workspaceId),
            eq(providerConnections.id, providerAccounts.connectionId),
          ),
        )
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.id, input.accountId),
          ),
        )
        .limit(1);
      const account = rows[0];
      if (!account) return 'missing';
      if (account.connectionStatus === 'revoking') return 'revoking';
      if (await hasActiveProviderAccountJobs(transaction, input.workspaceId, input.accountId))
        return 'scheduled';
      await transaction
        .update(providerAccounts)
        .set({ disconnectedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.id, input.accountId),
          ),
        );
      const remaining = await transaction
        .select({ id: providerAccounts.id })
        .from(providerAccounts)
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.connectionId, account.connectionId),
            isNull(providerAccounts.disconnectedAt),
          ),
        )
        .limit(1);
      if (!remaining[0]) {
        await transaction
          .update(providerConnections)
          .set({ status: 'disconnected', updatedAt: new Date() })
          .where(
            and(
              eq(providerConnections.workspaceId, input.workspaceId),
              eq(providerConnections.id, account.connectionId),
            ),
          );
        await transaction
          .update(credentials)
          .set({ revokedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(credentials.workspaceId, input.workspaceId),
              eq(credentials.id, account.credentialId),
            ),
          );
      }
      await transaction.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.userId,
        action: 'provider_account.disconnected',
        targetType: 'provider_account',
        targetId: input.accountId,
        requestId: input.requestId,
        metadata: {},
      });
      return 'disconnected';
    },
  );
}

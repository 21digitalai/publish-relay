import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerAccounts, providerConnections, workspaces } from '../../database/schema.js';

export interface PostAccountMetadata extends Record<string, unknown> {
  id: string;
  destinationProvider: string;
  disconnectedAt: Date | null;
  connectionStatus: string;
  xLongPostsAllowed: boolean;
  provider: string;
  scopes: unknown;
  accessExpiresAt: Date | null;
  expiresAt: Date | null;
  adapterDefaults: unknown;
  availability: string;
}

/** Cross-workspace projection is narrow, owner-granted, and never includes credentials. */
export async function loadPostAccounts(
  database: NodePgDatabase,
  workspaceId: string,
  accountIds: readonly string[],
  reserve: boolean,
): Promise<PostAccountMetadata[]> {
  const local = await database
    .select({
      id: providerAccounts.id,
      destinationProvider: providerAccounts.destinationProvider,
      disconnectedAt: providerAccounts.disconnectedAt,
      connectionStatus: providerConnections.status,
      xLongPostsAllowed: providerAccounts.xLongPostsAllowed,
      provider: providerConnections.provider,
      scopes: providerConnections.scopes,
      accessExpiresAt: providerConnections.accessExpiresAt,
      expiresAt: providerConnections.expiresAt,
      adapterDefaults: providerAccounts.adapterDefaults,
      availability: providerAccounts.availability,
    })
    .from(providerAccounts)
    .innerJoin(providerConnections, eq(providerConnections.id, providerAccounts.connectionId))
    .where(
      and(eq(providerAccounts.workspaceId, workspaceId), inArray(providerAccounts.id, accountIds)),
    );
  if (local.length === accountIds.length) {
    if (!reserve) return local;
    await database
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for('update');
    return loadPostAccounts(database, workspaceId, accountIds, false);
  }

  const result = await database.execute<PostAccountMetadata>(sql`
    SELECT id, destination_provider AS "destinationProvider",
      disconnected_at AS "disconnectedAt", connection_status AS "connectionStatus",
      x_long_posts_allowed AS "xLongPostsAllowed", provider, scopes,
      access_expires_at AS "accessExpiresAt", expires_at AS "expiresAt",
      adapter_defaults AS "adapterDefaults", availability
    FROM public.resolve_exposed_post_accounts(
      ${workspaceId}::uuid,
      ARRAY[${sql.join(
        accountIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]::uuid[],
      ${reserve}
    )
  `);
  return Array.isArray(result) ? result : result.rows;
}

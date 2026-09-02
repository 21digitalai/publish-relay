import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

import { withTenantTransaction } from '../../database/tenant-transaction.js';

export const ACTIVE_TARGET_STATES = ['scheduled', 'leased', 'dispatching', 'retry_wait'] as const;

export interface WorkspaceUsageFacts {
  media: {
    retainedBytes: number;
    countsByState: { temporary: number; ready: number; deleted: number };
  };
  connectedProviderAccounts: number;
  distinctProviderFamilies: number;
  existingPublicationTargets: number;
  requestedPublicationTargets: number;
  queuedOrScheduledTargets: number;
  furthestScheduledAt: Date | null;
  workspaceMembers: number;
}

interface FactsRow extends Record<string, unknown> {
  retained_bytes: string;
  temporary_media: string;
  ready_media: string;
  deleted_media: string;
  connected_accounts: string;
  provider_families: string;
  existing_targets: string;
  active_targets: string;
  furthest_scheduled_at: Date | null;
  workspace_members: string;
}

export interface UsageFactsRequest {
  workspaceId: string;
  requestedProviderAccountIds?: readonly string[];
}

export async function getWorkspaceUsageFacts(
  database: NodePgDatabase,
  request: UsageFactsRequest,
): Promise<WorkspaceUsageFacts> {
  return withTenantTransaction(
    database,
    { workspaceId: request.workspaceId },
    (transaction) => getWorkspaceUsageFactsInTransaction(transaction, request),
  );
}

export async function getWorkspaceUsageFactsInTransaction(
  transaction: NodePgDatabase,
  request: UsageFactsRequest,
): Promise<WorkspaceUsageFacts> {
  const result = await transaction.execute<FactsRow>(sql`
      select
        coalesce((select sum(byte_size) from media_objects where workspace_id = ${request.workspaceId} and state <> 'deleted'), 0)::text as retained_bytes,
        (select count(*) from media_objects where workspace_id = ${request.workspaceId} and state = 'temporary')::text as temporary_media,
        (select count(*) from media_objects where workspace_id = ${request.workspaceId} and state = 'ready')::text as ready_media,
        (select count(*) from media_objects where workspace_id = ${request.workspaceId} and state = 'deleted')::text as deleted_media,
        (select count(*) from provider_accounts pa join provider_connections pc on pc.id = pa.connection_id and pc.workspace_id = pa.workspace_id where pa.workspace_id = ${request.workspaceId} and pa.disconnected_at is null and pc.status = 'active')::text as connected_accounts,
        (select count(distinct pc.provider) from provider_accounts pa join provider_connections pc on pc.id = pa.connection_id and pc.workspace_id = pa.workspace_id where pa.workspace_id = ${request.workspaceId} and pa.disconnected_at is null and pc.status = 'active')::text as provider_families,
        (select count(*) from publication_jobs where workspace_id = ${request.workspaceId})::text as existing_targets,
        (select count(*) from publication_jobs where workspace_id = ${request.workspaceId} and state in ('scheduled', 'leased', 'dispatching', 'retry_wait'))::text as active_targets,
        (select max(scheduled_at) from publication_jobs where workspace_id = ${request.workspaceId} and state in ('scheduled', 'leased', 'dispatching', 'retry_wait')) as furthest_scheduled_at,
        (select count(*) from memberships where workspace_id = ${request.workspaceId})::text as workspace_members
    `);
  return mapFacts(result.rows[0], new Set(request.requestedProviderAccountIds ?? []).size);
}

function mapFacts(
  row: FactsRow | undefined,
  requestedPublicationTargets: number,
): WorkspaceUsageFacts {
  if (!row) throw new Error('Workspace usage facts query returned no row');
  return {
    media: {
      retainedBytes: Number(row.retained_bytes),
      countsByState: {
        temporary: Number(row.temporary_media),
        ready: Number(row.ready_media),
        deleted: Number(row.deleted_media),
      },
    },
    connectedProviderAccounts: Number(row.connected_accounts),
    distinctProviderFamilies: Number(row.provider_families),
    existingPublicationTargets: Number(row.existing_targets),
    requestedPublicationTargets,
    queuedOrScheduledTargets: Number(row.active_targets),
    furthestScheduledAt: row.furthest_scheduled_at,
    workspaceMembers: Number(row.workspace_members),
  };
}

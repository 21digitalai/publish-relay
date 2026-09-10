import { and, asc, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  auditEvents,
  externalDraftMedia,
  externalDrafts,
  mediaObjects,
  workspaces,
} from '../../database/schema.js';

export interface ExternalDraftRecord {
  id: string;
  workspaceSlug: string;
  externalId: string;
  label: string | null;
  returnUrl: string | null;
  requestFingerprint: string;
  postId: string | null;
  mediaIds: string[];
  createdAt: Date;
}

export async function findExternalDraft(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    actorType: 'api_key' | 'delegated';
    actorId: string;
    externalId: string;
  },
): Promise<ExternalDraftRecord | null> {
  const rows = await database
    .select()
    .from(externalDrafts)
    .where(
      and(
        eq(externalDrafts.workspaceId, input.workspaceId),
        eq(externalDrafts.sourceActorType, input.actorType),
        eq(externalDrafts.sourceActorId, input.actorId),
        eq(externalDrafts.externalId, input.externalId),
      ),
    )
    .limit(1);
  const draft = rows[0];
  if (!draft) return null;
  const workspaceRows = await database
    .select({ slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .limit(1);
  const workspace = workspaceRows[0];
  if (!workspace) return null;
  const media = await database
    .select({ id: externalDraftMedia.mediaId })
    .from(externalDraftMedia)
    .where(
      and(
        eq(externalDraftMedia.workspaceId, input.workspaceId),
        eq(externalDraftMedia.draftId, draft.id),
      ),
    )
    .orderBy(asc(externalDraftMedia.position));
  return { ...draft, workspaceSlug: workspace.slug, mediaIds: media.map((item) => item.id) };
}

export async function getExternalDraftById(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    actorType: 'api_key' | 'delegated';
    actorId: string;
    draftId: string;
  },
): Promise<ExternalDraftRecord | null> {
  const rows = await database
    .select({ externalId: externalDrafts.externalId })
    .from(externalDrafts)
    .where(
      and(
        eq(externalDrafts.workspaceId, input.workspaceId),
        eq(externalDrafts.sourceActorType, input.actorType),
        eq(externalDrafts.sourceActorId, input.actorId),
        eq(externalDrafts.id, input.draftId),
      ),
    )
    .limit(1);
  const draft = rows[0];
  if (!draft) return null;
  return findExternalDraft(database, { ...input, externalId: draft.externalId });
}

export async function insertExternalDraft(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    actorType: 'api_key' | 'delegated';
    actorId: string;
    sourceClientId?: string;
    externalId: string;
    label?: string;
    returnUrl?: string;
    requestFingerprint: string;
    mediaIds: string[];
    requestId: string;
  },
): Promise<ExternalDraftRecord | null> {
  const readyMedia = await database
    .select({ id: mediaObjects.id })
    .from(mediaObjects)
    .where(
      and(
        eq(mediaObjects.workspaceId, input.workspaceId),
        eq(mediaObjects.state, 'ready'),
        inArray(mediaObjects.id, input.mediaIds),
      ),
    );
  if (readyMedia.length !== input.mediaIds.length) throw new Error('Draft media is unavailable');
  const inserted = await database
    .insert(externalDrafts)
    .values({
      workspaceId: input.workspaceId,
      sourceActorType: input.actorType,
      sourceActorId: input.actorId,
      sourceClientId: input.sourceClientId,
      externalId: input.externalId,
      label: input.label,
      returnUrl: input.returnUrl,
      requestFingerprint: input.requestFingerprint,
    })
    .onConflictDoNothing()
    .returning();
  const draft = inserted[0];
  if (!draft) return null;
  await database.insert(externalDraftMedia).values(
    input.mediaIds.map((mediaId, position) => ({
      workspaceId: input.workspaceId,
      draftId: draft.id,
      mediaId,
      position,
    })),
  );
  await database.insert(auditEvents).values({
    workspaceId: input.workspaceId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: 'external_draft.created',
    targetType: 'external_draft',
    targetId: draft.id,
    requestId: input.requestId,
    metadata: { externalId: input.externalId, sourceClientId: input.sourceClientId ?? null },
  });
  const workspaceRows = await database
    .select({ slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .limit(1);
  const workspace = workspaceRows[0];
  if (!workspace) throw new Error('Draft workspace is unavailable');
  return { ...draft, workspaceSlug: workspace.slug, mediaIds: input.mediaIds };
}

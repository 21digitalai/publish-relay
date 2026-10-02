import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
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
  media?: {
    id: string;
    mimeType: string | null;
    byteSize: number | null;
    durationMs: number | null;
    state: string | null;
  }[];
}

export class ExternalDraftMediaUnavailableError extends Error {}

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

export async function getExternalDraftForWorkspace(
  database: NodePgDatabase,
  input: { workspaceId: string; draftId: string },
): Promise<ExternalDraftRecord | null> {
  const rows = await database
    .select()
    .from(externalDrafts)
    .where(
      and(eq(externalDrafts.workspaceId, input.workspaceId), eq(externalDrafts.id, input.draftId)),
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
    .select({
      id: externalDraftMedia.mediaId,
      mimeType: mediaObjects.mimeType,
      byteSize: mediaObjects.byteSize,
      durationMs: mediaObjects.durationMs,
      state: mediaObjects.state,
    })
    .from(externalDraftMedia)
    .leftJoin(
      mediaObjects,
      and(
        eq(mediaObjects.workspaceId, externalDraftMedia.workspaceId),
        eq(mediaObjects.id, externalDraftMedia.mediaId),
      ),
    )
    .where(
      and(
        eq(externalDraftMedia.workspaceId, input.workspaceId),
        eq(externalDraftMedia.draftId, input.draftId),
      ),
    )
    .orderBy(asc(externalDraftMedia.position));
  return {
    ...draft,
    workspaceSlug: workspace.slug,
    mediaIds: media.map((item) => item.id),
    media,
  };
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
  if (readyMedia.length !== input.mediaIds.length)
    throw new ExternalDraftMediaUnavailableError('Draft media is unavailable');
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

export async function transitionExternalDraft(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    draftId: string;
    postId: string;
    userId: string;
    requestId: string;
  },
): Promise<boolean> {
  const transitioned = await database
    .update(externalDrafts)
    .set({ postId: input.postId, transitionedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(externalDrafts.workspaceId, input.workspaceId),
        eq(externalDrafts.id, input.draftId),
        isNull(externalDrafts.postId),
      ),
    )
    .returning({ id: externalDrafts.id });
  if (!transitioned[0]) return false;
  await database.insert(auditEvents).values({
    workspaceId: input.workspaceId,
    actorType: 'user',
    actorId: input.userId,
    action: 'external_draft.transitioned',
    targetType: 'external_draft',
    targetId: input.draftId,
    requestId: input.requestId,
    metadata: { postId: input.postId },
  });
  return true;
}

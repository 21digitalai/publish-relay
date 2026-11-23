import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { auditEvents, memberships, sessions, users, workspaces } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { consumePersistentAuthRateLimit } from './auth-rate-limit.repository.js';
import type { AuthStore, WorkspaceSummary } from './auth.service.js';

function workspaceSlug(name: string): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'workspace';
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

export function createPostgresAuthStore(database: NodePgDatabase): AuthStore {
  return {
    async register(input) {
      return database.transaction(async (transaction) => {
        const [user] = await transaction
          .insert(users)
          .values({
            displayName: input.displayName,
            email: input.email,
            passwordHash: input.passwordHash,
          })
          .returning({ id: users.id });
        const [workspace] = await transaction
          .insert(workspaces)
          .values({ name: input.workspaceName, slug: workspaceSlug(input.workspaceName) })
          .returning({ id: workspaces.id });
        if (!user || !workspace) throw new Error('Registration records were not created');
        await transaction.execute(
          sql`select set_config('app.workspace_id', ${workspace.id}, true)`,
        );
        await transaction
          .insert(memberships)
          .values({ workspaceId: workspace.id, userId: user.id, role: 'owner' });
        await transaction
          .update(users)
          .set({ defaultWorkspaceId: workspace.id })
          .where(eq(users.id, user.id));
        return { userId: user.id, workspaceId: workspace.id, role: 'owner' };
      });
    },
    async findLogin(email) {
      const [user] = await database
        .select({
          userId: users.id,
          passwordHash: users.passwordHash,
          workspaceId: users.defaultWorkspaceId,
        })
        .from(users)
        .innerJoin(workspaces, eq(workspaces.id, users.defaultWorkspaceId))
        .where(
          and(
            sql`lower(${users.email}) = ${email}`,
            eq(users.isDisabled, false),
            isNull(users.reviewAccessExpiresAt),
            isNull(workspaces.deletedAt),
          ),
        )
        .limit(1);
      const workspaceId = user?.workspaceId;
      if (!user || !workspaceId || !user.passwordHash) return null;
      const passwordHash = user.passwordHash;
      return withTenantTransaction(
        database,
        { workspaceId, userId: user.userId },
        async (transaction) => {
          const [membership] = await transaction
            .select({ role: memberships.role })
            .from(memberships)
            .where(
              and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, user.userId)),
            )
            .limit(1);
          return membership
            ? { userId: user.userId, passwordHash, workspaceId, role: membership.role }
            : null;
        },
      );
    },
    async findReviewerLogin(email, now) {
      const [user] = await database
        .select({
          userId: users.id,
          passwordHash: users.passwordHash,
          workspaceId: users.defaultWorkspaceId,
          reviewAccessExpiresAt: users.reviewAccessExpiresAt,
        })
        .from(users)
        .innerJoin(workspaces, eq(workspaces.id, users.defaultWorkspaceId))
        .where(
          and(
            sql`lower(${users.email}) = ${email}`,
            eq(users.isDisabled, false),
            sql`${users.reviewAccessExpiresAt} > ${now}`,
            isNull(workspaces.deletedAt),
          ),
        )
        .limit(1);
      const workspaceId = user?.workspaceId;
      const reviewAccessExpiresAt = user?.reviewAccessExpiresAt;
      if (!user || !workspaceId || !user.passwordHash || !reviewAccessExpiresAt) return null;
      const passwordHash = user.passwordHash;
      return withTenantTransaction(
        database,
        { workspaceId, userId: user.userId },
        async (transaction) => {
          const [membership] = await transaction
            .select({ role: memberships.role })
            .from(memberships)
            .where(
              and(
                eq(memberships.workspaceId, workspaceId),
                eq(memberships.userId, user.userId),
                eq(memberships.role, 'editor'),
              ),
            )
            .limit(1);
          return membership
            ? {
                userId: user.userId,
                passwordHash,
                workspaceId,
                role: membership.role,
                reviewAccessExpiresAt,
              }
            : null;
        },
      );
    },
    async consumeReviewerRateLimit(input) {
      return consumePersistentAuthRateLimit(database, input);
    },
    async createSession(input) {
      await withTenantTransaction(database, input, async (transaction) => {
        await transaction.insert(sessions).values(input);
      });
    },
    async revokeSessionsForUser(workspaceId, userId) {
      await withTenantTransaction(database, { workspaceId, userId }, async (transaction) => {
        await transaction
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(sessions.workspaceId, workspaceId),
              eq(sessions.userId, userId),
              isNull(sessions.revokedAt),
            ),
          );
      });
    },
    async revokeSession(workspaceId, tokenHash) {
      await withTenantTransaction(database, { workspaceId }, async (transaction) => {
        await transaction
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.tokenHash, tokenHash)));
      });
    },
    async findSession(workspaceId, tokenHash) {
      return withTenantTransaction(database, { workspaceId }, async (transaction) => {
        const [row] = await transaction
          .select({
            userId: sessions.userId,
            workspaceId: sessions.workspaceId,
            role: memberships.role,
            expiresAt: sessions.expiresAt,
            revokedAt: sessions.revokedAt,
          })
          .from(sessions)
          .innerJoin(workspaces, eq(workspaces.id, sessions.workspaceId))
          .innerJoin(
            memberships,
            and(
              eq(memberships.userId, sessions.userId),
              eq(memberships.workspaceId, sessions.workspaceId),
            ),
          )
          .where(
            and(
              eq(sessions.workspaceId, workspaceId),
              eq(sessions.tokenHash, tokenHash),
              isNull(workspaces.deletedAt),
            ),
          )
          .limit(1);
        return row ?? null;
      });
    },
    async findCurrentRole(userId, workspaceId) {
      return withTenantTransaction(database, { workspaceId, userId }, async (transaction) => {
        const [row] = await transaction
          .select({ role: memberships.role })
          .from(memberships)
          .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
          .where(
            and(
              eq(memberships.userId, userId),
              eq(memberships.workspaceId, workspaceId),
              isNull(workspaces.deletedAt),
            ),
          )
          .limit(1);
        return row?.role ?? null;
      });
    },
    async findShellProfile(workspaceId, userId) {
      return withTenantTransaction(database, { workspaceId, userId }, async (transaction) => {
        const [profile] = await transaction
          .select({
            displayName: users.displayName,
            email: users.email,
            id: workspaces.id,
            name: workspaces.name,
            slug: workspaces.slug,
            role: memberships.role,
            position: memberships.position,
          })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
          .where(
            and(
              eq(memberships.workspaceId, workspaceId),
              eq(memberships.userId, userId),
              isNull(workspaces.deletedAt),
            ),
          )
          .limit(1);
        return profile
          ? {
              user: { displayName: profile.displayName, email: profile.email },
              workspace: {
                id: profile.id,
                name: profile.name,
                slug: profile.slug,
                role: profile.role,
                position: profile.position,
              },
            }
          : null;
      });
    },
    async findWorkspace(workspaceId, userId) {
      return withTenantTransaction(database, { workspaceId, userId }, async (transaction) => {
        const [workspace] = await transaction
          .select({
            id: workspaces.id,
            name: workspaces.name,
            slug: workspaces.slug,
            timezone: workspaces.timezone,
          })
          .from(workspaces)
          .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
          .limit(1);
        return workspace ?? null;
      });
    },
    async updateWorkspace(workspaceId, userId, input) {
      return withTenantTransaction(database, { workspaceId, userId }, async (transaction) => {
        const [workspace] = await transaction
          .update(workspaces)
          .set({
            name: input.name,
            slug: input.slug,
            ...(input.timezone ? { timezone: input.timezone } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
          .returning({
            id: workspaces.id,
            name: workspaces.name,
            slug: workspaces.slug,
            timezone: workspaces.timezone,
          });
        if (!workspace) throw new Error('Workspace was not found');
        return workspace;
      });
    },
    async listWorkspaces(userId) {
      return database.transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('app.user_id', ${userId}, true)`);
        const result = await transaction.execute<WorkspaceSummary & Record<string, unknown>>(
          sql`select * from public.list_user_workspaces(${userId}::uuid)`,
        );
        return result.rows;
      });
    },
    async createWorkspace(userId, name, position) {
      return database.transaction(async (transaction) => {
        const [workspace] = await transaction
          .insert(workspaces)
          .values({ name, slug: workspaceSlug(name) })
          .returning({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug });
        if (!workspace) throw new Error('Workspace was not created');
        await transaction.execute(
          sql`select set_config('app.workspace_id', ${workspace.id}, true)`,
        );
        await transaction.insert(memberships).values({
          workspaceId: workspace.id,
          userId,
          role: 'owner',
          position,
        });
        await transaction.insert(auditEvents).values({
          workspaceId: workspace.id,
          actorType: 'user',
          actorId: userId,
          action: 'workspace_created',
          targetType: 'workspace',
          targetId: workspace.id,
          requestId: crypto.randomUUID(),
          metadata: {},
        });
        return { ...workspace, role: 'owner', position };
      });
    },
    async reorderWorkspaces(userId, workspaceIds) {
      await database.transaction(async (transaction) => {
        for (const [position, workspaceId] of workspaceIds.entries()) {
          await transaction.execute(
            sql`select set_config('app.workspace_id', ${workspaceId}, true)`,
          );
          const [active] = await transaction
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
            .limit(1);
          if (!active) throw new Error('Workspace order contains a deleted workspace');
          const [updated] = await transaction
            .update(memberships)
            .set({ position })
            .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
            .returning({ workspaceId: memberships.workspaceId });
          if (!updated) throw new Error('Workspace order contains an unknown workspace');
        }
      });
    },
    async deleteWorkspace(input) {
      if (input.targetWorkspaceId === input.currentWorkspaceId)
        return 'Switch away before deleting this workspace';
      return withTenantTransaction(
        database,
        { workspaceId: input.targetWorkspaceId, userId: input.userId },
        async (transaction) => {
          // Serialize deletions by this owner, including requests from different sessions.
          await transaction
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, input.userId))
            .for('update')
            .limit(1);
          const [workspace] = await transaction
            .select({ id: workspaces.id, name: workspaces.name })
            .from(workspaces)
            .where(and(eq(workspaces.id, input.targetWorkspaceId), isNull(workspaces.deletedAt)))
            .for('update')
            .limit(1);
          if (!workspace) return 'Workspace was not found';
          const [membership] = await transaction
            .select({ role: memberships.role })
            .from(memberships)
            .where(
              and(eq(memberships.workspaceId, workspace.id), eq(memberships.userId, input.userId)),
            )
            .limit(1);
          if (!membership) return 'Workspace was not found';
          if (membership.role !== 'owner') return 'Only an owner can delete this workspace';
          const active = await transaction.execute<{ count: number }>(
            sql`SELECT count(*)::integer AS count FROM public.list_user_workspaces(${input.userId}::uuid)`,
          );
          if ((active.rows[0]?.count ?? 0) <= 1) return 'The last workspace cannot be deleted';
          const [current] = await transaction
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(and(eq(workspaces.id, input.currentWorkspaceId), isNull(workspaces.deletedAt)))
            .limit(1);
          if (!current) return 'Current workspace is unavailable';
          if (workspace.name !== input.confirmedName)
            return 'Workspace name confirmation does not match';
          const members = await transaction.execute<{ count: number }>(
            sql`SELECT count(*)::integer AS count FROM public.memberships WHERE workspace_id = ${workspace.id}::uuid`,
          );
          if ((members.rows[0]?.count ?? 0) > 1) return 'Workspace has other members';
          const [activeSession] = await transaction
            .select({ id: sessions.id })
            .from(sessions)
            .where(
              and(
                eq(sessions.workspaceId, workspace.id),
                isNull(sessions.revokedAt),
                sql`${sessions.expiresAt} > now()`,
              ),
            )
            .limit(1);
          if (activeSession) return 'Workspace has active sessions';
          const dependency = await transaction.execute<{ blocker: string | null }>(
            sql`SELECT public.workspace_deletion_blocker(${workspace.id}::uuid) AS blocker`,
          );
          if (dependency.rows[0]?.blocker) return dependency.rows[0].blocker;
          const now = new Date();
          await transaction
            .update(users)
            .set({ defaultWorkspaceId: input.currentWorkspaceId, updatedAt: now })
            .where(and(eq(users.id, input.userId), eq(users.defaultWorkspaceId, workspace.id)));
          await transaction
            .update(users)
            .set({ defaultWorkspaceId: null, updatedAt: now })
            .where(eq(users.defaultWorkspaceId, workspace.id));
          await transaction
            .update(sessions)
            .set({ revokedAt: now })
            .where(and(eq(sessions.workspaceId, workspace.id), isNull(sessions.revokedAt)));
          await transaction
            .update(workspaces)
            .set({ deletedAt: now, updatedAt: now })
            .where(eq(workspaces.id, workspace.id));
          await transaction.insert(auditEvents).values({
            workspaceId: workspace.id,
            actorType: 'user',
            actorId: input.userId,
            action: 'workspace_deleted',
            targetType: 'workspace',
            targetId: workspace.id,
            requestId: crypto.randomUUID(),
            metadata: {},
          });
          return null;
        },
      );
    },
    async rotateWorkspaceSession(input) {
      return database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select set_config('app.workspace_id', ${input.targetWorkspaceId}, true)`,
        );
        await transaction.execute(sql`select set_config('app.user_id', ${input.userId}, true)`);
        // Match deletion's lock order so a switch cannot create a session after tombstoning.
        const [user] = await transaction
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, input.userId))
          .for('update')
          .limit(1);
        if (!user) return null;
        const [target] = await transaction
          .select({ workspaceId: workspaces.id, slug: workspaces.slug, role: memberships.role })
          .from(memberships)
          .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
          .where(
            and(
              eq(memberships.workspaceId, input.targetWorkspaceId),
              eq(memberships.userId, input.userId),
              isNull(workspaces.deletedAt),
            ),
          )
          .for('key share', { of: workspaces })
          .limit(1);
        if (!target) return null;
        await transaction.execute(
          sql`select set_config('app.workspace_id', ${input.currentWorkspaceId}, true)`,
        );
        const [revoked] = await transaction
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(sessions.workspaceId, input.currentWorkspaceId),
              eq(sessions.tokenHash, input.currentTokenHash),
              isNull(sessions.revokedAt),
            ),
          )
          .returning({ id: sessions.id });
        if (!revoked) return null;
        await transaction.execute(
          sql`select set_config('app.workspace_id', ${input.targetWorkspaceId}, true)`,
        );
        await transaction.insert(sessions).values({
          workspaceId: target.workspaceId,
          userId: input.userId,
          tokenHash: input.tokenHash,
          csrfSecretHash: input.csrfSecretHash,
          expiresAt: input.expiresAt,
        });
        await transaction
          .update(users)
          .set({ defaultWorkspaceId: target.workspaceId, updatedAt: new Date() })
          .where(eq(users.id, input.userId));
        await transaction.insert(auditEvents).values({
          workspaceId: target.workspaceId,
          actorType: 'user',
          actorId: input.userId,
          action: 'workspace_switched',
          targetType: 'workspace',
          targetId: target.workspaceId,
          requestId: crypto.randomUUID(),
          metadata: { fromWorkspaceId: input.currentWorkspaceId },
        });
        return {
          userId: input.userId,
          workspaceId: target.workspaceId,
          role: target.role,
          slug: target.slug,
        };
      });
    },
  };
}

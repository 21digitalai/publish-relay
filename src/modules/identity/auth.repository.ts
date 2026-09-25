import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { auditEvents, memberships, sessions, users, workspaces } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
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
        .where(and(sql`lower(${users.email}) = ${email}`, eq(users.isDisabled, false)))
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
          .innerJoin(
            memberships,
            and(
              eq(memberships.userId, sessions.userId),
              eq(memberships.workspaceId, sessions.workspaceId),
            ),
          )
          .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.tokenHash, tokenHash)))
          .limit(1);
        return row ?? null;
      });
    },
    async findCurrentRole(userId, workspaceId) {
      return withTenantTransaction(database, { workspaceId, userId }, async (transaction) => {
        const [row] = await transaction
          .select({ role: memberships.role })
          .from(memberships)
          .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)))
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
          .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
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
          .where(eq(workspaces.id, workspaceId))
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
          .where(eq(workspaces.id, workspaceId))
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
          const [updated] = await transaction
            .update(memberships)
            .set({ position })
            .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
            .returning({ workspaceId: memberships.workspaceId });
          if (!updated) throw new Error('Workspace order contains an unknown workspace');
        }
      });
    },
    async rotateWorkspaceSession(input) {
      return database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select set_config('app.workspace_id', ${input.targetWorkspaceId}, true)`,
        );
        await transaction.execute(sql`select set_config('app.user_id', ${input.userId}, true)`);
        const [target] = await transaction
          .select({ workspaceId: workspaces.id, slug: workspaces.slug, role: memberships.role })
          .from(memberships)
          .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
          .where(
            and(
              eq(memberships.workspaceId, input.targetWorkspaceId),
              eq(memberships.userId, input.userId),
            ),
          )
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

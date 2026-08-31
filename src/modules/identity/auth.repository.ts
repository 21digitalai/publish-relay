import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { memberships, sessions, users, workspaces } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { AuthStore } from './auth.service.js';

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
          .values({ email: input.email, passwordHash: input.passwordHash })
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
      if (!user || !workspaceId) return null;
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
          return membership ? { ...user, workspaceId, role: membership.role } : null;
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
  };
}

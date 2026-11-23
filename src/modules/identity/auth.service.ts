import { createOpaqueToken, hashOpaqueToken } from './session.js';
import { hashPassword, verifyPassword } from './password.js';
import { requireWorkspaceAction, type MembershipRole } from './authorization.js';

export const MAX_WORKSPACES_PER_USER = 100;

export interface AuthIdentity {
  userId: string;
  workspaceId: string;
  role: MembershipRole;
}

export interface AuthStore {
  register: (input: {
    displayName: string;
    email: string;
    passwordHash: string;
    workspaceName: string;
  }) => Promise<AuthIdentity>;
  findLogin: (email: string) => Promise<(AuthIdentity & { passwordHash: string }) | null>;
  findReviewerLogin: (
    email: string,
    now: Date,
  ) => Promise<(AuthIdentity & { passwordHash: string; reviewAccessExpiresAt: Date }) | null>;
  createSession: (
    input: AuthIdentity & { tokenHash: string; csrfSecretHash: string; expiresAt: Date },
  ) => Promise<void>;
  revokeSessionsForUser: (workspaceId: string, userId: string) => Promise<void>;
  revokeSession: (workspaceId: string, tokenHash: string) => Promise<void>;
  findSession: (
    workspaceId: string,
    tokenHash: string,
  ) => Promise<(AuthIdentity & { expiresAt: Date; revokedAt: Date | null }) | null>;
  findCurrentRole: (userId: string, workspaceId: string) => Promise<MembershipRole | null>;
  findShellProfile: (workspaceId: string, userId: string) => Promise<ShellProfile | null>;
  findWorkspace: (
    workspaceId: string,
    userId: string,
  ) => Promise<{ id: string; name: string; slug: string; timezone: string } | null>;
  updateWorkspace: (
    workspaceId: string,
    userId: string,
    input: { name: string; slug: string; timezone?: string },
  ) => Promise<{ id: string; name: string; slug: string; timezone: string }>;
  listWorkspaces: (userId: string) => Promise<WorkspaceSummary[]>;
  createWorkspace: (userId: string, name: string, position: number) => Promise<WorkspaceSummary>;
  reorderWorkspaces: (userId: string, workspaceIds: string[]) => Promise<void>;
  deleteWorkspace: (input: {
    userId: string;
    currentWorkspaceId: string;
    targetWorkspaceId: string;
    confirmedName: string;
  }) => Promise<string | null>;
  rotateWorkspaceSession: (input: {
    currentWorkspaceId: string;
    currentTokenHash: string;
    targetWorkspaceId: string;
    userId: string;
    tokenHash: string;
    csrfSecretHash: string;
    expiresAt: Date;
  }) => Promise<(AuthIdentity & { slug: string }) | null>;
}

export interface ShellProfile {
  user: { displayName: string; email: string };
  workspace: WorkspaceSummary;
}

export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  role: MembershipRole;
  position: number;
}

export interface SessionResult extends AuthIdentity {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export class AuthService {
  constructor(
    private readonly store: AuthStore,
    private readonly sessionLifetimeMs = 1000 * 60 * 60 * 24 * 30,
  ) {}

  async register(
    displayName: string,
    email: string,
    password: string,
    workspaceName: string,
  ): Promise<SessionResult> {
    const identity = await this.store.register({
      displayName: displayName.trim(),
      email: email.trim().toLowerCase(),
      passwordHash: await hashPassword(password),
      workspaceName,
    });
    return this.issueSession(identity, new Date());
  }

  async login(email: string, password: string, now = new Date()): Promise<SessionResult | null> {
    const identity = await this.store.findLogin(email.trim().toLowerCase());
    if (!identity || !(await verifyPassword(identity.passwordHash, password))) return null;
    await this.store.revokeSessionsForUser(identity.workspaceId, identity.userId);
    return this.issueSession(identity, now);
  }

  async loginReviewer(
    email: string,
    password: string,
    now = new Date(),
  ): Promise<SessionResult | null> {
    const identity = await this.store.findReviewerLogin(email.trim().toLowerCase(), now);
    if (!identity || !(await verifyPassword(identity.passwordHash, password))) return null;
    await this.store.revokeSessionsForUser(identity.workspaceId, identity.userId);
    return this.issueSession(identity, now, identity.reviewAccessExpiresAt);
  }

  private async issueSession(
    identity: AuthIdentity,
    now: Date,
    maximumExpiresAt?: Date,
  ): Promise<SessionResult> {
    const token = createOpaqueToken();
    const csrfToken = createOpaqueToken();
    const normalExpiresAt = new Date(now.getTime() + this.sessionLifetimeMs);
    const expiresAt =
      maximumExpiresAt && maximumExpiresAt < normalExpiresAt ? maximumExpiresAt : normalExpiresAt;
    await this.store.createSession({
      ...identity,
      tokenHash: hashOpaqueToken(token),
      csrfSecretHash: hashOpaqueToken(csrfToken),
      expiresAt,
    });
    return {
      userId: identity.userId,
      workspaceId: identity.workspaceId,
      role: identity.role,
      token,
      csrfToken,
      expiresAt,
    };
  }

  async logout(workspaceId: string, token: string): Promise<void> {
    await this.store.revokeSession(workspaceId, hashOpaqueToken(token));
  }

  async updateWorkspace(
    identity: AuthIdentity,
    input: { name: string; slug: string; timezone?: string },
  ): Promise<{ id: string; name: string; slug: string; timezone: string }> {
    requireWorkspaceAction(identity.role, 'workspace:manage');
    return this.store.updateWorkspace(identity.workspaceId, identity.userId, {
      name: input.name.trim(),
      slug: input.slug.trim().toLowerCase(),
    });
  }

  async getWorkspace(
    identity: AuthIdentity,
  ): Promise<{ id: string; name: string; slug: string } | null> {
    return this.store.findWorkspace(identity.workspaceId, identity.userId);
  }

  async getShellProfile(identity: AuthIdentity): Promise<ShellProfile | null> {
    return this.store.findShellProfile(identity.workspaceId, identity.userId);
  }

  async listWorkspaces(identity: AuthIdentity): Promise<WorkspaceSummary[]> {
    return this.store.listWorkspaces(identity.userId);
  }

  async createWorkspace(identity: AuthIdentity, name: string): Promise<WorkspaceSummary> {
    const existing = await this.store.listWorkspaces(identity.userId);
    if (existing.length >= MAX_WORKSPACES_PER_USER)
      throw new Error(`A user can belong to at most ${String(MAX_WORKSPACES_PER_USER)} workspaces`);
    return this.store.createWorkspace(identity.userId, name.trim(), existing.length);
  }

  async reorderWorkspaces(identity: AuthIdentity, workspaceIds: string[]): Promise<void> {
    if (workspaceIds.length > MAX_WORKSPACES_PER_USER)
      throw new Error(
        `Workspace order cannot exceed ${String(MAX_WORKSPACES_PER_USER)} workspaces`,
      );
    const existing = await this.store.listWorkspaces(identity.userId);
    const expected = new Set(existing.map((workspace) => workspace.id));
    if (workspaceIds.length !== expected.size || new Set(workspaceIds).size !== expected.size)
      throw new Error('Workspace order must include every workspace exactly once');
    if (workspaceIds.some((workspaceId) => !expected.has(workspaceId)))
      throw new Error('Workspace order contains an unknown workspace');
    await this.store.reorderWorkspaces(identity.userId, workspaceIds);
  }

  async deleteWorkspace(
    identity: AuthIdentity,
    targetWorkspaceId: string,
    confirmedName: string,
  ): Promise<string | null> {
    if (targetWorkspaceId === identity.workspaceId)
      return 'Switch away before deleting this workspace';
    const existing = await this.store.listWorkspaces(identity.userId);
    if (existing.length <= 1) return 'The last workspace cannot be deleted';
    return this.store.deleteWorkspace({
      userId: identity.userId,
      currentWorkspaceId: identity.workspaceId,
      targetWorkspaceId,
      confirmedName,
    });
  }

  async switchWorkspace(
    identity: AuthIdentity,
    currentToken: string,
    targetWorkspaceId: string,
    now = new Date(),
  ): Promise<(SessionResult & { slug: string }) | null> {
    const token = createOpaqueToken();
    const csrfToken = createOpaqueToken();
    const expiresAt = new Date(now.getTime() + this.sessionLifetimeMs);
    const target = await this.store.rotateWorkspaceSession({
      currentWorkspaceId: identity.workspaceId,
      currentTokenHash: hashOpaqueToken(currentToken),
      targetWorkspaceId,
      userId: identity.userId,
      tokenHash: hashOpaqueToken(token),
      csrfSecretHash: hashOpaqueToken(csrfToken),
      expiresAt,
    });
    return target ? { ...target, token, csrfToken, expiresAt } : null;
  }

  async authenticate(
    workspaceId: string,
    token: string,
    now = new Date(),
  ): Promise<AuthIdentity | null> {
    const session = await this.store.findSession(workspaceId, hashOpaqueToken(token));
    if (!session || session.revokedAt || session.expiresAt <= now) return null;
    const role = await this.store.findCurrentRole(session.userId, session.workspaceId);
    return role ? { userId: session.userId, workspaceId: session.workspaceId, role } : null;
  }
}

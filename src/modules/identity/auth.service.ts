import { createOpaqueToken, hashOpaqueToken } from './session.js';
import { hashPassword, verifyPassword } from './password.js';
import { requireWorkspaceAction, type MembershipRole } from './authorization.js';

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
  updateWorkspace: (
    workspaceId: string,
    userId: string,
    input: { name: string; slug: string },
  ) => Promise<{ id: string; name: string; slug: string }>;
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

  private async issueSession(identity: AuthIdentity, now: Date): Promise<SessionResult> {
    const token = createOpaqueToken();
    const csrfToken = createOpaqueToken();
    const expiresAt = new Date(now.getTime() + this.sessionLifetimeMs);
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
    input: { name: string; slug: string },
  ): Promise<{ id: string; name: string; slug: string }> {
    requireWorkspaceAction(identity.role, 'workspace:manage');
    return this.store.updateWorkspace(identity.workspaceId, identity.userId, {
      name: input.name.trim(),
      slug: input.slug.trim().toLowerCase(),
    });
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

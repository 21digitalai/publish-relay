export type MembershipRole = 'owner' | 'admin' | 'editor' | 'viewer';
export type WorkspaceAction =
  'workspace:manage' | 'content:read' | 'content:write' | 'publish:manage';

const ALLOWED_ACTIONS: Record<MembershipRole, ReadonlySet<WorkspaceAction>> = {
  owner: new Set(['workspace:manage', 'content:read', 'content:write', 'publish:manage']),
  admin: new Set(['workspace:manage', 'content:read', 'content:write', 'publish:manage']),
  editor: new Set(['content:read', 'content:write', 'publish:manage']),
  viewer: new Set(['content:read']),
};

export function canPerformWorkspaceAction(role: MembershipRole, action: WorkspaceAction): boolean {
  return ALLOWED_ACTIONS[role].has(action);
}

export class WorkspaceAuthorizationError extends Error {}

export function requireWorkspaceAction(role: MembershipRole, action: WorkspaceAction): void {
  if (!canPerformWorkspaceAction(role, action))
    throw new WorkspaceAuthorizationError(`Role ${role} cannot perform ${action}`);
}

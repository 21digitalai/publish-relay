import { describe, expect, it, vi } from 'vitest';

import { hashPassword } from '../src/modules/identity/password.js';
import {
  AuthService,
  MAX_WORKSPACES_PER_USER,
  type AuthStore,
} from '../src/modules/identity/auth.service.js';

function createStore(): AuthStore {
  return {
    register: vi.fn(),
    findLogin: vi.fn(),
    createSession: vi.fn(),
    revokeSessionsForUser: vi.fn(),
    revokeSession: vi.fn(),
    findSession: vi.fn(),
    findCurrentRole: vi.fn(),
    findShellProfile: vi.fn(),
    findWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    listWorkspaces: vi.fn(),
    createWorkspace: vi.fn(),
    reorderWorkspaces: vi.fn(),
    rotateWorkspaceSession: vi.fn(),
  };
}

describe('AuthService', () => {
  it('establishes the initial session during atomic account registration', async () => {
    const store = createStore();
    vi.mocked(store.register).mockResolvedValue({ userId: 'u1', workspaceId: 'w1', role: 'owner' });
    const result = await new AuthService(store).register(
      ' Relay Owner ',
      'OWNER@EXAMPLE.TEST',
      'long-password',
      'Relay',
    );
    expect(store.register).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Relay Owner', email: 'owner@example.test' }),
    );
    expect(store.createSession).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ userId: 'u1', workspaceId: 'w1', role: 'owner' });
  });

  it('rotates all existing sessions on login to prevent fixation', async () => {
    const store = createStore();
    vi.mocked(store.findLogin).mockResolvedValue({
      userId: 'u1',
      workspaceId: 'w1',
      role: 'owner',
      passwordHash: await hashPassword('password'),
    });
    const result = await new AuthService(store, 1_000).login(
      'OWNER@EXAMPLE.TEST',
      'password',
      new Date(0),
    );
    expect(store.findLogin).toHaveBeenCalledWith('owner@example.test');
    expect(store.revokeSessionsForUser).toHaveBeenCalledWith('w1', 'u1');
    expect(result?.expiresAt).toEqual(new Date(1_000));
    expect(result?.token).toBeTruthy();
  });

  it('revokes logout by the hashed token', async () => {
    const store = createStore();
    await new AuthService(store).logout('w1', 'raw-token');
    expect(store.revokeSession).toHaveBeenCalledWith('w1', expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(store.revokeSession).not.toHaveBeenCalledWith('raw-token');
  });

  it('rejects expired sessions and observes current role changes', async () => {
    const store = createStore();
    vi.mocked(store.findSession).mockResolvedValue({
      userId: 'u1',
      workspaceId: 'w1',
      role: 'owner',
      expiresAt: new Date(100),
      revokedAt: null,
    });
    expect(await new AuthService(store).authenticate('w1', 'token', new Date(100))).toBeNull();
    vi.mocked(store.findSession).mockResolvedValue({
      userId: 'u1',
      workspaceId: 'w1',
      role: 'owner',
      expiresAt: new Date(200),
      revokedAt: null,
    });
    vi.mocked(store.findCurrentRole).mockResolvedValue('viewer');
    expect(await new AuthService(store).authenticate('w1', 'token', new Date(100))).toEqual({
      userId: 'u1',
      workspaceId: 'w1',
      role: 'viewer',
    });
  });

  it('rotates only the current session into an authorized target workspace', async () => {
    const store = createStore();
    vi.mocked(store.rotateWorkspaceSession).mockResolvedValue({
      userId: 'u1',
      workspaceId: 'w2',
      role: 'editor',
      slug: 'second-workspace',
    });
    const result = await new AuthService(store, 1_000).switchWorkspace(
      { userId: 'u1', workspaceId: 'w1', role: 'owner' },
      'current-token',
      'w2',
      new Date(0),
    );
    expect(store.rotateWorkspaceSession).toHaveBeenCalledWith(
      expect.objectContaining({
        currentWorkspaceId: 'w1',
        targetWorkspaceId: 'w2',
        userId: 'u1',
        expiresAt: new Date(1_000),
      }),
    );
    expect(result).toMatchObject({ workspaceId: 'w2', slug: 'second-workspace', role: 'editor' });
  });

  it('creates at the end and accepts only an exact workspace reorder', async () => {
    const store = createStore();
    const identity = { userId: 'u1', workspaceId: 'w1', role: 'owner' as const };
    const existing = [
      { id: 'w1', slug: 'one', name: 'One', role: 'owner' as const, position: 0 },
      { id: 'w2', slug: 'two', name: 'Two', role: 'editor' as const, position: 1 },
    ];
    vi.mocked(store.listWorkspaces).mockResolvedValue(existing);
    vi.mocked(store.createWorkspace).mockResolvedValue({
      id: 'w3',
      slug: 'three',
      name: 'Three',
      role: 'owner',
      position: 2,
    });
    const service = new AuthService(store);

    await expect(service.createWorkspace(identity, ' Three ')).resolves.toMatchObject({ id: 'w3' });
    expect(store.createWorkspace).toHaveBeenCalledWith('u1', 'Three', 2);
    await expect(service.reorderWorkspaces(identity, ['w2', 'w1'])).resolves.toBeUndefined();
    expect(store.reorderWorkspaces).toHaveBeenCalledWith('u1', ['w2', 'w1']);
    await expect(service.reorderWorkspaces(identity, ['w1', 'w1'])).rejects.toThrow(/exactly once/);
    await expect(service.reorderWorkspaces(identity, ['w1', 'w3'])).rejects.toThrow(/unknown/);

    vi.mocked(store.listWorkspaces).mockResolvedValue(
      Array.from({ length: MAX_WORKSPACES_PER_USER }, (_, position) => ({
        id: `w${String(position)}`,
        slug: `workspace-${String(position)}`,
        name: `Workspace ${String(position)}`,
        role: 'owner' as const,
        position,
      })),
    );
    await expect(service.createWorkspace(identity, 'Overflow')).rejects.toThrow(/at most 100/);
    expect(store.createWorkspace).toHaveBeenCalledTimes(1);
  });
});

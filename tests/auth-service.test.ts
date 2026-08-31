import { describe, expect, it, vi } from 'vitest';

import { hashPassword } from '../src/modules/identity/password.js';
import { AuthService, type AuthStore } from '../src/modules/identity/auth.service.js';

function createStore(): AuthStore {
  return {
    register: vi.fn(),
    findLogin: vi.fn(),
    createSession: vi.fn(),
    revokeSessionsForUser: vi.fn(),
    revokeSession: vi.fn(),
    findSession: vi.fn(),
    findCurrentRole: vi.fn(),
  };
}

describe('AuthService', () => {
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
});

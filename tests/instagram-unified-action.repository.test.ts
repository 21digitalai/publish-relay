import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tenant: vi.fn(),
  insert: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../src/database/tenant-transaction.js', () => ({
  withTenantTransaction: mocks.tenant,
}));

import {
  reserveInstagramUnifiedAction,
  settleInstagramUnifiedAction,
} from '../src/modules/providers/instagram-unified-action.repository.js';

const input = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  clientActionId: '00000000-0000-4000-8000-000000000003',
  kind: 'comment_reply' as const,
  targetId: 'comment-1',
  parentId: 'media-1',
  text: 'Hello',
  requestFingerprint: 'fingerprint-1',
  actor: { type: 'user' as const, id: '00000000-0000-4000-8000-000000000004' },
};

function tx() {
  return {
    insert: mocks.insert,
    select: mocks.select,
    update: mocks.update,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenant.mockImplementation(
    (_database: unknown, _scope: unknown, callback: (transaction: unknown) => unknown) =>
      callback(tx()),
  );
});

describe('Instagram Unified action ledger', () => {
  it('reserves a tenant-scoped action before dispatch', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'reservation-1' }]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    mocks.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoNothing }) });

    await expect(reserveInstagramUnifiedAction({} as never, input)).resolves.toEqual({
      kind: 'new',
      id: 'reservation-1',
    });
    expect(mocks.tenant).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ workspaceId: input.workspaceId }),
      expect.any(Function),
    );
  });

  it('returns unknown for reserved or ambiguous replay and never authorizes a resend', async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    mocks.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoNothing }) });
    const limit = vi.fn().mockResolvedValue([
      {
        accountId: input.accountId,
        kind: input.kind,
        targetId: input.targetId,
        parentId: input.parentId,
        requestFingerprint: input.requestFingerprint,
        state: 'reserved',
        providerReceipt: null,
        failureStatus: null,
      },
    ]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    mocks.select.mockReturnValue({ from });

    await expect(reserveInstagramUnifiedAction({} as never, input)).resolves.toEqual({
      kind: 'existing',
      outcome: { state: 'unknown' },
    });
  });

  it('returns conflict when an action ID is reused with another target or payload', async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    mocks.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoNothing }) });
    const limit = vi.fn().mockResolvedValue([
      {
        accountId: input.accountId,
        kind: input.kind,
        targetId: 'different-comment',
        parentId: input.parentId,
        requestFingerprint: input.requestFingerprint,
        state: 'confirmed',
        providerReceipt: 'receipt-1',
        failureStatus: null,
      },
    ]);
    mocks.select.mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit }) }),
    });

    await expect(reserveInstagramUnifiedAction({} as never, input)).resolves.toEqual({
      kind: 'conflict',
    });
  });

  it('settles only the still-reserved row with the bounded provider outcome', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'reservation-1' }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    mocks.update.mockReturnValue({ set });

    await expect(
      settleInstagramUnifiedAction({} as never, {
        ...input,
        reservationId: 'reservation-1',
        outcome: { state: 'unknown' },
      }),
    ).resolves.toBeUndefined();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ state: 'unknown' }));
    expect(mocks.tenant).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ workspaceId: input.workspaceId }),
      expect.any(Function),
    );
  });
});

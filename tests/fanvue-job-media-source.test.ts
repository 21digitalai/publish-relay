import { Readable } from 'node:stream';

import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fanvueJobMediaWhere,
  openFanvueJobMediaRange,
} from '../src/modules/providers/fanvue-job-media-source.js';

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('../src/database/tenant-transaction.js', () => ({
  withTenantTransaction: mocks.transaction,
}));

const input = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  jobId: '00000000-0000-4000-8000-000000000002',
  mediaId: '00000000-0000-4000-8000-000000000003',
  leaseOwner: 'worker-one',
  start: 6,
};

afterEach(() => vi.clearAllMocks());

describe('Fanvue job-owned verified media range', () => {
  it('requires an unexpired exact worker lease in the tenant SQL predicate', () => {
    const now = new Date('2026-10-25T09:00:00.000Z');
    const condition = fanvueJobMediaWhere(input, now);
    if (!condition) throw new Error('Missing Fanvue media predicate');
    const query = new PgDialect().sqlToQuery(condition);
    expect(query.sql).toContain('"publication_jobs"."lease_expires_at" >');
    expect(query.sql).toContain('"publication_jobs"."lease_owner" =');
    expect(query.sql).toContain('"publication_jobs"."workspace_id" =');
    expect(query.params.map(String)).toContain(now.toISOString());
    expect(query.params).toContain(input.leaseOwner);
    expect(query.params).toContain(input.workspaceId);
  });

  it('opens one hash-verified range from the durable offset without loading the whole file', async () => {
    mocks.transaction.mockResolvedValue({
      storageKey: 'owned/media',
      sha256: 'hash',
      byteSize: 13,
      mimeType: 'video/mp4',
    });
    const stream = Readable.from(['ghijklm']);
    const openVerifiedRange = vi.fn().mockResolvedValue(stream);
    await expect(
      openFanvueJobMediaRange({} as never, { openVerifiedRange } as never, input),
    ).resolves.toEqual({ stream, byteSize: 13, mimeType: 'video/mp4' });
    expect(openVerifiedRange).toHaveBeenCalledExactlyOnceWith({
      storageKey: 'owned/media',
      sha256: 'hash',
      byteSize: 13,
      start: 6,
      end: 12,
    });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.anything(), input, expect.any(Function));
  });

  it('fails closed on a missing tenant/job/media row or failed hash verification', async () => {
    const openVerifiedRange = vi.fn().mockResolvedValue(null);
    mocks.transaction.mockResolvedValue(null);
    await expect(
      openFanvueJobMediaRange({} as never, { openVerifiedRange } as never, input),
    ).rejects.toThrow('unavailable');
    expect(openVerifiedRange).not.toHaveBeenCalled();
    mocks.transaction.mockResolvedValue({
      storageKey: 'owned/media',
      sha256: 'hash',
      byteSize: 13,
      mimeType: 'video/mp4',
    });
    await expect(
      openFanvueJobMediaRange({} as never, { openVerifiedRange } as never, input),
    ).rejects.toThrow('verification');
  });
});

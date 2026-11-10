import { beforeEach, describe, expect, it, vi } from 'vitest';

const ledger = vi.hoisted(() => ({ reserve: vi.fn(), settle: vi.fn() }));
const policy = vi.hoisted(() => ({ enforce: vi.fn(() => Promise.resolve()) }));
vi.mock('../src/database/tenant-transaction.js', () => ({
  withTenantTransaction: (_db: unknown, _input: unknown, work: (transaction: unknown) => unknown) =>
    work({}),
}));
vi.mock('../src/modules/policy/action-policy.js', () => ({
  enforceWorkspaceAction: policy.enforce,
}));
vi.mock('../src/modules/providers/fanvue-action-intent.repository.js', () => ({
  reserveFanvueAction: ledger.reserve,
  settleFanvueAction: ledger.settle,
}));

import { FanvueCommentService } from '../src/modules/providers/fanvue-comment.service.js';
import { FanvueRequestError } from '../src/modules/providers/fanvue-http-client.js';

const input = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  postUuid: '00000000-0000-4000-8000-000000000003',
  clientActionId: '00000000-0000-4000-8000-000000000004',
  text: 'Thanks',
  actor: { type: 'api-key' as const, id: '00000000-0000-4000-8000-000000000007' },
};
const commentUuid = '00000000-0000-4000-8000-000000000005';
const events: string[] = [];
const reads = {
  getOwnedPostForComment: vi.fn(() => {
    events.push('preflight');
    return Promise.resolve({ accessToken: 'token', post: {} });
  }),
};
const client = {
  createComment: vi.fn(() => {
    events.push('send');
    return Promise.resolve({ uuid: commentUuid });
  }),
};
const service = new FanvueCommentService({} as never, reads as never, client as never, {} as never);

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  ledger.reserve.mockImplementation(() => {
    events.push('reserve');
    return Promise.resolve({ kind: 'new', id: '00000000-0000-4000-8000-000000000006' });
  });
  ledger.settle.mockImplementation(() => {
    events.push('settle');
    return Promise.resolve();
  });
});

describe('Fanvue creator-owned top-level comment command', () => {
  it('preflights the selected account before durable reservation and one POST', async () => {
    await expect(service.send(input)).resolves.toEqual({ state: 'confirmed', commentUuid });
    expect(events).toEqual(['preflight', 'reserve', 'send', 'settle']);
    expect(policy.enforce).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'engagement.send', actor: input.actor }),
    );
    expect(reads.getOwnedPostForComment).toHaveBeenCalledWith(input);
    expect(client.createComment).toHaveBeenCalledWith('token', input.postUuid, input.text);
    expect(ledger.reserve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ textBody: input.text }),
    );
    expect(ledger.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        result: { state: 'confirmed', providerObjectUuid: commentUuid },
      }),
    );
  });

  it('retains a bounded owned-post excerpt as the comment target', async () => {
    reads.getOwnedPostForComment.mockResolvedValueOnce({
      accessToken: 'token',
      post: { text: 'Creator post about the new collection' },
    });
    await service.send(input);
    expect(ledger.reserve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetLabel: 'Creator post about the new collection' }),
    );
  });

  it('labels a textless owned media post with its verified post date', async () => {
    reads.getOwnedPostForComment.mockResolvedValueOnce({
      accessToken: 'token',
      post: { text: null, createdAt: '2026-11-05T09:00:00Z', mediaUuids: [input.postUuid] },
    });
    await service.send(input);
    expect(ledger.reserve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetLabel: 'Media post · 2026-11-05' }),
    );
  });

  it('does not reserve or send when account ownership or write scope fails', async () => {
    reads.getOwnedPostForComment.mockRejectedValueOnce(new Error('scope missing'));
    await expect(service.send(input)).rejects.toThrow('scope missing');
    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(client.createComment).not.toHaveBeenCalled();
  });

  it('does not reserve or send when the neutral action policy denies the mutation', async () => {
    policy.enforce.mockRejectedValueOnce(new Error('policy denied'));
    await expect(service.send(input)).rejects.toThrow('policy denied');
    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(client.createComment).not.toHaveBeenCalled();
  });

  it('never resends an existing action, including ambiguous and confirmed outcomes', async () => {
    for (const [state, providerObjectUuid] of [
      ['reserved', null],
      ['unknown', null],
      ['confirmed', commentUuid],
    ] as const) {
      ledger.reserve.mockResolvedValueOnce({
        kind: 'existing',
        state,
        providerObjectUuid,
        failureStatus: null,
      });
      const result = await service.send(input);
      expect(result.state).toBe(state === 'confirmed' ? 'confirmed' : 'unknown');
    }
    expect(client.createComment).not.toHaveBeenCalled();
    expect(ledger.settle).not.toHaveBeenCalled();
  });

  it('rejects a changed request under the same action ID', async () => {
    ledger.reserve.mockResolvedValueOnce({ kind: 'conflict' });
    await expect(service.send(input)).rejects.toThrow('conflicts');
    expect(client.createComment).not.toHaveBeenCalled();
  });

  it.each([400, 403, 429])('persists definite provider HTTP %i as failed', async (status) => {
    client.createComment.mockRejectedValueOnce(new FanvueRequestError(status));
    await expect(service.send(input)).resolves.toEqual({ state: 'failed', failureStatus: status });
    expect(ledger.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: { state: 'failed', failureStatus: status } }),
    );
  });

  it('persists a transport timeout as unknown and never retries it', async () => {
    client.createComment.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.send(input)).resolves.toEqual({ state: 'unknown' });
    expect(ledger.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: { state: 'unknown' } }),
    );
    expect(client.createComment).toHaveBeenCalledTimes(1);
  });
});

/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-non-null-assertion, @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from 'vitest';

import {
  DAILY_VIBER_REMEDIATION,
  LIVE_CONFIRMATION,
  dryRunDailyViberRemediation,
  executeDailyViberCanary,
  type RemediationJournal,
  type RemediationSource,
  type XRemediationGateway,
} from '../src/modules/providers/x-remediation.service.js';

function source(jobId: string, externalPostId: string): RemediationSource {
  return {
    jobId,
    attemptId: `attempt-${jobId}`,
    externalPostId,
    revisionId: `revision-${jobId}`,
    text: `Exact source text for ${jobId}`,
    media: [{ id: `media-${jobId}`, sha256: 'a'.repeat(64) }],
  };
}

function gateway(): XRemediationGateway & { journal: RemediationJournal | null } {
  const value = {
    journal: null as RemediationJournal | null,
    loadSource: vi.fn(async (jobId, externalPostId) => source(jobId, externalPostId)),
    lookup: vi.fn(async (id) => ({ id, username: 'TheDailyViber' })),
    readJournal: vi.fn(async () => value.journal),
    assertMediaReady: vi.fn(async () => undefined),
    prepareJournal: vi.fn(async (journal) => (value.journal = journal)),
    markDeleteStarted: vi.fn(
      async () => (value.journal = { ...value.journal!, phase: 'delete_started' }),
    ),
    markDeleted: vi.fn(async () => (value.journal = { ...value.journal!, phase: 'deleted' })),
    deletePost: vi.fn(async () => undefined),
    prepareReplacement: vi.fn(
      async () => (value.journal = { ...value.journal!, replacementJobId: 'replacement-job' }),
    ),
    publishReplacement: vi.fn(async (_source, jobId) => ({
      jobId,
      attemptId: 'replacement-attempt',
      externalPostId: 'replacement-post',
      externalUrl: 'https://x.com/TheDailyViber/status/replacement-post',
    })),
    markReplacementStarted: vi.fn(
      async () => (value.journal = { ...value.journal!, phase: 'replacement_started' }),
    ),
    markReplaced: vi.fn(
      async (_jobId, replacement) =>
        (value.journal = {
          ...value.journal!,
          phase: 'replaced',
          replacementJobId: replacement.jobId,
          replacementAttemptId: replacement.attemptId,
          replacementExternalPostId: replacement.externalPostId,
          replacementExternalUrl: replacement.externalUrl,
        }),
    ),
    markVerified: vi.fn(async () => (value.journal = { ...value.journal!, phase: 'verified' })),
  };
  return value;
}

describe('Daily Viber X remediation', () => {
  it('dry-runs the exact five allowlisted source revisions and posts', async () => {
    const target = gateway();
    const result = await dryRunDailyViberRemediation(target);
    expect(result).toHaveLength(5);
    expect(target.loadSource).toHaveBeenCalledTimes(5);
    expect(
      result.every((item) => item.source.text.length > 0 && item.source.media.length === 1),
    ).toBe(true);
  });

  it('journals before delete and resumes after a partial failure without another delete', async () => {
    const target = gateway();
    const first = DAILY_VIBER_REMEDIATION[0];
    await expect(
      executeDailyViberCanary(target, {
        confirmation: LIVE_CONFIRMATION,
        jobId: first[0],
        externalPostId: first[1],
      }),
    ).rejects.toThrow('Deleted X post still resolves');
    expect(vi.mocked(target.prepareJournal).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(target.deletePost).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(target.deletePost)).toHaveBeenCalledTimes(1);
    target.lookup = vi.fn(async (id) =>
      id === first[1] ? null : { id, username: 'TheDailyViber' },
    );
    await expect(
      executeDailyViberCanary(target, {
        confirmation: LIVE_CONFIRMATION,
        jobId: first[0],
        externalPostId: first[1],
      }),
    ).resolves.toMatchObject({ phase: 'verified', replacementExternalPostId: 'replacement-post' });
    expect(vi.mocked(target.deletePost)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(target.publishReplacement)).toHaveBeenCalledTimes(1);
  });

  it('requires every preceding allowlisted item to be verified', async () => {
    const target = gateway();
    const second = DAILY_VIBER_REMEDIATION[1];
    await expect(
      executeDailyViberCanary(target, {
        confirmation: LIVE_CONFIRMATION,
        jobId: second[0],
        externalPostId: second[1],
      }),
    ).rejects.toThrow('is not verified');
    target.readJournal = vi.fn(async (jobId) =>
      jobId === DAILY_VIBER_REMEDIATION[0][0]
        ? ({ ...source(jobId, DAILY_VIBER_REMEDIATION[0][1]), phase: 'verified' } as never)
        : target.journal,
    );
    await expect(
      executeDailyViberCanary(target, {
        confirmation: LIVE_CONFIRMATION,
        jobId: second[0],
        externalPostId: second[1],
      }),
    ).rejects.toThrow('Deleted X post still resolves');
    await expect(
      executeDailyViberCanary(target, {
        confirmation: 'wrong',
        jobId: DAILY_VIBER_REMEDIATION[0][0],
        externalPostId: DAILY_VIBER_REMEDIATION[0][1],
      }),
    ).rejects.toThrow('confirmation');
  });

  it.each(['Scheduled media is unavailable', 'Media content hash mismatch'])(
    'fails before deletion when retained media validation reports: %s',
    async (failure) => {
      const target = gateway();
      const first = DAILY_VIBER_REMEDIATION[0];
      target.assertMediaReady = vi.fn(async () => {
        throw new Error(failure);
      });
      await expect(
        executeDailyViberCanary(target, {
          confirmation: LIVE_CONFIRMATION,
          jobId: first[0],
          externalPostId: first[1],
        }),
      ).rejects.toThrow(failure);
      expect(target.markDeleteStarted).not.toHaveBeenCalled();
      expect(target.deletePost).not.toHaveBeenCalled();
    },
  );

  it('reuses the durably prepared replacement after an uncertain dispatch', async () => {
    const target = gateway();
    const first = DAILY_VIBER_REMEDIATION[0];
    let sourceLookupCount = 0;
    target.lookup = vi.fn(async (id) => {
      if (id !== first[1]) return { id, username: 'TheDailyViber' };
      sourceLookupCount += 1;
      return sourceLookupCount === 1 ? { id, username: 'TheDailyViber' } : null;
    });
    let dispatches = 0;
    target.publishReplacement = vi.fn(async (_source, jobId) => {
      dispatches += 1;
      if (dispatches === 1) throw new Error('crash after replacement job creation');
      return {
        jobId,
        attemptId: 'replacement-attempt',
        externalPostId: 'replacement-post',
        externalUrl: 'https://x.com/TheDailyViber/status/replacement-post',
      };
    });
    await expect(
      executeDailyViberCanary(target, {
        confirmation: LIVE_CONFIRMATION,
        jobId: first[0],
        externalPostId: first[1],
      }),
    ).rejects.toThrow('crash after replacement job creation');
    await expect(
      executeDailyViberCanary(target, {
        confirmation: LIVE_CONFIRMATION,
        jobId: first[0],
        externalPostId: first[1],
      }),
    ).resolves.toMatchObject({ phase: 'verified', replacementJobId: 'replacement-job' });
    expect(target.prepareReplacement).toHaveBeenCalledTimes(1);
    expect(target.publishReplacement).toHaveBeenCalledTimes(2);
    expect(vi.mocked(target.publishReplacement).mock.calls[1]?.[1]).toBe('replacement-job');
  });
});

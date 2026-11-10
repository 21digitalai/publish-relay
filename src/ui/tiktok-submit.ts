import type { TikTokSubmission } from './tiktok-composer.js';

export interface TikTokAttempt {
  form: string;
  files: File[];
  submission: string;
  scheduledAt: string;
  approvalRequired: boolean;
  draftKey: string;
  consentKey: string;
  scheduleKey: string;
  mediaId: string | null;
  postId: string | null;
  revisionId: string | null;
  receiptId: string | null;
  reviseKey: string;
  recovered: boolean;
}

export class TikTokRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }

  get deterministic(): boolean {
    return [400, 401, 403, 404, 409, 422].includes(this.status);
  }
}

export interface PreparedTikTokDraft {
  postId: string;
  revisionId: string;
  captionPreview?: string;
  content?: { caption: string; mediaId: string; options: TikTokSubmission['options'] };
  createdAt: string;
  media: {
    id: string;
    mimeType: string;
    byteSize: number;
    durationMs: number | null;
    ready: boolean;
    previewUrl: string | null;
  };
}

export async function readPreparedTikTokDrafts(
  before?: Pick<PreparedTikTokDraft, 'createdAt' | 'postId'>,
): Promise<PreparedTikTokDraft[]> {
  const query = new URLSearchParams({ limit: '20' });
  if (before) {
    query.set('before', before.createdAt);
    query.set('beforeId', before.postId);
  }
  const response = await fetch(`/api/workflow/tiktok-drafts?${query.toString()}`, {
    cache: 'no-store',
  });
  const envelope = (await response.json()) as { data?: PreparedTikTokDraft[]; error?: string };
  if (!response.ok || !envelope.data)
    throw new Error(envelope.error ?? 'Prepared TikTok posts could not be loaded.');
  return envelope.data;
}

export async function readPreparedTikTokDraft(postId: string): Promise<PreparedTikTokDraft> {
  const response = await fetch(`/api/workflow/tiktok-drafts/${postId}`, { cache: 'no-store' });
  const envelope = (await response.json()) as { data?: PreparedTikTokDraft; error?: string };
  if (!response.ok || !envelope.data)
    throw new Error(envelope.error ?? 'Prepared TikTok post could not be loaded.');
  return envelope.data;
}

export function createTikTokAttempt(input: {
  form: string;
  files: File[];
  submission: TikTokSubmission;
  scheduledAt: string;
  approvalRequired: boolean;
}): TikTokAttempt {
  return {
    form: input.form,
    files: [...input.files],
    submission: JSON.stringify(input.submission),
    scheduledAt: input.scheduledAt,
    approvalRequired: input.approvalRequired,
    draftKey: crypto.randomUUID(),
    consentKey: crypto.randomUUID(),
    scheduleKey: crypto.randomUUID(),
    mediaId: null,
    postId: null,
    revisionId: null,
    receiptId: null,
    reviseKey: crypto.randomUUID(),
    recovered: false,
  };
}

export function tikTokAttemptMatches(
  attempt: TikTokAttempt,
  form: string,
  files: File[],
  current: TikTokSubmission | null,
  approvalRequired: boolean,
): boolean {
  if (
    !current ||
    attempt.form !== form ||
    attempt.approvalRequired !== approvalRequired ||
    attempt.files.length !== files.length
  )
    return false;
  if (attempt.files.some((file, index) => file !== files[index])) return false;
  const original = JSON.parse(attempt.submission) as TikTokSubmission;
  return JSON.stringify(tikTokChoice(original)) === JSON.stringify(tikTokChoice(current));
}

function tikTokChoice(submission: TikTokSubmission) {
  return {
    capabilitySnapshotId: submission.capabilitySnapshotId,
    options: submission.options,
    musicUsageConfirmed: submission.musicUsageConfirmed,
    brandedContentPolicyConfirmed: submission.brandedContentPolicyConfirmed,
  };
}

async function postTikTok<T>(
  path: string,
  payload: unknown,
  csrfToken: string,
  key?: string,
  method: 'POST' | 'PATCH' = 'POST',
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: JSON.stringify(payload),
  });
  const envelope = (await response.json()) as { data?: T; error?: string | null };
  if (!response.ok || !envelope.data)
    throw new TikTokRequestError(
      envelope.error ?? 'TikTok request could not be completed.',
      response.status,
    );
  return envelope.data;
}

export async function submitTikTokAttempt(input: {
  attempt: TikTokAttempt;
  accountId: string;
  caption: string;
  csrfToken: string;
  resolveMediaId: () => Promise<string>;
}): Promise<void> {
  const { attempt, accountId, caption, csrfToken } = input;
  const submission = JSON.parse(attempt.submission) as TikTokSubmission;
  if (!submission.capabilitySnapshotId) throw new Error('TikTok options are unavailable.');
  attempt.mediaId ??= await input.resolveMediaId();
  if (!attempt.postId || !attempt.revisionId) {
    const draft = await postTikTok<{ postId: string; revisionId: string }>(
      '/api/workflow/tiktok-drafts',
      {
        accountId,
        content: {
          schemaVersion: 1,
          kind: 'video',
          caption,
          mediaId: attempt.mediaId,
          options: submission.options,
        },
      },
      csrfToken,
      attempt.draftKey,
    );
    attempt.postId = draft.postId;
    attempt.revisionId = draft.revisionId;
  }
  if (attempt.recovered) {
    const revision = await postTikTok<{ postId: string; revisionId: string }>(
      `/api/workflow/tiktok-drafts/${attempt.postId}`,
      {
        content: {
          schemaVersion: 1,
          kind: 'video',
          caption,
          mediaId: attempt.mediaId,
          options: submission.options,
        },
      },
      csrfToken,
      attempt.reviseKey,
      'PATCH',
    );
    attempt.revisionId = revision.revisionId;
    attempt.recovered = false;
  }
  if (!attempt.receiptId) {
    const consent = await postTikTok<{ id: string }>(
      '/api/workflow/tiktok-consents',
      {
        postId: attempt.postId,
        revisionId: attempt.revisionId,
        accountId,
        capabilitySnapshotId: submission.capabilitySnapshotId,
        options: submission.options,
        musicUsageConfirmed: submission.musicUsageConfirmed,
        brandedContentPolicyConfirmed: submission.brandedContentPolicyConfirmed,
      },
      csrfToken,
      attempt.consentKey,
    );
    attempt.receiptId = consent.id;
  }
  await postTikTok<{ jobId: string }>(
    '/api/workflow/tiktok-schedules',
    {
      postId: attempt.postId,
      revisionId: attempt.revisionId,
      accountId,
      receiptId: attempt.receiptId,
      scheduledAt: attempt.scheduledAt,
      approvalRequired: attempt.approvalRequired,
    },
    csrfToken,
    attempt.scheduleKey,
  );
}

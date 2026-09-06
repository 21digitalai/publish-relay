import { createHash } from 'node:crypto';

export const DAILY_VIBER_REMEDIATION = [
  ['de481574-1d94-459b-9e89-d7faf3ec4d2b', '2095509881344176536'],
  ['5f6f94b4-468c-4c4b-a5c2-a045e487905c', '2095584875474555253'],
  ['c5f63db2-e1c9-444f-a4d7-6e4368982ccd', '2095859938752934044'],
  ['5e6b0dd1-7583-4f31-b367-ec06cc4f0479', '2095937958993866895'],
  ['02b11f8e-20f1-419c-9197-705b9c96706a', '2096232137796047241'],
] as const;

export const LIVE_CONFIRMATION = 'REMEDIATE-DAILY-VIBER-9807';

export interface RemediationSource {
  jobId: string;
  attemptId: string;
  externalPostId: string;
  revisionId: string;
  text: string;
  media: readonly { id: string; sha256: string }[];
  providerAccountId?: string;
  createdByUserId?: string;
}

export interface RemediationJournal {
  phase:
    'prepared' | 'delete_started' | 'deleted' | 'replacement_started' | 'replaced' | 'verified';
  source: RemediationSource;
  contentHash: string;
  replacementJobId?: string;
  replacementAttemptId?: string;
  replacementExternalPostId?: string;
  replacementExternalUrl?: string;
}

export interface XRemediationGateway {
  loadSource(jobId: string, externalPostId: string): Promise<RemediationSource>;
  lookup(externalPostId: string): Promise<{ id: string; username: string } | null>;
  readJournal(jobId: string): Promise<RemediationJournal | null>;
  prepareJournal(journal: RemediationJournal): Promise<RemediationJournal>;
  markDeleteStarted(jobId: string): Promise<RemediationJournal>;
  markDeleted(jobId: string): Promise<RemediationJournal>;
  deletePost(externalPostId: string): Promise<void>;
  prepareReplacement(source: RemediationSource): Promise<RemediationJournal>;
  publishReplacement(
    source: RemediationSource,
    replacementJobId: string,
  ): Promise<{
    jobId: string;
    attemptId: string;
    externalPostId: string;
    externalUrl: string;
  }>;
  markReplacementStarted(jobId: string): Promise<RemediationJournal>;
  markReplaced(
    jobId: string,
    replacement: Awaited<ReturnType<XRemediationGateway['publishReplacement']>>,
  ): Promise<RemediationJournal>;
  markVerified(jobId: string): Promise<RemediationJournal>;
}

function hashSource(source: RemediationSource): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        revisionId: source.revisionId,
        text: source.text,
        media: source.media.map(({ id, sha256 }) => ({ id, sha256 })),
      }),
    )
    .digest('hex');
}

function validateSource(source: RemediationSource, expectedUsername: string): void {
  if (!source.text.trim()) throw new Error(`Source ${source.jobId} has empty normalized text`);
  if (source.media.length === 0) throw new Error(`Source ${source.jobId} has no media`);
  if (source.media.some((item) => !item.sha256))
    throw new Error(`Source ${source.jobId} has media without a content hash`);
  if (expectedUsername.toLowerCase() !== 'thedailyviber')
    throw new Error('Remediation is restricted to TheDailyViber');
}

export async function dryRunDailyViberRemediation(
  gateway: XRemediationGateway,
): Promise<readonly RemediationJournal[]> {
  const journals: RemediationJournal[] = [];
  for (const [jobId, externalPostId] of DAILY_VIBER_REMEDIATION) {
    const source = await gateway.loadSource(jobId, externalPostId);
    const post = await gateway.lookup(externalPostId);
    if (post?.id !== externalPostId || post.username.toLowerCase() !== 'thedailyviber')
      throw new Error(`X post ${externalPostId} does not resolve to TheDailyViber`);
    validateSource(source, post.username);
    journals.push({ phase: 'prepared', source, contentHash: hashSource(source) });
  }
  return journals;
}

export async function executeDailyViberCanary(
  gateway: XRemediationGateway,
  input: { confirmation: string; jobId: string; externalPostId: string },
): Promise<RemediationJournal> {
  if (input.confirmation !== LIVE_CONFIRMATION) throw new Error('Live confirmation is invalid');
  const allowed = DAILY_VIBER_REMEDIATION[0];
  if (input.jobId !== allowed[0] || input.externalPostId !== allowed[1])
    throw new Error('Only the first allowlisted item is authorized for the canary');

  let journal = await gateway.readJournal(input.jobId);
  if (!journal) {
    const source = await gateway.loadSource(input.jobId, input.externalPostId);
    const existing = await gateway.lookup(input.externalPostId);
    if (existing?.username.toLowerCase() !== 'thedailyviber')
      throw new Error('The allowlisted source post is absent or belongs to another account');
    validateSource(source, existing.username);
    journal = await gateway.prepareJournal({
      phase: 'prepared',
      source,
      contentHash: hashSource(source),
    });
  }
  if (journal.phase === 'prepared') journal = await gateway.markDeleteStarted(input.jobId);
  if (journal.phase === 'delete_started') {
    const existing = await gateway.lookup(journal.source.externalPostId);
    if (existing) await gateway.deletePost(journal.source.externalPostId);
    journal = await gateway.markDeleted(input.jobId);
  }
  if (journal.phase === 'deleted') {
    journal = await gateway.markReplacementStarted(input.jobId);
  }
  if (journal.phase === 'replacement_started') {
    if (!journal.replacementJobId) journal = await gateway.prepareReplacement(journal.source);
    if (!journal.replacementJobId)
      throw new Error('Replacement preparation did not persist a replacement job');
    const replacement = await gateway.publishReplacement(journal.source, journal.replacementJobId);
    journal = await gateway.markReplaced(input.jobId, replacement);
  }
  if (journal.phase === 'replaced') {
    const oldPost = await gateway.lookup(journal.source.externalPostId);
    const replacement = journal.replacementExternalPostId
      ? await gateway.lookup(journal.replacementExternalPostId)
      : null;
    if (oldPost) throw new Error('Deleted X post still resolves');
    if (replacement?.username.toLowerCase() !== 'thedailyviber')
      throw new Error('Replacement X post could not be verified');
    journal = await gateway.markVerified(input.jobId);
  }
  return journal;
}

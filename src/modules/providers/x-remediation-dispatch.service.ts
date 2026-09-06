export interface PublishedReplacementAttempt {
  attemptId: string;
  externalPostId: string;
}

export interface ReplacementPublication {
  jobId: string;
  attemptId: string;
  externalPostId: string;
  externalUrl: string;
}

interface ReplacementDispatchGateway {
  findPublishedAttempt(jobId: string): Promise<PublishedReplacementAttempt | undefined>;
  dispatchExact(jobId: string): Promise<number>;
  externalUrl(externalPostId: string): string;
}

function publication(
  gateway: ReplacementDispatchGateway,
  jobId: string,
  attempt: PublishedReplacementAttempt,
): ReplacementPublication {
  return {
    jobId,
    attemptId: attempt.attemptId,
    externalPostId: attempt.externalPostId,
    externalUrl: gateway.externalUrl(attempt.externalPostId),
  };
}

export async function publishPersistedReplacement(
  gateway: ReplacementDispatchGateway,
  jobId: string,
): Promise<ReplacementPublication> {
  const existing = await gateway.findPublishedAttempt(jobId);
  if (existing?.externalPostId) return publication(gateway, jobId, existing);
  if ((await gateway.dispatchExact(jobId)) !== 1)
    throw new Error('Exact replacement job was not dispatched');
  const published = await gateway.findPublishedAttempt(jobId);
  if (!published?.externalPostId) throw new Error('Replacement publish did not complete');
  return publication(gateway, jobId, published);
}

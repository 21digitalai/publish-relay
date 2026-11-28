import { z } from 'zod';

export function conversationUpdatedTimestamp(value: string | null | undefined): number {
  const normalized = value?.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const timestamp = z.iso.datetime({ offset: true }).safeParse(normalized);
  return timestamp.success ? Date.parse(timestamp.data) : NaN;
}

/** Raw provider-page observation only; never a pagination or reply-eligibility gate. */
export function summarizeConversationOrdering(
  rows: readonly { updatedAt?: string | null }[],
  cutoff: string,
) {
  const summary = {
    cutoff,
    rawCount: rows.length,
    recentCount: 0,
    oldCount: 0,
    unknownCount: 0,
    firstValidTimestamp: null as string | null,
    lastValidTimestamp: null as string | null,
    firstOldPosition: null as number | null,
    inversions: 0,
    recentAfterFirstOld: 0,
    providerPageReads: 1,
  };
  let previous: number | undefined;
  const boundary = Date.parse(cutoff);
  rows.forEach((row, index) => {
    const timestamp = conversationUpdatedTimestamp(row.updatedAt);
    if (!Number.isFinite(timestamp)) {
      summary.unknownCount += 1;
      return;
    }
    const iso = new Date(timestamp).toISOString();
    summary.firstValidTimestamp ??= iso;
    summary.lastValidTimestamp = iso;
    if (previous !== undefined && timestamp > previous) summary.inversions += 1;
    previous = timestamp;
    if (timestamp < boundary) {
      summary.oldCount += 1;
      summary.firstOldPosition ??= index;
    } else {
      summary.recentCount += 1;
      if (summary.firstOldPosition !== null) summary.recentAfterFirstOld += 1;
    }
  });
  return summary;
}

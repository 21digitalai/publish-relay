export const MESSAGE_GROUP_MAXIMUM_BUBBLES = 5;

export type MessageGroupTerminalOutcome = 'confirmed' | 'failed' | 'cancelled' | 'unknown';

export interface MessageGroupPolicy {
  maximumBubbles: number;
  maximumTextLength: number;
}

export class MessageGroupValidationError extends Error {}

export function validateMessageGroupBubbles(
  bubbles: readonly string[],
  policy: MessageGroupPolicy,
) {
  if (
    policy.maximumBubbles < 1 ||
    policy.maximumBubbles > MESSAGE_GROUP_MAXIMUM_BUBBLES
  ) {
    throw new MessageGroupValidationError('Invalid message-group provider policy');
  }
  if (
    bubbles.length < 1 ||
    bubbles.length > policy.maximumBubbles ||
    bubbles.some((bubble) => !bubble.trim() || bubble.length > policy.maximumTextLength)
  ) {
    throw new MessageGroupValidationError(
      `A message group requires 1–${String(policy.maximumBubbles)} nonempty bubbles`,
    );
  }
}

export function sampleMessageGroupDueAt(
  earliestAt: Date,
  latestAt: Date,
  random: () => number = Math.random,
) {
  const earliest = earliestAt.getTime();
  const latest = latestAt.getTime();
  if (!Number.isFinite(earliest) || !Number.isFinite(latest) || latest < earliest) {
    throw new MessageGroupValidationError('Invalid message-group due window');
  }
  const boundedRandom = Math.min(Math.max(random(), 0), 1);
  return new Date(earliest + Math.floor((latest - earliest) * boundedRandom));
}

export function nextWaitingTailState(outcome: MessageGroupTerminalOutcome) {
  if (outcome === 'confirmed') return 'pending' as const;
  if (outcome === 'unknown') return 'waiting' as const;
  return 'cancelled' as const;
}

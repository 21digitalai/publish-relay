/** Mark an original error without changing direct-command route error mapping. */
const preSendErrors = new WeakSet<Error>();

export function markFanvuePreSendError(cause: unknown): Error {
  const error =
    cause instanceof Error ? cause : new Error('Fanvue send preflight failed', { cause });
  preSendErrors.add(error);
  return error;
}

export function isFanvuePreSendError(error: unknown): error is Error {
  return error instanceof Error && preSendErrors.has(error);
}

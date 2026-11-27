export function assertKnownHistoryTransition(
  installed: string | undefined,
  candidate: string,
  transition: string,
): void;
export function assertKnownHistoryLedger(
  rows: { hash: string; created_at: string | number }[],
): void;
export function assertKnownHistorySchema(
  database: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> },
  rows: { hash: string; created_at: string | number }[],
): Promise<void>;

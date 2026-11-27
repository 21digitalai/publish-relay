import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readMigrationTree } from './migration-compatibility.mjs';

const contract = JSON.parse(
  readFileSync(new URL('./known-history-main-20261127.json', import.meta.url), 'utf8'),
);

function fingerprints(root) {
  return Object.fromEntries(
    [...readMigrationTree(join(root, 'migrations'))]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')]),
  );
}

// Deliberate, exact-source exception, never a fallback from the ordinary guard.
// Future releases need a new reviewed contract, not a broader allowlist.
export function assertKnownHistoryTransition(installed, candidate, transition) {
  if (
    transition !== contract.id ||
    !installed ||
    !isDeepStrictEqual(fingerprints(installed), contract.sourceFiles) ||
    !isDeepStrictEqual(fingerprints(candidate), contract.targetFiles)
  ) {
    throw new Error('Known-history transition refused: exact source/target contract required');
  }
}

export function assertKnownHistoryLedger(rows) {
  const observed = rows.map(({ hash, created_at }) => ({ hash, created_at: String(created_at) }));
  if (!contract.allowedLedgers.some((ledger) => isDeepStrictEqual(observed, ledger))) {
    throw new Error('Known-history transition refused: unknown migration ledger');
  }
}

// Read-only catalog preflight precedes the canonical runner. The migrations
// repeat structural validation inside their transaction before committing DDL.
export async function assertKnownHistorySchema(database, rows) {
  const normalized = rows.map(({ hash, created_at }) => ({ hash, created_at: String(created_at) }));
  const skippedActions = isDeepStrictEqual(normalized, contract.allowedLedgers[1]);
  for (const [table, expected] of Object.entries(contract.schemas)) {
    const relation = 'public.' + table;
    const exists = await database.query('SELECT to_regclass($1) AS relation', [relation]);
    if (!exists.rows[0].relation) {
      if (table === 'instagram_unified_actions' && skippedActions) continue;
      throw new Error(`Known-history transition refused: missing ${table}`);
    }
    const result = await database.query('SELECT (' + contract.schemaQuery + ') AS signature', [
      relation,
    ]);
    if (!isDeepStrictEqual(result.rows[0].signature, expected)) {
      throw new Error(`Known-history transition refused: incompatible ${table}`);
    }
  }
}

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertKnownHistoryLedger,
  assertKnownHistoryTransition,
} from '../deploy/known-history-transition.mjs';

const contract = JSON.parse(
  readFileSync(new URL('../deploy/known-history-main-20261127.json', import.meta.url), 'utf8'),
) as { allowedLedgers: { hash: string; created_at: string }[][] };

describe('explicit known-history boundary', () => {
  it('accepts only exact known original and completed ledger sequences', () => {
    for (const rows of contract.allowedLedgers)
      expect(() => {
        assertKnownHistoryLedger(rows);
      }).not.toThrow();
    const original = contract.allowedLedgers[0];
    if (!original || original.length === 0) throw new Error('Missing known-history test fixture');
    expect(() => {
      assertKnownHistoryLedger([]);
    }).toThrow('unknown migration ledger');
    expect(() => {
      assertKnownHistoryLedger(original.slice(1));
    }).toThrow('unknown migration ledger');
    expect(() => {
      assertKnownHistoryLedger([...original].reverse());
    }).toThrow('unknown migration ledger');
    expect(() => {
      assertKnownHistoryLedger([...original, ...original.slice(0, 1)]);
    }).toThrow('unknown migration ledger');
    expect(() => {
      assertKnownHistoryLedger(original.map((row) => ({ ...row, hash: 'changed' })));
    }).toThrow('unknown migration ledger');
  });

  it('requires an explicit recognized transition and installed source', () => {
    expect(() => {
      assertKnownHistoryTransition(undefined, '.', 'main-20261127');
    }).toThrow('exact source/target');
    expect(() => {
      assertKnownHistoryTransition('.', '.', 'other');
    }).toThrow('exact source/target');
  });
});

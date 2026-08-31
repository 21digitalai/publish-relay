import { describe, expect, it } from 'vitest';

import { mutationFingerprint, validateIdempotencyKey } from '../src/modules/api/idempotency.js';

describe('API mutation idempotency', () => {
  it('uses a stable normalized request fingerprint', () => {
    expect(mutationFingerprint({ post: { text: 'hello', media: ['a', 'b'] }, publish: true })).toBe(
      mutationFingerprint({ publish: true, post: { media: ['a', 'b'], text: 'hello' } }),
    );
    expect(mutationFingerprint({ media: ['a', 'b'] })).not.toBe(
      mutationFingerprint({ media: ['b', 'a'] }),
    );
  });

  it('requires a bounded non-empty idempotency key', () => {
    expect(validateIdempotencyKey(' mutation-1 ')).toBe('mutation-1');
    expect(() => validateIdempotencyKey(undefined)).toThrow('Idempotency-Key');
    expect(() => validateIdempotencyKey('x'.repeat(201))).toThrow('Idempotency-Key');
  });
});

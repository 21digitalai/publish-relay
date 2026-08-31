import { createHash } from 'node:crypto';

function canonicalJson(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol')
    throw new Error('Mutation input must be JSON serializable');
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function mutationFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function validateIdempotencyKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key || key.length > 200) throw new Error('A valid Idempotency-Key is required');
  return key;
}

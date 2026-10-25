import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyFanvueWebhookSignature } from '../src/modules/providers/fanvue-webhook-signature.js';

const now = new Date('2026-10-25T01:00:00.000Z');
const timestamp = String(Math.floor(now.getTime() / 1000));
const body = Buffer.from('{"type":"creator.payment.succeeded","name":"é"}');

function mac(secret: string, at = timestamp, raw = body): string {
  return createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${at}.`), raw]))
    .digest('hex');
}

function verify(signatureHeader: string | undefined, rawBody = body) {
  return verifyFanvueWebhookSignature({
    rawBody,
    signatureHeader,
    signingSecrets: ['old-secret', 'new-secret'],
    now,
  });
}

describe('Fanvue signed webhook envelope', () => {
  it('accepts exact raw bytes and rotation MACs under either active secret', () => {
    expect(verify(`t=${timestamp},v0=${mac('old-secret')}`)).toBe(true);
    expect(verify(`t=${timestamp},v0=${mac('old-secret')},${mac('new-secret')}`)).toBe(true);
    expect(verify(`t=${timestamp},v0=${'0'.repeat(64)},${mac('new-secret')}`)).toBe(true);
    expect(verify(`t=${timestamp},v0=${mac('new-secret')}`)).toBe(true);
    expect(verify(`t=${timestamp},v0=${mac('old-secret')}`, Buffer.from('{}'))).toBe(false);
  });

  it('rejects missing, duplicated, malformed and stale signatures', () => {
    expect(verify(undefined)).toBe(false);
    expect(verify(`t=${timestamp},t=${timestamp},v0=${mac('old-secret')}`)).toBe(false);
    expect(verify(`t=oops,v0=${mac('old-secret')}`)).toBe(false);
    expect(verify(`t=${timestamp},v0=zz`)).toBe(false);
    expect(verify(`t=${timestamp},${mac('old-secret')}`)).toBe(false);
    expect(verify(`t=${timestamp},v0=${mac('old-secret')},unexpected=field`)).toBe(false);
    const old = String(Number(timestamp) - 301);
    expect(verify(`t=${old},v0=${mac('old-secret', old)}`)).toBe(false);
    const future = String(Number(timestamp) + 301);
    expect(verify(`t=${future},v0=${mac('old-secret', future)}`)).toBe(false);
  });
});

import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_CLOCK_SKEW_SECONDS = 300;
const MAX_SIGNATURE_HEADER_BYTES = 1024;
const MAX_ROTATION_MACS = 4;
const HEX_MAC = /^[a-fA-F0-9]{64}$/;

function parseSignature(header: string): { timestamp: string; macs: Buffer[] } | null {
  if (Buffer.byteLength(header) > MAX_SIGNATURE_HEADER_BYTES) return null;
  let timestamp: string | null = null;
  let readingMacs = false;
  const macs: Buffer[] = [];
  for (const rawField of header.split(',')) {
    const field = rawField.trim();
    if (field.startsWith('t=')) {
      if (timestamp !== null) return null;
      timestamp = field.slice(2);
      readingMacs = false;
    } else if (field.startsWith('v0=')) {
      readingMacs = true;
      const mac = field.slice(3);
      if (!HEX_MAC.test(mac)) return null;
      macs.push(Buffer.from(mac, 'hex'));
    } else if (readingMacs && HEX_MAC.test(field)) {
      macs.push(Buffer.from(field, 'hex'));
    } else {
      return null;
    }
    if (macs.length > MAX_ROTATION_MACS) return null;
  }
  if (!timestamp || !/^[0-9]+$/.test(timestamp) || macs.length === 0) return null;
  return { timestamp, macs };
}

/** Verify exact raw delivery bytes. The topic header is not authenticated. */
export function verifyFanvueWebhookSignature(input: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  signingSecrets: readonly string[];
  now?: Date;
}): boolean {
  if (!input.signatureHeader || input.signingSecrets.length === 0) return false;
  const parsed = parseSignature(input.signatureHeader);
  if (!parsed) return false;
  const signedAt = Number(parsed.timestamp);
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (!Number.isSafeInteger(signedAt) || Math.abs(now - signedAt) > MAX_CLOCK_SKEW_SECONDS)
    return false;
  const payload = Buffer.concat([Buffer.from(`${parsed.timestamp}.`), input.rawBody]);
  let matched = false;
  for (const secret of input.signingSecrets) {
    if (!secret) continue;
    const expected = createHmac('sha256', secret).update(payload).digest();
    for (const actual of parsed.macs) matched = timingSafeEqual(actual, expected) || matched;
  }
  return matched;
}

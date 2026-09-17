import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  decryptCredential,
  encryptCredential,
  rewrapCredential,
  type MasterKeyProvider,
} from '../src/modules/credentials/envelope.js';

class TestKeys implements MasterKeyProvider {
  private version = 'v1';
  private readonly keys = new Map([
    ['v1', randomBytes(32)],
    ['v2', randomBytes(32)],
  ]);

  currentVersion(): string {
    return this.version;
  }

  rotate(): void {
    this.version = 'v2';
  }

  getKey(version: string): Promise<Buffer> {
    const key = this.keys.get(version);
    if (!key) throw new Error(`Unknown master key version: ${version}`);
    return Promise.resolve(key);
  }
}

describe('credential envelope encryption', () => {
  it('round-trips without placing plaintext in the record', async () => {
    const keys = new TestKeys();
    const secret = Buffer.from('provider-access-token');
    const record = await encryptCredential(secret, keys);

    expect(Object.values(record).some((value) => String(value).includes(secret.toString()))).toBe(
      false,
    );
    await expect(decryptCredential(record, keys)).resolves.toEqual(secret);
  });

  it('rejects ciphertext tampering', async () => {
    const keys = new TestKeys();
    const record = await encryptCredential(Buffer.from('secret'), keys);
    record.ciphertext[0] = (record.ciphertext[0] ?? 0) ^ 1;

    await expect(decryptCredential(record, keys)).rejects.toThrow();
  });

  it('rewraps only the data key during master-key rotation', async () => {
    const keys = new TestKeys();
    const record = await encryptCredential(Buffer.from('secret'), keys);
    const ciphertext = Buffer.from(record.ciphertext);
    keys.rotate();
    const rotated = await rewrapCredential(record, keys);

    expect(rotated.keyVersion).toBe('v2');
    expect(rotated.ciphertext).toEqual(ciphertext);
    await expect(decryptCredential(rotated, keys)).resolves.toEqual(Buffer.from('secret'));
  });
});

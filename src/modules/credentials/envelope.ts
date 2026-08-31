import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export interface MasterKeyProvider {
  currentVersion(): string;
  getKey(version: string): Promise<Buffer>;
}

export interface EncryptedCredential {
  keyVersion: string;
  wrappedKey: Buffer;
  wrappedKeyNonce: Buffer;
  wrappedKeyTag: Buffer;
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
}

function encryptWithKey(
  plaintext: Buffer,
  key: Buffer,
): {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
} {
  if (key.length !== KEY_BYTES) throw new Error('AES-256-GCM keys must contain 32 bytes');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag() };
}

function decryptWithKey(ciphertext: Buffer, key: Buffer, nonce: Buffer, tag: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new Error('AES-256-GCM keys must contain 32 bytes');
  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export async function encryptCredential(
  plaintext: Buffer,
  keys: MasterKeyProvider,
): Promise<EncryptedCredential> {
  const keyVersion = keys.currentVersion();
  const masterKey = await keys.getKey(keyVersion);
  const dataKey = randomBytes(KEY_BYTES);
  const encrypted = encryptWithKey(plaintext, dataKey);
  const wrapped = encryptWithKey(dataKey, masterKey);
  dataKey.fill(0);
  return {
    keyVersion,
    wrappedKey: wrapped.ciphertext,
    wrappedKeyNonce: wrapped.nonce,
    wrappedKeyTag: wrapped.tag,
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    tag: encrypted.tag,
  };
}

export async function decryptCredential(
  record: EncryptedCredential,
  keys: MasterKeyProvider,
): Promise<Buffer> {
  const masterKey = await keys.getKey(record.keyVersion);
  const dataKey = decryptWithKey(
    record.wrappedKey,
    masterKey,
    record.wrappedKeyNonce,
    record.wrappedKeyTag,
  );
  try {
    return decryptWithKey(record.ciphertext, dataKey, record.nonce, record.tag);
  } finally {
    dataKey.fill(0);
  }
}

export async function rewrapCredential(
  record: EncryptedCredential,
  keys: MasterKeyProvider,
): Promise<EncryptedCredential> {
  const oldMasterKey = await keys.getKey(record.keyVersion);
  const dataKey = decryptWithKey(
    record.wrappedKey,
    oldMasterKey,
    record.wrappedKeyNonce,
    record.wrappedKeyTag,
  );
  try {
    const keyVersion = keys.currentVersion();
    const wrapped = encryptWithKey(dataKey, await keys.getKey(keyVersion));
    return {
      ...record,
      keyVersion,
      wrappedKey: wrapped.ciphertext,
      wrappedKeyNonce: wrapped.nonce,
      wrappedKeyTag: wrapped.tag,
    };
  } finally {
    dataKey.fill(0);
  }
}

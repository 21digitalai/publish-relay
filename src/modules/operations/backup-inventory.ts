import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

import { captureTime } from './backup-retention.js';
import type { BackupEntry } from './backup-retention.js';

const receiptSchema = z
  .object({
    version: z.literal(1),
    file: z.string(),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    validation: z.enum(['pg-restore-full', 'pg-restore-full-and-age-roundtrip']),
    validatedAt: z.iso.datetime(),
  })
  .strict();
const MAX_RECEIPT_BYTES = 4096;

async function hashFile(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw new Error('Unsafe file');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path, { fd: handle.fd, autoClose: false })) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Invalid stream chunk');
      hash.update(chunk);
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev
    ) {
      throw new Error('Backup changed during observation');
    }
    return { bytes: after.size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function readReceipt(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RECEIPT_BYTES)
      throw new Error('Unsafe receipt');
    return receiptSchema.parse(JSON.parse(await handle.readFile('utf8')) as unknown);
  } finally {
    await handle.close();
  }
}

async function inspectEntry(root: string, name: string): Promise<BackupEntry> {
  const path = join(root, name);
  const entry: BackupEntry = {
    name,
    path,
    bytes: 0,
    sha256: null,
    capturedAt: captureTime(name),
    verified: false,
    reason: 'unrecognized or unverified artifact',
  };
  const stat = await lstat(path);
  entry.bytes = stat.size;
  if (!stat.isFile() || stat.nlink !== 1 || !entry.capturedAt) return entry;
  const digest = await hashFile(path);
  Object.assign(entry, digest);
  try {
    const receipt = await readReceipt(path + '.verified.json');
    if (
      receipt.file !== name ||
      receipt.validation !==
        (name.endsWith('.age') ? 'pg-restore-full-and-age-roundtrip' : 'pg-restore-full') ||
      receipt.bytes !== digest.bytes ||
      receipt.sha256 !== digest.sha256 ||
      Date.parse(receipt.validatedAt) < Date.parse(entry.capturedAt)
    )
      return entry;
    entry.verified = true;
    entry.reason = 'validated capture receipt matches exact archive bytes';
  } catch {
    /* Missing/legacy/bad receipts preserve their backup; never infer validation. */
  }
  return entry;
}

export async function inspectBackups(
  directory: string,
): Promise<{ root: string; entries: BackupEntry[] }> {
  if (!isAbsolute(directory) || resolve(directory) === '/')
    throw new Error('Use an absolute dedicated backup directory');
  const stat = await lstat(directory);
  const root = await realpath(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || root !== resolve(directory))
    throw new Error('Unsafe backup root');
  const names = (await readdir(root)).sort();
  const entries: BackupEntry[] = [];
  for (const name of names) {
    // Receipts, locks, incomplete staging and unknown files stay visible/protected too.
    entries.push(await inspectEntry(root, name));
  }
  return { root, entries };
}

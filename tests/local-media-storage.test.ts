import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalMediaStorage } from '../src/modules/content/local-media-storage.js';
import { createMediaStagingReconciler } from '../src/modules/content/media-staging.worker.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storageFixture(): Promise<{ root: string; storage: LocalMediaStorage }> {
  const root = await mkdtemp(join(tmpdir(), 'publish-relay-storage-test-'));
  roots.push(root);
  return { root, storage: new LocalMediaStorage(root) };
}

describe('LocalMediaStorage streaming ingest', () => {
  it('hashes and promotes a multi-chunk body without buffering it as one value', async () => {
    const { root, storage } = await storageFixture();
    const staged = await storage.stageStream({
      stream: Readable.from([Buffer.from('first-'), Buffer.from('second')]),
      maxBytes: 64,
      fingerprintPrefix: Buffer.from('video/mp4\0'),
    });

    expect(staged.byteSize).toBe(12);
    expect(staged.prefix.toString()).toBe('first-second');
    expect(staged.requestFingerprint).toBe(
      createHash('sha256').update('video/mp4\0first-second').digest('hex'),
    );
    const promoted = await storage.promote({
      staged,
      workspaceId: 'workspace',
      mediaId: 'media',
    });
    expect(await readFile(join(root, promoted.storageKey), 'utf8')).toBe('first-second');
  });

  it('aborts oversized streams and removes the partial temporary object', async () => {
    const { root, storage } = await storageFixture();
    await expect(
      storage.stageStream({
        stream: Readable.from([Buffer.alloc(8), Buffer.alloc(8)]),
        maxBytes: 10,
        fingerprintPrefix: Buffer.from('video/mp4\0'),
      }),
    ).rejects.toThrow('Media exceeds the configured size limit');
    expect(await readdir(join(root, '.temporary'))).toEqual([]);
  });

  it('removes the partial temporary object when the request stream is interrupted', async () => {
    const { root, storage } = await storageFixture();
    const interrupted = Readable.from(
      (function* () {
        yield Buffer.from('partial');
        throw new Error('client disconnected');
      })(),
    );
    await expect(
      storage.stageStream({
        stream: interrupted,
        maxBytes: 64,
        fingerprintPrefix: Buffer.from('video/mp4\0'),
      }),
    ).rejects.toThrow('client disconnected');
    expect(await readdir(join(root, '.temporary'))).toEqual([]);
  });

  it('removes stale staging objects while retaining fresh in-flight objects', async () => {
    const { root, storage } = await storageFixture();
    const temporaryDirectory = join(root, '.temporary');
    const stalePath = join(temporaryDirectory, 'stale');
    const freshPath = join(temporaryDirectory, 'fresh');
    await mkdir(temporaryDirectory, { recursive: true });
    await writeFile(stalePath, 'stale');
    await writeFile(freshPath, 'fresh');
    await utimes(stalePath, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));

    await expect(
      storage.cleanupStaleStaging({ staleBefore: new Date('2026-09-02T00:00:00Z') }),
    ).resolves.toBe(1);
    expect(await readdir(temporaryDirectory)).toEqual(['fresh']);
  });

  it('removes an object after it ages past the threshold during a later reconciliation', async () => {
    const { root, storage } = await storageFixture();
    const temporaryDirectory = join(root, '.temporary');
    const stagedPath = join(temporaryDirectory, 'ages-during-worker-lifetime');
    await mkdir(temporaryDirectory, { recursive: true });
    await writeFile(stagedPath, 'staged');

    const reconcile = createMediaStagingReconciler(storage, {
      staleMs: 24 * 60 * 60 * 1000,
      intervalMs: 60_000,
    });
    await expect(reconcile(new Date('2026-09-02T00:00:00Z'))).resolves.toBe(0);
    await utimes(stagedPath, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));
    await expect(reconcile(new Date('2026-09-02T00:00:30Z'))).resolves.toBeUndefined();
    await expect(reconcile(new Date('2026-09-02T00:01:00Z'))).resolves.toBe(1);
    expect(await readdir(temporaryDirectory)).toEqual([]);
  });

  it('allows concurrent reconcilers to race over disappearing entries', async () => {
    const { root, storage } = await storageFixture();
    const temporaryDirectory = join(root, '.temporary');
    await mkdir(temporaryDirectory, { recursive: true });
    await Promise.all(
      Array.from({ length: 50 }, async (_, index) => {
        const path = join(temporaryDirectory, `stale-${String(index)}`);
        await writeFile(path, 'stale');
        await utimes(path, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));
      }),
    );

    await expect(
      Promise.all(
        Array.from({ length: 8 }, () =>
          storage.cleanupStaleStaging({ staleBefore: new Date('2026-09-02T00:00:00Z') }),
        ),
      ),
    ).resolves.toBeDefined();
    expect(await readdir(temporaryDirectory)).toEqual([]);
  });
});

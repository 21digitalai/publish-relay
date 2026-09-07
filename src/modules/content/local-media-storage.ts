import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { MediaStorage, StagedMedia } from './media-storage.js';

export class LocalMediaStorage implements MediaStorage {
  private readonly root: string;

  public constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(storageKey: string): string {
    const path = resolve(this.root, storageKey);
    if (!path.startsWith(`${this.root}${sep}`)) throw new Error('Invalid media storage key');
    return path;
  }

  public async put(input: {
    workspaceId: string;
    mediaId: string;
    bytes: Buffer;
    mimeType: string;
  }): Promise<{ storageKey: string }> {
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const storageKey = `${input.workspaceId}/${input.mediaId}/${sha256}`;
    const path = this.pathFor(storageKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.bytes, { flag: 'wx', mode: 0o600 });
    return { storageKey };
  }

  public async stageStream(input: {
    stream: Readable;
    maxBytes: number;
    fingerprintPrefix: Buffer;
  }): Promise<StagedMedia> {
    const temporaryKey = `.temporary/${randomUUID()}`;
    const filePath = this.pathFor(temporaryKey);
    const hash = createHash('sha256');
    const fingerprintHash = createHash('sha256').update(input.fingerprintPrefix);
    const prefixChunks: Buffer[] = [];
    let prefixSize = 0;
    let byteSize = 0;
    await mkdir(dirname(filePath), { recursive: true });
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        byteSize += chunk.length;
        if (byteSize > input.maxBytes) {
          callback(new Error('Media exceeds the configured size limit'));
          return;
        }
        hash.update(chunk);
        fingerprintHash.update(chunk);
        if (prefixSize < 12) {
          const part = chunk.subarray(0, 12 - prefixSize);
          prefixChunks.push(part);
          prefixSize += part.length;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        input.stream,
        meter,
        createWriteStream(filePath, { flags: 'wx', mode: 0o600 }),
      );
      if (byteSize === 0) throw new Error('Media content is empty');
      return {
        temporaryKey,
        filePath,
        sha256: hash.digest('hex'),
        requestFingerprint: fingerprintHash.digest('hex'),
        byteSize,
        prefix: Buffer.concat(prefixChunks),
      };
    } catch (error) {
      await rm(filePath, { force: true });
      throw error;
    }
  }

  public async promote(input: {
    staged: StagedMedia;
    workspaceId: string;
    mediaId: string;
  }): Promise<{ storageKey: string }> {
    const storageKey = `${input.workspaceId}/${input.mediaId}/${input.staged.sha256}`;
    const destination = this.pathFor(storageKey);
    await mkdir(dirname(destination), { recursive: true });
    await rename(this.pathFor(input.staged.temporaryKey), destination);
    return { storageKey };
  }

  public async cleanupStaleStaging(input: { staleBefore: Date }): Promise<number> {
    const temporaryDirectory = this.pathFor('.temporary');
    let entries;
    try {
      entries = await readdir(temporaryDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }

    let deleted = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const temporaryKey = `.temporary/${entry.name}`;
      const filePath = this.pathFor(temporaryKey);
      const metadata = await stat(filePath);
      if (metadata.mtimeMs >= input.staleBefore.getTime()) continue;
      await rm(filePath, { force: true });
      deleted += 1;
    }
    return deleted;
  }

  public async delete(storageKey: string): Promise<void> {
    await rm(this.pathFor(storageKey), { force: true });
  }

  public async read(storageKey: string): Promise<Buffer> {
    return readFile(this.pathFor(storageKey));
  }
}

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';

import type { MediaStorage } from './media-storage.js';

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

  public async delete(storageKey: string): Promise<void> {
    await rm(this.pathFor(storageKey), { force: true });
  }
}

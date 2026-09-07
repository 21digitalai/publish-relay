import type { Readable } from 'node:stream';

export interface StagedMedia {
  temporaryKey: string;
  filePath: string;
  sha256: string;
  requestFingerprint: string;
  byteSize: number;
  prefix: Buffer;
}

export interface MediaStorage {
  put(input: {
    workspaceId: string;
    mediaId: string;
    bytes: Buffer;
    mimeType: string;
  }): Promise<{ storageKey: string }>;
  read(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
  stageStream?(input: {
    stream: Readable;
    maxBytes: number;
    fingerprintPrefix: Buffer;
  }): Promise<StagedMedia>;
  promote?(input: {
    staged: StagedMedia;
    workspaceId: string;
    mediaId: string;
  }): Promise<{ storageKey: string }>;
}

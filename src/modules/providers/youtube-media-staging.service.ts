import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  createStagingArtifact,
  findStagingArtifact,
  getStagingArtifactById,
  updateStagingByteProgress,
  attachStagingReferenceCredential,
} from '../content/provider-staging.repository.js';
import { withProviderStagingLock } from '../content/provider-staging-lock.js';
import { createCredential, getActiveCredential } from '../credentials/credential.repository.js';
import {
  decryptCredential,
  encryptCredential,
  type MasterKeyProvider,
} from '../credentials/envelope.js';
import type { YouTubeHttpClient, YouTubeUploadProgress } from './youtube-http-client.js';

const YOUTUBE_CHUNK_BYTES = 8 * 1024 * 1024;
const YOUTUBE_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface YouTubeMediaSource {
  load(input: { workspaceId: string; mediaId: string }): Promise<{
    bytes: Buffer;
    mimeType: string;
  }>;
}

interface YouTubeStagingInput {
  workspaceId: string;
  jobId: string;
  mediaId: string;
  accessToken: string;
  metadata: Record<string, unknown>;
  notifySubscribers: boolean;
  now?: Date;
}

interface YouTubeArtifact {
  id: string;
  providerReferenceCredentialId: string | null;
  nextByteOffset: number;
  externalObjectId: string | null;
}

export async function stageYouTubeMedia(
  database: NodePgDatabase,
  source: YouTubeMediaSource,
  client: YouTubeHttpClient,
  keys: MasterKeyProvider,
  input: YouTubeStagingInput,
): Promise<{ videoId: string }> {
  const existing = await withTenantTransaction(database, input, (transaction) =>
    findStagingArtifact(transaction, input.workspaceId, input.jobId, input.mediaId),
  );
  const artifact = existing ?? (await reserveUpload(database, input));
  await initializeUpload(database, source, client, keys, input, artifact);
  return resumeUpload(database, source, client, keys, input, artifact);
}

async function reserveUpload(
  database: NodePgDatabase,
  input: YouTubeStagingInput,
): Promise<YouTubeArtifact> {
  const now = input.now ?? new Date();
  return withTenantTransaction(database, input, (transaction) =>
    createStagingArtifact(transaction, {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      mediaId: input.mediaId,
      providerReference: 'youtube:resumable',
      expiresAt: new Date(now.getTime() + YOUTUBE_SESSION_LIFETIME_MS),
    }),
  );
}

async function initializeUpload(
  database: NodePgDatabase,
  source: YouTubeMediaSource,
  client: YouTubeHttpClient,
  keys: MasterKeyProvider,
  input: YouTubeStagingInput,
  artifact: YouTubeArtifact,
): Promise<void> {
  await withProviderStagingLock(database, artifact.id, async () => {
    const current = await loadArtifact(database, input.workspaceId, artifact.id);
    if (current.externalObjectId || current.providerReferenceCredentialId) return;
    const media = await source.load(input);
    let sessionBytes: Buffer | undefined;
    try {
      validateMedia(media);
      const sessionUrl = await client.initiateUpload({
        accessToken: input.accessToken,
        totalBytes: media.bytes.length,
        mimeType: media.mimeType,
        metadata: input.metadata,
        notifySubscribers: input.notifySubscribers,
      });
      sessionBytes = Buffer.from(sessionUrl);
      const encrypted = await encryptCredential(sessionBytes, keys);
      await withTenantTransaction(database, input, async (transaction) => {
        const credential = await createCredential(transaction, input.workspaceId, encrypted);
        await attachStagingReferenceCredential(
          transaction,
          input.workspaceId,
          current.id,
          credential.id,
        );
      });
    } finally {
      sessionBytes?.fill(0);
      media.bytes.fill(0);
    }
  });
}

function validateMedia(media: { bytes: Buffer; mimeType: string }): void {
  if (media.mimeType !== 'video/mp4') throw new Error('YouTube staging requires video/mp4');
  if (media.bytes.length === 0) throw new Error('YouTube media content is empty');
}

async function resumeUpload(
  database: NodePgDatabase,
  source: YouTubeMediaSource,
  client: YouTubeHttpClient,
  keys: MasterKeyProvider,
  input: YouTubeStagingInput,
  artifact: YouTubeArtifact,
): Promise<{ videoId: string }> {
  return withProviderStagingLock(database, artifact.id, async () => {
    const current = await loadArtifact(database, input.workspaceId, artifact.id);
    if (current.externalObjectId) return { videoId: current.externalObjectId };
    if (!current.providerReferenceCredentialId) {
      throw new Error('YouTube upload session credential is unavailable');
    }
    const credentialId = current.providerReferenceCredentialId;
    const media = await source.load(input);
    let sessionBytes: Buffer | undefined;
    try {
      validateMedia(media);
      const stored = await withTenantTransaction(database, input, (transaction) =>
        getActiveCredential(transaction, input.workspaceId, credentialId),
      );
      if (!stored) throw new Error('YouTube upload session credential is unavailable');
      sessionBytes = await decryptCredential(stored, keys);
      const sessionUrl = sessionBytes.toString('utf8');
      const authority = await client.queryUpload(sessionUrl, input.accessToken, media.bytes.length);
      return await uploadFromAuthority(
        database,
        client,
        input,
        current.id,
        sessionUrl,
        media.bytes,
        authority,
      );
    } finally {
      sessionBytes?.fill(0);
      media.bytes.fill(0);
    }
  });
}

async function loadArtifact(
  database: NodePgDatabase,
  workspaceId: string,
  artifactId: string,
): Promise<YouTubeArtifact> {
  const artifact = await withTenantTransaction(database, { workspaceId }, (transaction) =>
    getStagingArtifactById(transaction, workspaceId, artifactId),
  );
  if (!artifact) throw new Error('YouTube staging artifact is unavailable');
  return artifact;
}

async function uploadFromAuthority(
  database: NodePgDatabase,
  client: YouTubeHttpClient,
  input: YouTubeStagingInput,
  artifactId: string,
  sessionUrl: string,
  bytes: Buffer,
  authority: YouTubeUploadProgress,
): Promise<{ videoId: string }> {
  let progress = authority;
  while (progress.status === 'incomplete') {
    const startOffset = progress.nextOffset;
    if (startOffset < 0 || startOffset >= bytes.length) {
      throw new Error('YouTube reported an invalid resumable upload offset');
    }
    progress = await client.uploadChunk({
      sessionUrl,
      accessToken: input.accessToken,
      bytes: bytes.subarray(startOffset, startOffset + YOUTUBE_CHUNK_BYTES),
      startOffset,
      totalBytes: bytes.length,
    });
    if (progress.status === 'incomplete' && progress.nextOffset <= startOffset)
      throw new Error('YouTube resumable upload offset did not advance');
    await persistProgress(database, input.workspaceId, artifactId, progress);
  }
  return { videoId: progress.videoId };
}

async function persistProgress(
  database: NodePgDatabase,
  workspaceId: string,
  artifactId: string,
  progress: YouTubeUploadProgress,
): Promise<void> {
  await withTenantTransaction(database, { workspaceId }, (transaction) =>
    updateStagingByteProgress(transaction, workspaceId, artifactId, {
      uploadPhase: progress.status === 'complete' ? 'finalized' : 'uploading',
      nextByteOffset: progress.status === 'complete' ? 0 : progress.nextOffset,
      ...(progress.status === 'complete' ? { externalObjectId: progress.videoId } : {}),
    }),
  );
}

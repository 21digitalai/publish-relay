import type { LinkedInCredential, LinkedInHttpClient } from './linkedin-http-client.js';
import type { XMediaSource } from './x-media-staging.service.js';

export interface LinkedInVideoArtifact {
  ensure(): Promise<{
    phase: 'reserved' | 'processing' | 'available' | 'failed';
    video: string | null;
  }>;
  recordUploaded(video: string): Promise<void>;
  recordStatus(video: string, status: 'AVAILABLE' | 'PROCESSING_FAILED'): Promise<void>;
}

/** Resume a job-bound upload without creating a post until LinkedIn confirms availability. */
export async function stageLinkedInVideo(input: {
  artifact: LinkedInVideoArtifact;
  client: Pick<LinkedInHttpClient, 'uploadVideo' | 'getVideoStatus'>;
  source: XMediaSource;
  credential: LinkedInCredential;
  workspaceId: string;
  mediaId: string;
}): Promise<{ state: 'available' | 'pending'; video: string }> {
  let state = await input.artifact.ensure();
  if (state.phase === 'failed') throw new Error('LinkedIn video processing failed');
  if (state.phase === 'reserved') {
    const media = await input.source.load({
      workspaceId: input.workspaceId,
      mediaId: input.mediaId,
    });
    if (media.mimeType !== 'video/mp4') throw new Error('LinkedIn video requires an MP4 file');
    const video = await input.client.uploadVideo({
      credential: input.credential,
      bytes: media.bytes,
    });
    await input.artifact.recordUploaded(video);
    state = { phase: 'processing', video };
  }
  if (!state.video) throw new Error('LinkedIn video artifact has no video URN');
  const status = await input.client.getVideoStatus({
    credential: input.credential,
    video: state.video,
  });
  if (status === 'PROCESSING_FAILED') {
    if (state.phase === 'processing') await input.artifact.recordStatus(state.video, status);
    throw new Error('LinkedIn video processing failed');
  }
  if (status !== 'AVAILABLE') return { state: 'pending', video: state.video };
  if (state.phase === 'processing') await input.artifact.recordStatus(state.video, status);
  return { state: 'available', video: state.video };
}

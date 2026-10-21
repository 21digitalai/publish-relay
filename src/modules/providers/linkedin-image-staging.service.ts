import {
  LinkedInRequestError,
  type LinkedInCredential,
  type LinkedInHttpClient,
} from './linkedin-http-client.js';
import type { LinkedInVideoArtifact } from './linkedin-video-staging.service.js';
import type { XMediaSource } from './x-media-staging.service.js';

/** Job-bound image upload; only an AVAILABLE image may reach the post-create boundary. */
export async function stageLinkedInImage(input: {
  artifact: LinkedInVideoArtifact;
  client: Pick<LinkedInHttpClient, 'uploadImage' | 'getImageStatus'>;
  source: XMediaSource;
  credential: LinkedInCredential;
  workspaceId: string;
  mediaId: string;
}): Promise<{ state: 'available' | 'pending'; image: string }> {
  let state = await input.artifact.ensure();
  if (state.phase === 'failed') throw new Error('LinkedIn image processing failed');
  if (state.phase === 'reserved') {
    const media = await input.source.load({
      workspaceId: input.workspaceId,
      mediaId: input.mediaId,
    });
    if (!['image/jpeg', 'image/png'].includes(media.mimeType))
      throw new Error('LinkedIn image requires a JPEG or PNG');
    const image = await input.client.uploadImage({
      credential: input.credential,
      bytes: media.bytes,
      mimeType: media.mimeType,
    });
    await input.artifact.recordUploaded(image);
    state = { phase: 'processing', video: image };
  }
  if (!state.video) throw new Error('LinkedIn image artifact has no image URN');
  let status: Awaited<ReturnType<LinkedInHttpClient['getImageStatus']>>;
  try {
    status = await input.client.getImageStatus({
      credential: input.credential,
      image: state.video,
    });
  } catch (error) {
    if (error instanceof LinkedInRequestError && error.status === 403)
      throw new Error('LinkedIn image readiness is unavailable for this member grant');
    throw error;
  }
  if (status === 'PROCESSING_FAILED') {
    if (state.phase === 'processing') await input.artifact.recordStatus(state.video, status);
    throw new Error('LinkedIn image processing failed');
  }
  if (status !== 'AVAILABLE') return { state: 'pending', image: state.video };
  if (state.phase === 'processing') await input.artifact.recordStatus(state.video, status);
  return { state: 'available', image: state.video };
}

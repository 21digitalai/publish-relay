import { z } from 'zod';

import {
  SnapchatSpotlightClient,
  SnapchatSpotlightRequestError,
} from './snapchat-spotlight-client.js';

const postedStoryResponse = z.object({
  request_status: z.literal('SUCCESS'),
  request_id: z.uuid(),
});

// Shares the pinned Business API transport and encrypted media upload with Spotlight.
// A request ID correlates a Story POST; it is not a published Story ID.
export class SnapchatStoryClient extends SnapchatSpotlightClient {
  public async postStory(input: {
    profileId: string;
    accessToken: string;
    mediaId: string;
    customizedTtl?: 'ONE_DAY' | 'TWO_DAYS' | 'THREE_DAYS' | 'ONE_WEEK';
    link?: string;
  }): Promise<string> {
    let body: unknown;
    try {
      body = await this.send(
        `https://businessapi.snapchat.com/v1/public_profiles/${input.profileId}/stories`,
        input.accessToken,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            media_id: input.mediaId,
            ...(input.customizedTtl ? { customized_ttl: { ttl: input.customizedTtl } } : {}),
            ...(input.link ? { link: input.link } : {}),
          }),
        },
      );
    } catch (error) {
      if (
        error instanceof SnapchatSpotlightRequestError &&
        ['auth', 'rate_limit', 'validation', 'permanent'].includes(error.kind)
      )
        throw error;
      throw new SnapchatSpotlightRequestError('unknown');
    }
    const parsed = postedStoryResponse.safeParse(body);
    if (!parsed.success) throw new SnapchatSpotlightRequestError('unknown');
    return parsed.data.request_id;
  }
}

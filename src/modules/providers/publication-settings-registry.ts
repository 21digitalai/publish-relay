import { PublishingAdapterRegistry } from './adapter-registry.js';
import type { DestinationProvider } from './contract.js';
import { resolveYouTubeSettings } from './youtube-settings.js';

interface SettingsResolver {
  destinationProvider: DestinationProvider;
  resolve(content: Record<string, unknown>, defaults: unknown): Record<string, unknown> | null;
}

const noSettings = (destinationProvider: DestinationProvider): SettingsResolver => ({
  destinationProvider,
  resolve: () => null,
});

const youtubeSettings: SettingsResolver = {
  destinationProvider: 'youtube',
  resolve(content, defaults) {
    if (content.kind !== 'video') throw new Error('YouTube requires video content');
    const options = content.providerOptions as { youtube?: unknown } | undefined;
    return { ...resolveYouTubeSettings(defaults, options?.youtube) };
  },
};

// Composition owns destination-specific settings. TikTok remains contract-only until its adapter ships.
export const publicationSettingsRegistry = new PublishingAdapterRegistry<SettingsResolver>([
  noSettings('x'),
  youtubeSettings,
  noSettings('instagram'),
  noSettings('facebook_page'),
  noSettings('linkedin'),
]);

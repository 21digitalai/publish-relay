export type PostingAdapterId = 'x' | 'youtube';

export interface PostingAdapterIcon {
  readonly viewBox: string;
  readonly paths: readonly string[];
}

export interface PostingAdapterConfig {
  readonly id: PostingAdapterId;
  readonly label: string;
  readonly description: string;
  readonly icon: PostingAdapterIcon;
  readonly enabled: boolean;
  readonly auth: {
    readonly kind: 'oauth';
    readonly startPath: string;
  };
  readonly configuration: {
    readonly requiredBeforeConnect: readonly string[];
  };
}

export const POSTING_ADAPTERS: readonly PostingAdapterConfig[] = [
  {
    id: 'x',
    label: 'X',
    description: 'Publish posts and threads to an X account.',
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.657l-5.214-6.817-5.967 6.817H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z',
      ],
    },
    enabled: true,
    auth: { kind: 'oauth', startPath: '/api/oauth/x' },
    configuration: { requiredBeforeConnect: [] },
  },
  {
    id: 'youtube',
    label: 'YouTube',
    description: 'Publish videos to a YouTube channel.',
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8ZM9.6 15.6V8.4L15.8 12l-6.2 3.6Z',
      ],
    },
    enabled: true,
    auth: { kind: 'oauth', startPath: '/api/oauth/youtube' },
    configuration: { requiredBeforeConnect: [] },
  },
] as const;

export function getEnabledPostingAdapters(
  adapters: readonly PostingAdapterConfig[] = POSTING_ADAPTERS,
): readonly PostingAdapterConfig[] {
  return adapters.filter((adapter) => adapter.enabled);
}

export function getPostingAdapter(provider: string): PostingAdapterConfig | undefined {
  const normalized = provider.toLowerCase();
  return POSTING_ADAPTERS.find((adapter) => adapter.id === normalized);
}

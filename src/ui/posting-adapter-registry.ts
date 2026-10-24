export type PostingAdapterId =
  'x' | 'youtube' | 'linkedin' | 'facebook_page' | 'instagram' | 'tiktok' | 'fanvue';

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
  {
    id: 'linkedin',
    label: 'LinkedIn',
    description: 'Publish text posts to your LinkedIn member profile.',
    icon: {
      viewBox: '0 0 24 24',
      paths: [
        'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.35V9h3.414v1.561h.049c.476-.9 1.637-1.85 3.37-1.85 3.601 0 4.266 2.371 4.266 5.455v6.286ZM5.337 7.433a2.062 2.062 0 1 1 0-4.124 2.062 2.062 0 0 1 0 4.124ZM7.119 20.452H3.555V9H7.12v11.452ZM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003Z',
      ],
    },
    enabled: true,
    auth: { kind: 'oauth', startPath: '/api/oauth/linkedin' },
    configuration: { requiredBeforeConnect: [] },
  },
  {
    id: 'facebook_page',
    label: 'Facebook Pages',
    description: 'Connect a Facebook Page without requesting Instagram access.',
    icon: { viewBox: '0 0 24 24', paths: ['M2 12c2-10 7-10 10 0 3 10 8 10 10 0'] },
    enabled: true,
    auth: { kind: 'oauth', startPath: '/api/oauth/meta/facebook-pages' },
    configuration: { requiredBeforeConnect: [] },
  },
  {
    id: 'instagram',
    label: 'Instagram',
    description: 'Connect an Instagram Professional account separately from Facebook Pages.',
    icon: { viewBox: '0 0 24 24', paths: ['M2 12c2-10 7-10 10 0 3 10 8 10 10 0'] },
    enabled: true,
    auth: { kind: 'oauth', startPath: '/api/oauth/instagram' },
    configuration: { requiredBeforeConnect: [] },
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    description: 'Publish a video with creator-reviewed options to a TikTok account.',
    icon: {
      viewBox: '0 0 24 24',
      paths: ['M14 2v12.5a4.5 4.5 0 1 1-4.5-4.5', 'M14 2c1 3 3 5 6 5'],
    },
    enabled: true,
    auth: { kind: 'oauth', startPath: '/api/oauth/tiktok' },
    configuration: { requiredBeforeConnect: [] },
  },
  {
    id: 'fanvue',
    label: 'Fanvue',
    description: 'Connect publishing only. Messages and comments need separate permission.',
    icon: { viewBox: '0 0 24 24', paths: ['M4 3h16v4H9v4h9v4H9v6H4V3Z'] },
    enabled: true,
    auth: { kind: 'oauth', startPath: '/api/oauth/fanvue' },
    configuration: { requiredBeforeConnect: [] },
  },
] as const;

export function getEnabledPostingAdapters(
  adapters: readonly PostingAdapterConfig[] = POSTING_ADAPTERS,
): readonly PostingAdapterConfig[] {
  return adapters.filter(
    (adapter) =>
      adapter.enabled &&
      (adapter.id !== 'linkedin' ||
        (typeof document !== 'undefined' && document.body.dataset.linkedinEnabled === 'true')) &&
      (adapter.id !== 'tiktok' ||
        (typeof document !== 'undefined' && document.body.dataset.tiktokEnabled === 'true')) &&
      (adapter.id !== 'fanvue' ||
        (typeof document !== 'undefined' && document.body.dataset.fanvueEnabled === 'true')),
  );
}

export function getPostingAdapter(
  provider: string,
  destinationProvider?: string,
): PostingAdapterConfig | undefined {
  const normalized =
    provider.toLowerCase() === 'meta' ? destinationProvider?.toLowerCase() : provider.toLowerCase();
  return POSTING_ADAPTERS.find((adapter) => adapter.id === normalized);
}

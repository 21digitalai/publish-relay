import type { DestinationProvider } from './contract.js';

export type DestinationContentKind =
  'text' | 'video' | 'single_image' | 'multi_image' | 'carousel' | 'link' | 'post';

export interface DestinationCapabilitySnapshot {
  schemaVersion: 1;
  contentKinds: DestinationContentKind[];
  media: { minImages?: number; maxImages?: number };
}

const CAPABILITIES: Partial<Record<DestinationProvider, DestinationCapabilitySnapshot>> = {
  x: { schemaVersion: 1, contentKinds: ['text'], media: { maxImages: 4 } },
  youtube: { schemaVersion: 1, contentKinds: ['video'], media: {} },
  linkedin: {
    schemaVersion: 1,
    contentKinds: ['text', 'link', 'video', 'single_image', 'multi_image'],
    media: { minImages: 2, maxImages: 20 },
  },
  instagram: {
    schemaVersion: 1,
    contentKinds: ['single_image', 'carousel'],
    media: { minImages: 1, maxImages: 10 },
  },
  facebook_page: {
    schemaVersion: 1,
    contentKinds: ['link', 'single_image'],
    media: { minImages: 0, maxImages: 1 },
  },
  // C2 may discover accounts, but creator capabilities and posting remain unimplemented.
  tiktok: { schemaVersion: 1, contentKinds: [], media: {} },
  // Owner discovery is not proof of Public Profile posting access.
  snapchat: { schemaVersion: 1, contentKinds: [], media: {} },
  // One explicit Fanvue post shape accepts text and optional ready image/video media.
  fanvue: { schemaVersion: 1, contentKinds: ['post'], media: { maxImages: 20 } },
};

export function destinationCapabilities(provider: string): DestinationCapabilitySnapshot {
  const capabilities = CAPABILITIES[provider as DestinationProvider];
  if (!capabilities) throw new Error(`Unsupported destination provider: ${provider}`);
  return structuredClone(capabilities);
}

export function capabilityFreshness(
  checkedAt: Date | null,
  now = new Date(),
): 'fresh' | 'stale' | 'unknown' {
  if (!checkedAt) return 'unknown';
  return now.getTime() - checkedAt.getTime() <= 24 * 60 * 60_000 ? 'fresh' : 'stale';
}

export function intersectContentKinds(
  snapshots: readonly DestinationCapabilitySnapshot[],
): DestinationContentKind[] {
  const first = snapshots[0];
  if (!first) return [];
  return first.contentKinds.filter((kind) =>
    snapshots.slice(1).every((snapshot) => snapshot.contentKinds.includes(kind)),
  );
}

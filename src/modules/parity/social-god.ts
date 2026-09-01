import { createHash } from 'node:crypto';

import { z } from 'zod';

const mediaSchema = z.union([
  z.string().min(1),
  z.looseObject({
    id: z.string().optional(),
    url: z.string().optional(),
    mimeType: z.string().optional(),
    altText: z.string().optional(),
  }),
]);

const packageSchema = z.object({
  package_id: z.string().min(1),
  article: z
    .object({
      title: z.string().default(''),
      body: z.string().optional(),
      body_text: z.string().optional(),
    })
    .default({ title: '' }),
  platform_renders: z.record(z.string(), z.unknown()).default({}),
  media_assets: z.array(mediaSchema).default([]),
});

const recordSchema = z.object({
  id: z.union([z.string(), z.number()]),
  item_id: z.union([z.string(), z.number()]).optional(),
  package_id: z.string().optional(),
  platform: z.string().default('x_premium_long'),
  operation: z.string().default('schedule'),
  dry_run: z.boolean().default(true),
  integration_id: z.string().optional(),
  scheduled_for_utc: z.string().optional(),
  scheduled_at: z.string().optional(),
  state: z.string().default('dry_run'),
  external_ids: z.array(z.string()).default([]),
  release_url: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const socialGodSnapshotSchema = z.object({
  packages: z.array(packageSchema).max(500),
  schedule_records: z.array(recordSchema).max(500),
  account_map: z.record(z.string(), z.uuid()),
  media_map: z.record(z.string(), z.uuid()).default({}),
});

type SocialGodSnapshot = z.infer<typeof socialGodSnapshotSchema>;

function stableKey(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function renderFor(
  pkg: SocialGodSnapshot['packages'][number],
  platform: string,
): Record<string, unknown> {
  return asObject(
    pkg.platform_renders[platform] ?? pkg.platform_renders.x_premium_long ?? pkg.platform_renders.x,
  );
}

function contentFor(pkg: SocialGodSnapshot['packages'][number], platform: string) {
  const render = renderFor(pkg, platform);
  const posts = Array.isArray(render.posts)
    ? render.posts.filter((part): part is string => typeof part === 'string')
    : [];
  const text = typeof render.text === 'string' ? render.text : posts.join('\n\n');
  const quotedPostId =
    typeof render.quoted_post_id === 'string'
      ? render.quoted_post_id
      : typeof render.quote_url === 'string'
        ? render.quote_url
        : '';
  if (quotedPostId) return { kind: 'quote', text, quotedPostId };
  if (posts.length > 1) return { kind: 'thread', posts };
  const articleBody = pkg.article.body ?? pkg.article.body_text ?? '';
  if (platform.includes('article'))
    return { kind: 'article', title: pkg.article.title, body: articleBody };
  return { kind: 'text', text: text || articleBody };
}

function mediaIdsFor(
  pkg: SocialGodSnapshot['packages'][number],
  mediaMap: Record<string, string>,
): { ids: string[]; gaps: string[] } {
  const refs = [...pkg.media_assets];
  const render = renderFor(pkg, 'x_premium_long');
  if (Array.isArray(render.media))
    refs.push(
      ...render.media.filter(
        (value): value is z.infer<typeof mediaSchema> =>
          typeof value === 'string' || Boolean(value),
      ),
    );
  const keys = refs
    .map((ref) => (typeof ref === 'string' ? ref : (ref.id ?? ref.url ?? '')))
    .filter(Boolean);
  return {
    ids: keys.flatMap((key) => (mediaMap[key] ? [mediaMap[key]] : [])),
    gaps: keys.filter((key) => !mediaMap[key]).map((key) => `media reference not mapped: ${key}`),
  };
}

export function buildSocialGodParity(raw: unknown) {
  const input = socialGodSnapshotSchema.parse(raw);
  const packages = new Map(input.packages.map((pkg) => [pkg.package_id, pkg]));
  const rows = input.schedule_records.map((record) => {
    const metadataPackageId = record.metadata.package_id;
    const packageId =
      record.package_id ?? (typeof metadataPackageId === 'string' ? metadataPackageId : '');
    const pkg = packages.get(packageId);
    const accountId = input.account_map[record.platform];
    const gaps: string[] = [];
    if (!pkg) gaps.push(`package not found: ${packageId || '(missing package_id)'}`);
    if (!accountId) gaps.push(`target account not mapped for platform: ${record.platform}`);
    const media = pkg ? mediaIdsFor(pkg, input.media_map) : { ids: [], gaps: [] };
    gaps.push(...media.gaps);
    const scheduledAt = record.scheduled_for_utc ?? record.scheduled_at ?? '';
    if (!scheduledAt) gaps.push('scheduled_at missing');
    const idempotencyKey = stableKey([
      'social-god',
      packageId,
      String(record.id),
      record.platform,
      scheduledAt,
    ]);
    return {
      source: {
        packageId,
        scheduleRecordId: String(record.id),
        platform: record.platform,
        operation: record.operation,
      },
      request:
        pkg && accountId && scheduledAt
          ? {
              body: {
                content: contentFor(pkg, record.platform),
                mediaIds: media.ids,
                providerAccountIds: [accountId],
                scheduledAt,
              },
              headers: { 'idempotency-key': idempotencyKey },
              cli: [
                'posts',
                'create',
                '--idempotency-key',
                idempotencyKey,
                '--require-workspace',
                '<workspace>',
              ],
            }
          : null,
      result: {
        sourceState: record.state,
        externalIds: record.external_ids,
        externalUrl: record.release_url ?? null,
        error: record.error ?? null,
      },
      fakeProvider: {
        allowed: true,
        outcome: record.error
          ? 'failed'
          : record.external_ids.length
            ? 'published'
            : 'accepted_pending',
      },
      parity: { matched: gaps.length === 0, gaps },
    };
  });
  return {
    contract: 'publish-relay/social-god-parity-v1',
    mode: 'dry_run',
    credentialsUsed: false,
    externalWritesBlocked: true,
    counts: {
      packages: input.packages.length,
      scheduleRecords: rows.length,
      matched: rows.filter((row) => row.parity.matched).length,
      gaps: rows.filter((row) => !row.parity.matched).length,
    },
    records: rows,
  };
}

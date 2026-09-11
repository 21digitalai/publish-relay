import { z } from 'zod';

const runtimeConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.url().startsWith('postgresql://').optional(),
    WORKER_DATABASE_URL: z.url().startsWith('postgresql://').optional(),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3106),
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
    MEDIA_RETENTION_DAYS: z.coerce.number().int().nonnegative().optional(),
    MEDIA_RETENTION_CLEANUP_INTERVAL_MS: z.coerce.number().int().positive().optional(),
    MEDIA_RETENTION_RETRY_DELAY_MS: z.coerce.number().int().positive().optional(),
    MEDIA_RETENTION_STALE_CLAIM_MS: z.coerce.number().int().positive().optional(),
    MEDIA_RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).optional(),
    MEDIA_STAGING_STALE_MS: z.coerce.number().int().positive().optional(),
    WORKER_ID: z.string().min(1).optional(),
    MEDIA_STORAGE_ROOT: z.string().min(1).optional(),
    MEDIA_VIDEO_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024 * 1024)
      .optional(),
    MEDIA_VIDEO_MAX_DURATION_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(60 * 60 * 1000)
      .optional(),
    MEDIA_VIDEO_MAX_WIDTH: z.coerce.number().int().positive().max(8192).optional(),
    MEDIA_VIDEO_MAX_HEIGHT: z.coerce.number().int().positive().max(8192).optional(),
    CURSOR_SIGNING_SECRET: z.string().min(32).optional(),
    PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION: z.string().min(1).optional(),
    PUBLISH_RELAY_X_CONSUMER_KEY: z.string().min(1).optional(),
    PUBLISH_RELAY_X_CONSUMER_SECRET: z.string().min(1).optional(),
    PUBLISH_RELAY_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    PUBLISH_RELAY_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    X_API_KEY: z.string().min(1).optional(),
    X_API_SECRET: z.string().min(1).optional(),
    PUBLISH_RELAY_APPROVED_LEGACY_X_INTEGRATION_ID: z.string().min(1).optional(),
    PUBLISH_RELAY_PUBLIC_ORIGIN: z.url().optional(),
    PUBLISH_RELAY_HUMAN_AUTH_MODE: z.enum(['password', 'magic_link']).optional(),
    PUBLISH_RELAY_MAGIC_LINK_PEPPER: z.string().min(32).optional(),
    PUBLISH_RELAY_RESEND_API_KEY: z.string().min(1).optional(),
    PUBLISH_RELAY_AUTH_EMAIL_FROM: z.string().email().optional(),
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV !== 'production') return;
    for (const name of [
      'PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION',
      'PUBLISH_RELAY_PUBLIC_ORIGIN',
    ] as const)
      if (!config[name])
        context.addIssue({ code: 'custom', path: [name], message: `${name} is required` });
    if (config.PUBLISH_RELAY_HUMAN_AUTH_MODE === 'magic_link')
      for (const name of [
        'PUBLISH_RELAY_MAGIC_LINK_PEPPER',
        'PUBLISH_RELAY_RESEND_API_KEY',
        'PUBLISH_RELAY_AUTH_EMAIL_FROM',
      ] as const)
        if (!config[name])
          context.addIssue({ code: 'custom', path: [name], message: `${name} is required` });
    if (config.PUBLISH_RELAY_PUBLIC_ORIGIN?.startsWith('https://') !== true)
      context.addIssue({
        code: 'custom',
        path: ['PUBLISH_RELAY_PUBLIC_ORIGIN'],
        message: 'PUBLISH_RELAY_PUBLIC_ORIGIN must use HTTPS',
      });
  });

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return runtimeConfigSchema.parse(environment);
}

export function resolveHumanAuthMode(config: RuntimeConfig): 'password' | 'magic_link' {
  return config.PUBLISH_RELAY_HUMAN_AUTH_MODE ?? 'password';
}

export function resolveWorkerDatabaseUrl(config: RuntimeConfig): string {
  const databaseUrl =
    config.WORKER_DATABASE_URL ??
    (config.NODE_ENV === 'production' ? undefined : config.DATABASE_URL);
  if (!databaseUrl)
    throw new Error(
      config.NODE_ENV === 'production'
        ? 'WORKER_DATABASE_URL is required for the production worker'
        : 'WORKER_DATABASE_URL or DATABASE_URL is required for the worker',
    );
  return databaseUrl;
}

export function resolveXProviderCredentials(
  config: RuntimeConfig,
): { consumerKey: string; consumerSecret: string } | null {
  const current = {
    consumerKey: config.PUBLISH_RELAY_X_CONSUMER_KEY,
    consumerSecret: config.PUBLISH_RELAY_X_CONSUMER_SECRET,
  };
  const legacy = { consumerKey: config.X_API_KEY, consumerSecret: config.X_API_SECRET };
  const currentPartial = Boolean(current.consumerKey) !== Boolean(current.consumerSecret);
  const legacyPartial = Boolean(legacy.consumerKey) !== Boolean(legacy.consumerSecret);
  if (currentPartial || legacyPartial)
    throw new Error('X provider credentials must configure both values in the same namespace');
  if (current.consumerKey && current.consumerSecret)
    return { consumerKey: current.consumerKey, consumerSecret: current.consumerSecret };
  if (legacy.consumerKey && legacy.consumerSecret)
    return { consumerKey: legacy.consumerKey, consumerSecret: legacy.consumerSecret };
  return null;
}

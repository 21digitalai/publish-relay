import { z } from 'zod';

const runtimeConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.url().startsWith('postgresql://').optional(),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
    WORKER_ID: z.string().min(1).optional(),
    MEDIA_STORAGE_ROOT: z.string().min(1).optional(),
    CURSOR_SIGNING_SECRET: z.string().min(32).optional(),
    PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION: z.string().min(1).optional(),
    PUBLISH_RELAY_X_CONSUMER_KEY: z.string().min(1).optional(),
    PUBLISH_RELAY_X_CONSUMER_SECRET: z.string().min(1).optional(),
    PUBLISH_RELAY_PUBLIC_ORIGIN: z.url().optional(),
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV !== 'production') return;
    for (const name of [
      'PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION',
      'PUBLISH_RELAY_X_CONSUMER_KEY',
      'PUBLISH_RELAY_X_CONSUMER_SECRET',
      'PUBLISH_RELAY_PUBLIC_ORIGIN',
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

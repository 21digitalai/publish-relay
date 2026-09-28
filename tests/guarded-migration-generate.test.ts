import { describe, expect, it } from 'vitest';

import { assertSafeGeneratedMigration } from '../scripts/guarded-migration-generate.mjs';

describe('generated migration safety', () => {
  it('rejects the destructive drift found after migration 0042', () => {
    expect(() => {
      assertSafeGeneratedMigration('DROP TABLE "x_thread_parts" CASCADE;', 'generated.sql');
    }).toThrow('Unsafe generated migration');
    expect(() => {
      assertSafeGeneratedMigration('DROP TYPE "public"."publication_job_state";', 'generated.sql');
    }).toThrow('Unsafe generated migration');
    expect(() => {
      assertSafeGeneratedMigration(
        'CREATE TYPE "public"."publication_job_state" AS ENUM();',
        'generated.sql',
      );
    }).toThrow('Unsafe generated migration');
  });

  it('allows an additive migration', () => {
    expect(() => {
      assertSafeGeneratedMigration(
        'ALTER TABLE provider_connections ADD COLUMN expires_at timestamptz;',
        'safe.sql',
      );
    }).not.toThrow();
  });
});

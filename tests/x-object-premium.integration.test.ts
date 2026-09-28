import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { expect, it, vi } from 'vitest';

vi.mock('../src/modules/credentials/credential.repository.js', () => ({
  getActiveCredential: vi.fn(() => Promise.resolve({ id: 'credential' })),
}));
vi.mock('../src/modules/credentials/envelope.js', () => ({
  decryptCredential: vi.fn(() => Promise.resolve(Buffer.from('{}'))),
}));

import { dispatchDueXJobs } from '../src/modules/providers/x-media-dispatch.service.js';
import type { XMediaUploadClient } from '../src/modules/providers/x-media-staging.service.js';
import type { XClient } from '../src/modules/providers/x-adapter.js';

const migrations = [
  '0000_identity_tenancy.sql',
  '0001_solid_spiral.sql',
  '0002_busy_mantis.sql',
  '0003_many_marvel_boy.sql',
  '0004_easy_doctor_spectrum.sql',
  '0005_round_thunderball.sql',
  '0006_enforce_content_workspace_foreign_keys.sql',
  '0007_add_scheduler_attempt_ledger.sql',
  '0008_handy_shen.sql',
  '0014_great_lethal_legion.sql',
  '0015_talented_alex_power.sql',
  '0016_common_barracuda.sql',
  '0017_dark_whizzer.sql',
  '0018_membership_identity_scope.sql',
  '0019_media_retention_lifecycle.sql',
  '0022_truthful_post_actors.sql',
  '0024_mp4_media_metadata.sql',
  '0025_lucky_legion.sql',
  '0026_parallel_human_cannonball.sql',
  '0027_overjoyed_dark_beast.sql',
];
const workspaceId = '00000000-0000-4000-8000-000000000501';
const jobId = '00000000-0000-4000-8000-000000000508';

it('claims persisted object-post content and publishes one X Premium post with staged media', async () => {
  const database = new PGlite();
  try {
    for (const migration of migrations) {
      await database.exec(
        await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'),
      );
    }
    await database.exec(`
      INSERT INTO workspaces (id, name, slug) VALUES ('${workspaceId}', 'Premium', 'premium');
      INSERT INTO users (id, email, password_hash)
        VALUES ('00000000-0000-4000-8000-000000000502', 'premium@example.test', 'redacted');
      SELECT set_config('app.workspace_id', '${workspaceId}', false);
      INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
        wrapped_key_tag, ciphertext, nonce, tag)
        VALUES ('00000000-0000-4000-8000-000000000503', '${workspaceId}', 'v1',
          '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
      INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
        VALUES ('00000000-0000-4000-8000-000000000504', '${workspaceId}', 'x',
          '00000000-0000-4000-8000-000000000503');
      INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id, display_name)
        VALUES ('00000000-0000-4000-8000-000000000505', '${workspaceId}',
          '00000000-0000-4000-8000-000000000504', 'x-premium', 'Premium');
      INSERT INTO posts (id, workspace_id, created_by_user_id)
        VALUES ('00000000-0000-4000-8000-000000000506', '${workspaceId}',
          '00000000-0000-4000-8000-000000000502');
      INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
        VALUES ('00000000-0000-4000-8000-000000000507', '${workspaceId}',
          '00000000-0000-4000-8000-000000000506', 1,
          '{"kind":"thread","posts":[{"text":"Opening","mediaIds":["00000000-0000-4000-8000-000000000509"]},{"text":"Closing","mediaIds":[]}]}');
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
        VALUES ('00000000-0000-4000-8000-000000000509', '${workspaceId}',
          'premium/media', 'hash', 'image/png', 1, 'ready');
      INSERT INTO revision_media (workspace_id, revision_id, media_id, position)
        VALUES ('${workspaceId}', '00000000-0000-4000-8000-000000000507',
          '00000000-0000-4000-8000-000000000509', 0);
      INSERT INTO publication_jobs (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at)
        VALUES ('${jobId}', '${workspaceId}', '00000000-0000-4000-8000-000000000506',
          '00000000-0000-4000-8000-000000000507',
          '00000000-0000-4000-8000-000000000505', '2026-09-01T00:00:00Z');
    `);
    const db = drizzle(database) as unknown as NodePgDatabase;
    const createPost = vi.fn(() => Promise.resolve({ id: 'x-post-1', username: 'premium' }));
    const client = {
      init: () => Promise.resolve({ mediaId: 'x-media-1', expiresAfterSeconds: 3600 }),
      append: () => Promise.resolve(),
      finalize: () => Promise.resolve({ state: 'succeeded' as const }),
      status: () => Promise.resolve({ state: 'not_finalized' as const }),
      discard: () => Promise.resolve(),
      createPost,
    } as unknown as XMediaUploadClient & XClient;
    const dispatched = await dispatchDueXJobs(
      {
        database: db,
        keys: {} as never,
        source: { load: () => Promise.resolve({ bytes: Buffer.from('x'), mimeType: 'image/png' }) },
        createClient: () => client,
        workerId: 'premium-worker',
        leaseMs: 30_000,
      },
      new Date('2026-09-02T00:00:00Z'),
    );
    expect(dispatched).toBe(1);
    expect(createPost).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Opening\n\nClosing',
        mediaIds: ['x-media-1'],
      }),
    );
    const result = await database.query<{ state: string; attempts: number }>(`
      SELECT j.state, count(a.id)::int AS attempts FROM publication_jobs j
      LEFT JOIN publication_attempts a ON a.job_id = j.id WHERE j.id = '${jobId}'
      GROUP BY j.state`);
    expect(result.rows[0]).toMatchObject({ state: 'published', attempts: 1 });
  } finally {
    await database.close();
  }
});

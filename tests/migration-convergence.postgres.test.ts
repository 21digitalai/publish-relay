import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { describe, expect, it } from 'vitest';
import {
  assertKnownHistoryLedger,
  assertKnownHistorySchema,
  assertKnownHistoryTransition,
} from '../deploy/known-history-transition.mjs';

const adminUrl = process.env.MIGRATION_CONVERGENCE_TEST_URL;
const psql = process.env.MIGRATION_CONVERGENCE_PSQL ?? 'psql';
const target = process.cwd();
const predecessor = 'b194d588';
const divergent = '1dd6f3e8b50c710da001b772c2ed8bd44df77294';

function sourceAt(commit: string, directory: string) {
  const archive = execFileSync('git', ['archive', commit], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  symlinkSync(resolve('node_modules'), join(directory, 'node_modules'));
}

async function ledger(pool: pg.Pool) {
  return (
    await pool.query<{ hash: string; created_at: string }>(
      'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id',
    )
  ).rows;
}

function bootstrap(url: string) {
  execFileSync(psql, [
    url,
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '-f',
    'deploy/bootstrap-database-authorities.sql',
  ]);
}

async function seedInstagram(pool: pg.Pool) {
  const workspace = (await pool.query<{ id: string }>('SELECT id FROM workspaces LIMIT 1')).rows[0]
    ?.id;
  const user = (await pool.query<{ id: string }>('SELECT id FROM users LIMIT 1')).rows[0]?.id;
  await pool.query(
    "UPDATE users SET review_access_expires_at=now() + interval '1 day' WHERE id=$1",
    [user],
  );
  await pool.query("UPDATE memberships SET role='editor' WHERE user_id=$1", [user]);
  const credential = (
    await pool.query<{ id: string }>(
      `INSERT INTO credentials
    (workspace_id,key_version,wrapped_key,wrapped_key_nonce,wrapped_key_tag,ciphertext,nonce,tag)
    VALUES ($1,'qa','x','x','x','x','x','x') RETURNING id`,
      [workspace],
    )
  ).rows[0]?.id;
  const connection = (
    await pool.query<{ id: string }>(
      `INSERT INTO provider_connections
    (workspace_id,provider,credential_id) VALUES ($1,'instagram',$2) RETURNING id`,
      [workspace, credential],
    )
  ).rows[0]?.id;
  const account = (
    await pool.query<{ id: string }>(
      `INSERT INTO provider_accounts
    (workspace_id,connection_id,provider_account_id,display_name,destination_provider,remote_account_id)
    VALUES ($1,$2,'qa-instagram','QA','instagram','qa-instagram') RETURNING id`,
      [workspace, connection],
    )
  ).rows[0]?.id;
  const tables = (
    await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'instagram_unified_%'",
    )
  ).rows;
  for (const { tablename } of tables) {
    if (tablename === 'instagram_unified_dm_no_go') {
      await pool.query(
        'INSERT INTO instagram_unified_dm_no_go (workspace_id,account_id,conversation_id) VALUES ($1,$2,$3)',
        [workspace, account, 'retained-thread'],
      );
    } else {
      const columns =
        tablename === 'instagram_unified_pending_intents' ? ',due_at,target_fingerprint' : '';
      const values = columns ? ",now() + interval '1 day','context'" : '';
      await pool.query(
        `INSERT INTO ${tablename}
        (workspace_id,account_id,client_action_id,kind,target_id,parent_id,text_body,request_fingerprint,actor_type,actor_id${columns})
        VALUES ($1,$2,$3,'dm_reply','retained-target','retained-parent','retained text','fingerprint','user',$4${values})`,
        [workspace, account, randomUUID(), user],
      );
    }
  }
  return tables.map(({ tablename }) => tablename);
}

function runtimeProbe(
  source: string,
  url: string,
  email: string,
  register = false,
  reviewer = false,
) {
  const script = `
    import {createCoreRuntime} from './src/application/create-runtime-options.ts';
    import {createStandaloneApplication} from './src/application/create-application.ts';
    import {loadRuntimeConfig} from './src/config/runtime-config.ts';
    const runtime=await createCoreRuntime(loadRuntimeConfig());
    const app=createStandaloneApplication(runtime.options);
    try {
      const auth=runtime.options.auth;
      if (${String(register)}) await auth.register('Migration QA', ${JSON.stringify(email)}, 'Migration-QA-only-password-123', 'Migration QA');
      const session=await auth[${JSON.stringify(reviewer ? 'loginReviewer' : 'login')}](${JSON.stringify(email)}, 'Migration-QA-only-password-123');
      if (!session) throw new Error('Persisted user login failed');
      const response=await app.inject('/health/ready');
      if(response.statusCode!==200) throw new Error('Application readiness failed');
      console.log('login and readiness PASS');
    } finally { await app.close(); await runtime.close(); }
  `;
  return execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: source,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: url,
      NODE_ENV: 'test',
      PUBLISH_RELAY_ENABLED_ADAPTERS: '',
      PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION: 'qa',
      PUBLISH_RELAY_MASTER_KEY_qa: Buffer.alloc(32, 7).toString('base64'),
      MEDIA_STORAGE_ROOT: join(source, 'media'),
      CURSOR_SIGNING_SECRET: 'disposable-migration-qa-cursor-secret-only',
    },
    timeout: 30000,
  });
}

describe.skipIf(!adminUrl)('real PostgreSQL canonical migration convergence', () => {
  it.each(['old', 'main', 'old-main'] as const)(
    'preserves seeded %s installation and old application rollback',
    async (history) => {
      const url = new URL(adminUrl ?? '');
      if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.endsWith('_test'))
        throw new Error('Disposable local *_test administrator database required');
      const root = mkdtempSync(join(tmpdir(), 'relay-convergence-'));
      const old = join(root, 'old');
      const main = join(root, 'main');
      cpSync(target, old, { recursive: true, filter: (path) => path === target });
      cpSync(target, main, { recursive: true, filter: (path) => path === target });
      sourceAt(predecessor, old);
      sourceAt(divergent, main);
      const name = 'relay_convergence_' + randomUUID().replaceAll('-', '');
      const admin = new pg.Pool({ connectionString: url.href });
      await admin
        .query('CREATE ROLE publish_relay_web NOLOGIN NOBYPASSRLS')
        .catch((error: unknown) => {
          if (!(error instanceof pg.DatabaseError) || error.code !== '42710') throw error;
        });
      await admin
        .query('CREATE ROLE publish_relay_worker NOLOGIN BYPASSRLS')
        .catch((error: unknown) => {
          if (!(error instanceof pg.DatabaseError) || error.code !== '42710') throw error;
        });
      await admin.query('CREATE DATABASE ' + name);
      url.pathname = '/' + name;
      const pool = new pg.Pool({ connectionString: url.href, max: 1 });
      const initial = history === 'main' ? main : old;
      const email = history + '@migration.example.test';
      try {
        await migrate(drizzle(pool), { migrationsFolder: join(initial, 'migrations') });
        if (history === 'old-main')
          await migrate(drizzle(pool), { migrationsFolder: join(main, 'migrations') });
        bootstrap(url.href);
        expect(runtimeProbe(initial, url.href, email, true)).toContain('login and readiness PASS');
        const seeded = await seedInstagram(pool);
        const before = await ledger(pool);
        const guard = (source: string) =>
          execFileSync(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              "import {assertAppendOnlyMigrations} from './deploy/migration-compatibility.mjs'; assertAppendOnlyMigrations(process.argv[1], process.argv[2]);",
              source,
              target,
            ],
            { stdio: 'pipe' },
          );
        guard(old);
        expect(() => guard(main)).toThrow();
        if (history !== 'old') {
          assertKnownHistoryTransition(main, target, 'main-20261127');
          assertKnownHistoryLedger(before);
          expect(() => {
            assertKnownHistoryTransition(main, main, 'main-20261127');
          }).toThrow('exact source/target');
          const sqlPath = join(main, 'migrations/0131_instagram_unified_actions.sql');
          const sql = readFileSync(sqlPath);
          writeFileSync(sqlPath, Buffer.concat([sql, Buffer.from('\n-- changed')]));
          expect(() => {
            assertKnownHistoryTransition(main, target, 'main-20261127');
          }).toThrow('exact source/target');
          writeFileSync(sqlPath, sql);
        }
        const runTarget = () =>
          execFileSync(process.execPath, ['dist/database/migrate.js'], {
            cwd: target,
            env: {
              ...process.env,
              DATABASE_URL: url.href,
              PUBLISH_RELAY_MIGRATION_TRANSITION: history === 'old' ? '' : 'main-20261127',
              PUBLISH_RELAY_MIGRATION_SOURCE: main,
            },
            timeout: 30000,
          });
        runTarget();
        const after = await ledger(pool);
        expect(after.slice(0, before.length)).toEqual(before);
        expect(after).toHaveLength(before.length + 4);
        runTarget();
        expect(await ledger(pool)).toEqual(after);
        if (history !== 'old') assertKnownHistoryLedger(after);
        bootstrap(url.href);
        for (const table of seeded) {
          expect(
            (await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`))
              .rows[0]?.count,
          ).toBe(1);
        }
        await pool.query('SET ROLE publish_relay_web');
        expect(
          (
            await pool.query<{ count: number }>(
              'SELECT count(*)::int AS count FROM instagram_unified_dm_no_go',
            )
          ).rows[0]?.count,
        ).toBe(0);
        await pool.query('RESET ROLE');
        const authority = await pool.query<{ allowed: boolean; media: boolean }>(`SELECT
          has_function_privilege('publish_relay_web','public.resolve_exposed_post_accounts(uuid,uuid[],boolean)','EXECUTE') AS allowed,
          position('content:write' in pg_get_functiondef('public.resolve_exposed_post_accounts(uuid,uuid[],boolean)'::regprocedure))>0 AS media`);
        expect(authority.rows[0]).toEqual({ allowed: true, media: true });
        expect(runtimeProbe(target, url.href, email, false, true)).toContain(
          'login and readiness PASS',
        );
        expect(runtimeProbe(initial, url.href, email, false, true)).toContain(
          'login and readiness PASS',
        );
        const rls = await pool.query<{
          relname: string;
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
        }>(
          "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('instagram_unified_actions','instagram_unified_pending_intents','instagram_unified_dm_no_go')",
        );
        expect(rls.rows).toHaveLength(3);
        expect(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
        const repair = readFileSync('migrations/0133_instagram_unified_actions.sql', 'utf8');
        await pool.query('BEGIN');
        await pool.query('ALTER TABLE instagram_unified_actions ADD COLUMN unexpected text');
        await expect(assertKnownHistorySchema(pool, after)).rejects.toThrow(
          'incompatible instagram_unified_actions',
        );
        await expect(pool.query(repair)).rejects.toThrow('Incompatible instagram_unified_actions');
        await pool.query('ROLLBACK');
        expect(await ledger(pool)).toEqual(after);
      } finally {
        await pool.end();
        await admin.query('DROP DATABASE ' + name + ' WITH (FORCE)');
        await admin.end();
        rmSync(root, { recursive: true, force: true });
      }
    },
    120000,
  );
});

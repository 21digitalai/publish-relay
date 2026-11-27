import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migration = new URL(
  '../migrations/0136_catch_up_reviewer_and_media_admission.sql',
  import.meta.url,
);

describe('divergent reviewer and media migration catch-up', () => {
  it('preserves users, enforces reviewer expiry and reruns safely', async () => {
    const db = new PGlite();
    try {
      await db.exec(
        "CREATE TABLE users (id integer PRIMARY KEY, password_hash text); INSERT INTO users VALUES (1, NULL), (2, 'hash');",
      );
      const sql = await readFile(migration, 'utf8');
      await db.exec(sql);
      await db.exec(sql);
      expect((await db.query('SELECT id FROM users ORDER BY id')).rows).toEqual([
        { id: 1 },
        { id: 2 },
      ]);
      await expect(
        db.exec('UPDATE users SET review_access_expires_at=now() WHERE id=1'),
      ).rejects.toThrow();
      await db.exec('UPDATE users SET review_access_expires_at=now() WHERE id=2');
      const result = await db.query<{ enabled: boolean }>(
        "SELECT position('content:write' in pg_get_functiondef('public.resolve_exposed_post_accounts(uuid,uuid[],boolean)'::regprocedure)) > 0 AS enabled",
      );
      expect(result.rows[0]?.enabled).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('rejects an incompatible pre-existing expiry column', async () => {
    const db = new PGlite();
    try {
      await db.exec('CREATE TABLE users (password_hash text, review_access_expires_at text)');
      await expect(db.exec(await readFile(migration, 'utf8'))).rejects.toThrow('Incompatible');
    } finally {
      await db.close();
    }
  });
});

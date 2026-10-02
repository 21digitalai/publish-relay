import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('../migrations/0055_x_long_post_declaration.sql', import.meta.url);

describe('X long-post declaration migration', () => {
  it.each(['fresh', 'upgrade'] as const)('defaults %s and legacy accounts to off', async (mode) => {
    const database = new PGlite();
    try {
      await database.exec('CREATE TABLE provider_accounts (id integer PRIMARY KEY)');
      if (mode === 'upgrade') await database.exec('INSERT INTO provider_accounts (id) VALUES (1)');
      await database.exec(await readFile(migrationUrl, 'utf8'));
      await database.exec('INSERT INTO provider_accounts (id) VALUES (2)');
      const rows = await database.query<{ id: number; x_long_posts_allowed: boolean }>(
        'SELECT id, x_long_posts_allowed FROM provider_accounts ORDER BY id',
      );
      expect(rows.rows).toEqual(
        mode === 'upgrade'
          ? [
              { id: 1, x_long_posts_allowed: false },
              { id: 2, x_long_posts_allowed: false },
            ]
          : [{ id: 2, x_long_posts_allowed: false }],
      );
      await expect(
        database.exec('UPDATE provider_accounts SET x_long_posts_allowed = NULL WHERE id = 2'),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
});

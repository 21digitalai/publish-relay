import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Core migration journal', () => {
  it('registers every SQL migration exactly once', async () => {
    const migrations = (await readdir(new URL('../migrations/', import.meta.url)))
      .filter((name) => /^\d{4}_.*\.sql$/.test(name))
      .map((name) => name.slice(0, -4))
      .sort();
    const journal = JSON.parse(
      await readFile(new URL('../migrations/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.map((entry) => entry.tag).sort()).toEqual(migrations);
  });
});

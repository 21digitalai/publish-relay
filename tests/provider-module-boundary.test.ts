import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const genericRoots = [
  new URL('../src/modules/content/', import.meta.url),
  new URL('../src/modules/scheduler/', import.meta.url),
];

describe('provider module boundary', () => {
  it('keeps Meta-specific imports out of generic content and scheduler modules', async () => {
    for (const root of genericRoots) {
      const files = (await readdir(root, { recursive: true })).filter((name) =>
        name.endsWith('.ts'),
      );
      for (const file of files) {
        const source = await readFile(new URL(file, root), 'utf8');
        expect(source).not.toMatch(/from ['"][^'"]*meta(?:\/|-)/);
      }
    }
  });
});

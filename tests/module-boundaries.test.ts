import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
      return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

describe('module boundaries', () => {
  it('prevents imports of another module persistence internals', async () => {
    const moduleRoot = path.resolve('src/modules');
    const files = await collectTypeScriptFiles(moduleRoot);
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const owner = path.relative(moduleRoot, file).split(path.sep)[0] ?? '';
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const importedPath = match[1] ?? '';
        if (importedPath.includes('/infrastructure/') && !importedPath.includes(`/${owner}/`))
          violations.push(`${file}: ${importedPath}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

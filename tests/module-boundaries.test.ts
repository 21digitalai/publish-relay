import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
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
  async function findViolations(moduleRoot: string): Promise<string[]> {
    const files = await collectTypeScriptFiles(moduleRoot);
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const owner = path.relative(moduleRoot, file).split(path.sep)[0] ?? '';
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const importedPath = match[1] ?? '';
        const aliasMatch = /^@modules\/([^/]+)\/infrastructure(?:\/|$)/.exec(importedPath);
        const resolvedImport = importedPath.startsWith('.')
          ? path.resolve(path.dirname(file), importedPath)
          : '';
        const relativeMatch = path
          .relative(moduleRoot, resolvedImport)
          .split(path.sep)
          .filter(Boolean);
        const importedOwner = aliasMatch?.[1] ?? relativeMatch[0];
        const importsInfrastructure = aliasMatch !== null || relativeMatch[1] === 'infrastructure';
        if (importsInfrastructure && importedOwner !== owner)
          violations.push(`${file}: ${importedPath}`);
      }
    }
    return violations;
  }

  it('rejects another module infrastructure while allowing public and owned imports', async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'publish-relay-boundaries-'));
    const moduleRoot = path.join(fixtureRoot, 'modules');
    try {
      await mkdir(path.join(moduleRoot, 'accounts', 'infrastructure'), { recursive: true });
      await mkdir(path.join(moduleRoot, 'publishing', 'infrastructure'), { recursive: true });
      await writeFile(
        path.join(moduleRoot, 'accounts', 'infrastructure', 'adapter.ts'),
        "export const adapter = 'accounts';\n",
      );
      await writeFile(
        path.join(moduleRoot, 'publishing', 'allowed.ts'),
        "import { account } from '@modules/accounts';\nimport { repository } from './infrastructure/repository.js';\n",
      );
      await writeFile(
        path.join(moduleRoot, 'publishing', 'forbidden-alias.ts'),
        "import { adapter } from '@modules/accounts/infrastructure/adapter.js';\n",
      );
      await writeFile(
        path.join(moduleRoot, 'publishing', 'forbidden-relative.ts'),
        "import { adapter } from '../accounts/infrastructure/adapter.js';\n",
      );

      const violations = await findViolations(moduleRoot);

      expect(violations).toHaveLength(2);
      expect(violations).toEqual(
        expect.arrayContaining([
          expect.stringContaining('@modules/accounts/infrastructure/adapter.js'),
          expect.stringContaining('../accounts/infrastructure/adapter.js'),
        ]),
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('keeps the application source free of cross-module infrastructure imports', async () => {
    await expect(findViolations(path.resolve('src/modules'))).resolves.toEqual([]);
  });
});

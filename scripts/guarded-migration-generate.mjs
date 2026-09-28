import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDir = join(projectRoot, 'migrations');

export function assertSafeGeneratedMigration(sql, file) {
  const forbidden = [
    /\bDROP\s+TABLE\s+(?:"?public"?\.)?"?x_thread_parts"?\s+CASCADE\b/i,
    /\bDROP\s+TYPE\s+(?:"?public"?\.)?"?publication_job_state"?\b/i,
    /\bCREATE\s+TYPE\s+(?:"?public"?\.)?"?publication_job_state"?\b/i,
  ];
  if (forbidden.some((pattern) => pattern.test(sql)))
    throw new Error(
      `Unsafe generated migration ${file}: legacy table drop or job-state enum rebuild`,
    );
}

function main() {
  const before = new Set(readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')));
  const result = spawnSync(join(projectRoot, 'node_modules/.bin/drizzle-kit'), ['generate'], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'))) {
    if (before.has(file)) continue;
    assertSafeGeneratedMigration(readFileSync(join(migrationsDir, file), 'utf8'), file);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

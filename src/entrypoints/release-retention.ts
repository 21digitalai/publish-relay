import { readFileSync } from 'node:fs';
import { assessmentManifest } from '../modules/operations/release-assessment.js';
import { inspectReleaseInventory } from '../modules/operations/release-inventory.js';
import { retentionManifest } from '../modules/operations/release-retention.js';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function run(args: string[]): unknown {
  const [command, first, second, third] = args;
  if (command === 'assessment' && first && args.length === 2) {
    return assessmentManifest(readJson(first));
  }
  if (command === 'inspect' && first && args.length === 2) {
    return inspectReleaseInventory(first);
  }
  if (command === 'plan' && first && second && third && args.length === 4) {
    return retentionManifest({
      inventory: readJson(first),
      evidence: readJson(second),
      freshInventory: readJson(third),
    });
  }
  throw new Error(
    'Usage (read-only): release-retention assessment <historical.json> | inspect <absolute-root/releases> | plan <inventory.json> <evidence.json> <fresh-inventory.json>. No apply command exists.',
  );
}

try {
  const result = run(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (
    typeof result === 'object' &&
    result !== null &&
    'status' in result &&
    result.status === 'blocked'
  ) {
    process.exitCode = 2;
  }
} catch {
  // Do not echo arbitrary JSON/paths or nested validator payloads from untrusted files.
  process.stderr.write(
    'Release retention refused: invalid input, unsafe filesystem/runtime, or unsupported command. Use assessment <file>, inspect <absolute-root/releases>, or plan <inventory> <evidence> <fresh-inventory>; apply is unavailable.\n',
  );
  process.exitCode = 1;
}

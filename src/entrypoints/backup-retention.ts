import { readFileSync } from 'node:fs';
import { inspectBackups } from '../modules/operations/backup-inventory.js';
import { backupManifest } from '../modules/operations/backup-retention.js';

try {
  const [command, directory, pinsFile, extra] = process.argv.slice(2);
  if (command !== 'inspect' || !directory || !pinsFile || extra) throw new Error('Usage');
  const inventory = await inspectBackups(directory);
  const pins = JSON.parse(readFileSync(pinsFile, 'utf8')) as unknown;
  process.stdout.write(
    JSON.stringify(backupManifest({ ...inventory, pins, now: new Date() }), null, 2) + '\n',
  );
} catch {
  process.stderr.write(
    'Backup retention refused. Usage (read-only): backup-retention inspect <absolute-backup-directory> <pins.json>. No apply command exists.\n',
  );
  process.exitCode = 1;
}

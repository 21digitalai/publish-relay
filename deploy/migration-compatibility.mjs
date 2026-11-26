import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

function requireCondition(condition) {
  if (!condition)
    throw new Error('Migration set changes: invalid or non-append-only migration history');
}

function readFiles(directory, prefix = '', files = new Map()) {
  const root = lstatSync(directory);
  requireCondition(root.isDirectory() && !root.isSymbolicLink());
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const relative = prefix + name;
    const stat = lstatSync(path);
    requireCondition(stat.dev === root.dev && !stat.isSymbolicLink());
    if (stat.isDirectory()) {
      requireCondition(prefix === '' && name === 'meta');
      readFiles(path, 'meta/', files);
    } else {
      requireCondition(stat.isFile() && stat.nlink === 1);
      requireCondition(
        /^[0-9]{4}_[a-z0-9_]+\.sql$/.test(relative) ||
          /^meta\/(?:_journal|[0-9]{4}_snapshot)\.json$/.test(relative),
      );
      const bytes = readFileSync(path);
      const text = bytes.toString('utf8');
      requireCondition(bytes.equals(Buffer.from(text, 'utf8')));
      files.set(relative, text);
    }
  }
  return files;
}

function readJournal(files) {
  if (files.size === 0) return { version: '7', dialect: 'postgresql', entries: [] };
  let journal;
  try {
    journal = JSON.parse(files.get('meta/_journal.json'));
  } catch {
    requireCondition(false);
  }
  requireCondition(
    journal &&
      journal.version === '7' &&
      journal.dialect === 'postgresql' &&
      Array.isArray(journal.entries),
  );
  const tags = new Set();
  journal.entries.forEach((entry, index) => {
    requireCondition(
      entry &&
        entry.idx === index &&
        entry.version === journal.version &&
        Number.isSafeInteger(entry.when) &&
        entry.when > 0 &&
        typeof entry.breakpoints === 'boolean' &&
        typeof entry.tag === 'string' &&
        /^[0-9]{4}_[a-z0-9_]+$/.test(entry.tag) &&
        Number(entry.tag.slice(0, 4)) === entry.idx &&
        !tags.has(entry.tag),
    );
    requireCondition(files.has(entry.tag + '.sql'));
    tags.add(entry.tag);
  });
  requireCondition([...files.keys()].filter((name) => name.endsWith('.sql')).length === tags.size);
  return journal;
}

// History is immutable. Legacy timestamp anomalies remain immutable too; new
// entries must advance beyond the maximum installed timestamp, not just the tail.
export function assertAppendOnlyMigrations(installed, candidate) {
  const nextFiles = readFiles(join(candidate, 'migrations'));
  const oldFiles = installed ? readFiles(join(installed, 'migrations')) : new Map();
  const next = readJournal(nextFiles);
  const old = readJournal(oldFiles);
  requireCondition(isDeepStrictEqual({ ...old, entries: [] }, { ...next, entries: [] }));
  requireCondition(next.entries.length >= old.entries.length);
  requireCondition(isDeepStrictEqual(next.entries.slice(0, old.entries.length), old.entries));
  for (const [name, content] of oldFiles) {
    if (name !== 'meta/_journal.json') requireCondition(nextFiles.get(name) === content);
  }
  let timestamp = Math.max(0, ...old.entries.map((entry) => entry.when));
  for (const entry of next.entries.slice(old.entries.length)) {
    requireCondition(!installed || entry.when > timestamp);
    timestamp = entry.when;
  }
  const added = next.entries.slice(old.entries.length);
  for (const name of nextFiles.keys()) {
    if (oldFiles.has(name) || name === 'meta/_journal.json') continue;
    if (name.endsWith('.sql')) requireCondition(added.some((entry) => name === entry.tag + '.sql'));
    else {
      requireCondition(
        added.some(
          (entry) => name === 'meta/' + String(entry.idx).padStart(4, '0') + '_snapshot.json',
        ),
      );
      try {
        const snapshot = JSON.parse(nextFiles.get(name));
        const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
        requireCondition(
          snapshot.version === '7' &&
            snapshot.dialect === 'postgresql' &&
            uuid.test(snapshot.id) &&
            uuid.test(snapshot.prevId) &&
            snapshot.tables &&
            typeof snapshot.tables === 'object' &&
            !Array.isArray(snapshot.tables),
        );
      } catch {
        requireCondition(false);
      }
    }
  }
  if (installed && added.length === 0)
    requireCondition(isDeepStrictEqual([...oldFiles].sort(), [...nextFiles].sort()));
}

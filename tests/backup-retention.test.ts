import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { backupManifest, captureTime, DAY_MS } from '../src/modules/operations/backup-retention.js';
import type { BackupEntry } from '../src/modules/operations/backup-retention.js';
import { inspectBackups } from '../src/modules/operations/backup-inventory.js';

const now = new Date('2026-09-15T12:00:00Z');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function entry(age: number, hour = 10): BackupEntry {
  const captured = new Date(now.getTime() - age * DAY_MS);
  captured.setUTCHours(hour, 0, 0, 0);
  const stamp = captured.toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z');
  const name = `publish-relay-${stamp}.dump.age`;
  return {
    name,
    path: '/fixture/' + name,
    bytes: 12,
    sha256: 'a'.repeat(64),
    capturedAt: captureTime(name),
    verified: true,
    reason: 'fixture validated archive',
  };
}
function manifest(entries: BackupEntry[], pins: unknown = []) {
  return backupManifest({ root: '/fixture', entries, pins, now });
}
function diskFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-backup-policy-')));
  roots.push(root);
  return root;
}
function writeBackup(root: string, age: number) {
  const value = entry(age);
  const content = Buffer.from('fixture encrypted bytes');
  writeFileSync(join(root, value.name), content);
  writeFileSync(
    join(root, value.name + '.verified.json'),
    JSON.stringify({
      version: 1,
      file: value.name,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      validation: 'pg-restore-full-and-age-roundtrip',
      validatedAt: now.toISOString(),
    }),
  );
  return value.name;
}

describe('UTC backup recovery coverage proposals', () => {
  it('keeps cold-start and sparse history instead of choosing five newest', () => {
    for (const ages of [[], [0], [0, 1, 2], [0, 1, 2, 7], [0, 1, 2, 30], [0, 7, 30]]) {
      const result = manifest(ages.map((age) => entry(age)));
      expect(result.status).toBe('coverage-incomplete');
      expect(result.candidatePaths).toEqual([]);
      expect(result.approvedDeletePaths).toEqual([]);
    }
  });
  it('selects three UTC days, aged week/month, bridges, and unlimited explicit pins', () => {
    const values = Array.from({ length: 46 }, (_, age) => entry(age));
    const pin = entry(45);
    const result = manifest(values, [{ file: pin.name, reason: 'pre-migration restore point' }]);
    const keeps = result.entries
      .filter((value) => value.disposition === 'keep')
      .map((value) => value.name);
    expect(keeps).toEqual([0, 1, 2, 6, 7, 29, 30, 45].map((age) => entry(age).name));
    expect(result.approvedDeletePaths).toEqual([]);
    expect(result.candidatePaths).toContain(entry(44).path);
  });
  it('uses latest successful duplicate on a day, never a corrupt or future point', () => {
    const older = entry(0, 8);
    const corrupt = { ...entry(0, 11), verified: false, reason: 'invalid archive' };
    const future = entry(-1);
    const result = manifest([
      older,
      entry(0),
      corrupt,
      future,
      ...[1, 2, 6, 7, 29, 30].map((age) => entry(age)),
    ]);
    expect(result.candidatePaths).toContain(older.path);
    for (const value of [corrupt, future]) expect(result.candidatePaths).not.toContain(value.path);
    expect(result.entries.find((value) => value.name === entry(0).name)?.reasons).toContain(
      'daily-utc-0',
    );
  });
  it('fails closed on missing pins and rejects malformed pins/timestamps', () => {
    const values = [0, 1, 2, 7, 30, 40].map((age) => entry(age));
    expect(manifest(values, [{ file: entry(60).name, reason: 'recovery' }]).candidatePaths).toEqual(
      [],
    );
    expect(() => manifest(values, [{ file: '../outside', reason: 'escape' }])).toThrow();
    expect(() => manifest(values, [{ file: entry(40).name, reason: '' }])).toThrow();
    expect(captureTime('publish-relay-20260230T120000Z.dump.age')).toBeNull();
    expect(captureTime('publish-relay-20260915T250000Z.dump.age')).toBeNull();
  });
  it('anchors bucket boundaries in UTC, independent of observer timezone', () => {
    const values = [0, 1, 2, 6, 7, 29, 30].map((age) => entry(age));
    const utc = backupManifest({ root: '/fixture', entries: values, pins: [], now });
    const offset = backupManifest({
      root: '/fixture',
      entries: values,
      pins: [],
      now: new Date('2026-09-15T15:00:00+03:00'),
    });
    expect(offset).toEqual(utc);
    const midnight = backupManifest({
      root: '/fixture',
      entries: values,
      pins: [],
      now: new Date('2026-09-16T00:00:00Z'),
    });
    expect(midnight.missingCoverage).toContain('daily-utc-0');
    expect(midnight.candidatePaths).toEqual([]);
  });
  it('preserves weekly/monthly coverage over a year of simulated successive rotation', () => {
    let retained: BackupEntry[] = [];
    for (let day = 0; day < 365; day++) {
      const date = new Date(now.getTime() + day * DAY_MS);
      const next = entry(0);
      next.capturedAt = date.toISOString();
      next.name = `publish-relay-${date.toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z')}.dump.age`;
      next.path = '/fixture/' + next.name;
      retained.push(next);
      const result = backupManifest({ root: '/fixture', entries: retained, pins: [], now: date });
      // Simulate a separately authorized apply; production implementation never removes.
      retained = retained.filter((value) => !result.candidatePaths.includes(value.path));
      if (day >= 30) {
        expect(result.status).toBe('proposal-only');
        for (const target of [7, 30]) {
          expect(
            retained.some((value) => {
              const age = Math.floor(
                (date.getTime() - Date.parse(value.capturedAt ?? '')) / DAY_MS,
              );
              return age >= target && age < target * 2;
            }),
          ).toBe(true);
        }
        expect(retained.length).toBeLessThanOrEqual(7);
      }
    }
  });
});

describe('read-only backup inventory', () => {
  it('binds validation to exact bytes and keeps empty/corrupt/unreceipted/legacy artifacts', async () => {
    const root = diskFixture();
    const good = writeBackup(root, 0);
    const corrupt = writeBackup(root, 1);
    const empty = writeBackup(root, 2);
    writeFileSync(join(root, corrupt), 'tampered');
    writeFileSync(join(root, empty), '');
    writeFileSync(join(root, entry(7).name), 'no receipt');
    writeFileSync(join(root, 'legacy.dump'), 'legacy');
    const before = readdirSync(root);
    const result = await inspectBackups(root);
    expect(result.entries.filter((value) => value.verified).map((value) => value.name)).toEqual([
      good,
    ]);
    expect(backupManifest({ ...result, pins: [], now }).candidatePaths).toEqual([]);
    expect(readdirSync(root)).toEqual(before);
    expect(readFileSync(join(root, corrupt), 'utf8')).toBe('tampered');
  });
  it('never follows backup or receipt symlinks and rejects a symlink root', async () => {
    const root = diskFixture();
    const source = join(root, 'protected');
    writeFileSync(source, 'untouched');
    symlinkSync(source, join(root, entry(0).name));
    const named = writeBackup(root, 1);
    rmSync(join(root, named + '.verified.json'));
    symlinkSync(source, join(root, named + '.verified.json'));
    expect((await inspectBackups(root)).entries.every((value) => !value.verified)).toBe(true);
    const alias = join(root, 'alias');
    symlinkSync(root, alias);
    await expect(inspectBackups(alias)).rejects.toThrow();
    expect(readFileSync(source, 'utf8')).toBe('untouched');
  });
  it('CLI emits an exact dry-run manifest and refuses any apply command without changes', () => {
    const root = diskFixture();
    writeBackup(root, 0);
    const pins = join(root, 'pins.json');
    writeFileSync(pins, '[]');
    const before = readdirSync(root);
    const cli = join(import.meta.dirname, '../src/entrypoints/backup-retention.ts');
    const result = spawnSync(process.execPath, ['--import', 'tsx', cli, 'inspect', root, pins], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout) as { approvedDeletePaths: string[]; mode: string };
    expect(plan.mode).toBe('dry-run');
    expect(plan.approvedDeletePaths).toEqual([]);
    expect(spawnSync(process.execPath, ['--import', 'tsx', cli, 'apply', root, pins]).status).toBe(
      1,
    );
    expect(readdirSync(root)).toEqual(before);
  });
});

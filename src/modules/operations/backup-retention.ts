import { z } from 'zod';

export const DAY_MS = 86_400_000;
const DAILY_COUNT = 3;
const AGED_TARGETS = [7, 30] as const;
export const backupName = /^publish-relay-(\d{8}T\d{6}Z)\.dump\.age$/;

export interface BackupEntry {
  name: string;
  path: string;
  bytes: number;
  sha256: string | null;
  capturedAt: string | null;
  verified: boolean;
  reason: string;
}
const pinsSchema = z
  .array(
    z
      .object({
        file: z.string().regex(backupName),
        reason: z.string().trim().min(1).max(500),
      })
      .strict(),
  )
  .max(10000);

export function captureTime(name: string): string | null {
  const stamp = backupName.exec(name)?.[1];
  if (!stamp) return null;
  const iso = stamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z');
  const time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString().replace('.000Z', 'Z') === iso
    ? iso
    : null;
}

function selectedPoints(entries: BackupEntry[], now: Date) {
  const day = Math.floor(now.getTime() / DAY_MS);
  const valid = entries
    .filter(
      (entry): entry is BackupEntry & { capturedAt: string } =>
        entry.verified &&
        entry.capturedAt !== null &&
        Date.parse(entry.capturedAt) <= now.getTime(),
    )
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt) || a.name.localeCompare(b.name));
  const age = (entry: BackupEntry & { capturedAt: string }) =>
    day - Math.floor(Date.parse(entry.capturedAt) / DAY_MS);
  const selected = new Map<string, string[]>();
  const missing: string[] = [];
  const add = (entry: BackupEntry | undefined, reason: string) => {
    if (entry) selected.set(entry.name, [...(selected.get(entry.name) ?? []), reason]);
    else missing.push(reason);
  };
  for (let daily = 0; daily < DAILY_COUNT; daily++) {
    add(
      valid.find((entry) => age(entry) === daily),
      `daily-utc-${String(daily)}`,
    );
  }
  for (const target of AGED_TARGETS) {
    add(
      valid.find((entry) => age(entry) >= target && age(entry) < target * 2),
      `recovery-at-least-${String(target)}-days`,
    );
    // The oldest younger point must survive to become the next aged replacement.
    // Without these bridges, applying successive five-point plans loses old coverage.
    const bridge = valid.filter((entry) => age(entry) >= DAILY_COUNT && age(entry) < target).at(-1);
    if (bridge) add(bridge, `bridge-to-${String(target)}-days`);
  }
  return { selected, missing };
}

export function backupManifest(input: {
  root: string;
  entries: BackupEntry[];
  pins: unknown;
  now: Date;
}) {
  if (!Number.isFinite(input.now.getTime())) throw new Error('Invalid observation time');
  const pins = pinsSchema.parse(input.pins);
  const { selected, missing } = selectedPoints(input.entries, input.now);
  const missingPins = pins.filter((pin) => !input.entries.some((entry) => entry.name === pin.file));
  const blocked = missing.length > 0 || missingPins.length > 0;
  const entries = input.entries.map((entry) => {
    const reasons = [...(selected.get(entry.name) ?? [])];
    for (const pin of pins.filter((pin) => pin.file === entry.name))
      reasons.push(`pin: ${pin.reason}`);
    if (!entry.verified) reasons.push(entry.reason);
    if (entry.capturedAt && Date.parse(entry.capturedAt) > input.now.getTime())
      reasons.push('future timestamp');
    if (blocked) reasons.push('keep-all: incomplete coverage or missing pin');
    return { ...entry, disposition: reasons.length ? 'keep' : 'candidate', reasons };
  });
  return {
    version: 1,
    mode: 'dry-run',
    root: input.root,
    observedAt: input.now.toISOString(),
    status: blocked ? 'coverage-incomplete' : 'proposal-only',
    missingCoverage: missing,
    missingPins,
    entries,
    candidatePaths: entries
      .filter((entry) => entry.disposition === 'candidate')
      .map((entry) => entry.path),
    approvedDeletePaths: [] as string[],
    warning:
      'No deletion is authorized or implemented. Receipts are local integrity evidence, not independent restore/off-host proof.',
  };
}

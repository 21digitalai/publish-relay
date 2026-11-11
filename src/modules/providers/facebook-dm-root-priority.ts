export interface PendingRootSlot {
  id: string;
  dueAt: Date;
  windowDeadline: Date | null;
}

/** Keep normal append order; use an earlier free slot only when the window needs it. */
export function planPageDmRootPriority(input: {
  pending: PendingRootSlot[];
  newDeadline: Date;
  earliestAt: Date;
  appendAt: Date;
}): { dueAt: Date; changes: { id: string; dueAt: Date }[] } | null {
  const pending = [...input.pending].sort(
    (a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.id.localeCompare(b.id),
  );
  const latestDeadline = pending.reduce(
    (latest, root) => Math.max(latest, root.windowDeadline?.getTime() ?? 0),
    0,
  );
  const needsEarlierSlot =
    input.newDeadline.getTime() < latestDeadline || input.appendAt > input.newDeadline;
  if (!needsEarlierSlot) {
    return input.appendAt <= input.newDeadline ? { dueAt: input.appendAt, changes: [] } : null;
  }
  const first = pending[0];
  if (
    first &&
    (!first.windowDeadline || input.newDeadline <= first.windowDeadline) &&
    input.earliestAt.getTime() + 60_000 <= first.dueAt.getTime() &&
    input.earliestAt <= input.newDeadline
  ) {
    return { dueAt: input.earliestAt, changes: [] };
  }
  // A legacy root has no recorded inbound deadline; moving it could silently
  // spend its remaining reply window. Leave the Page queue intact instead.
  if (pending.some((root) => !root.windowDeadline)) return null;
  const ordered = [
    ...pending.map((root) => ({ ...root, isNew: false })),
    { id: '', dueAt: input.appendAt, windowDeadline: input.newDeadline, isNew: true },
  ].sort(
    (a, b) =>
      (a.windowDeadline?.getTime() ?? Infinity) - (b.windowDeadline?.getTime() ?? Infinity) ||
      a.dueAt.getTime() - b.dueAt.getTime(),
  );
  let previous = input.earliestAt.getTime() - 60_000;
  const changes: { id: string; dueAt: Date }[] = [];
  let dueAt = input.appendAt;
  for (const root of ordered) {
    // Existing promises never move earlier; the new root uses the first free
    // paced slot permitted by the durable cursor and any earlier windows.
    const slot = new Date(
      Math.max(root.isNew ? input.earliestAt.getTime() : root.dueAt.getTime(), previous + 60_000),
    );
    if (slot > (root.windowDeadline ?? new Date(0))) return null;
    previous = slot.getTime();
    if (root.isNew) dueAt = slot;
    else if (slot.getTime() !== root.dueAt.getTime()) changes.push({ id: root.id, dueAt: slot });
  }
  return { dueAt, changes };
}

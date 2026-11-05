export class PageDmScheduleWindowError extends Error {
  constructor() {
    super('The Messenger reply window cannot fit the selected send delay');
  }
}

export function chooseApprovedPageDmDueAt(input: {
  plannedDueAt: Date;
  approvedAt: Date;
  windowDeadline: Date;
  earliestDelaySeconds: number;
  latestDelaySeconds: number;
  randomValue: number;
}): Date {
  const { plannedDueAt, approvedAt, windowDeadline } = input;
  if (
    ![plannedDueAt, approvedAt, windowDeadline].every((value) =>
      Number.isFinite(value.getTime()),
    ) ||
    !Number.isInteger(input.earliestDelaySeconds) ||
    !Number.isInteger(input.latestDelaySeconds) ||
    input.earliestDelaySeconds < 0 ||
    input.latestDelaySeconds < input.earliestDelaySeconds ||
    !Number.isFinite(input.randomValue) ||
    input.randomValue < 0 ||
    input.randomValue >= 1
  )
    throw new PageDmScheduleWindowError();

  const base = Math.max(plannedDueAt.getTime(), approvedAt.getTime());
  const latestSafeDelay = Math.min(
    input.latestDelaySeconds,
    Math.floor((windowDeadline.getTime() - base) / 1000),
  );
  if (latestSafeDelay < input.earliestDelaySeconds) throw new PageDmScheduleWindowError();
  const sampledDelay =
    input.earliestDelaySeconds +
    Math.floor(input.randomValue * (latestSafeDelay - input.earliestDelaySeconds + 1));
  return new Date(base + sampledDelay * 1000);
}

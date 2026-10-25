export interface FanvueUploadPlan {
  partSize: number;
  partCount: number;
  byteSize: number;
}

const MAX_FANVUE_PARTS = 256;

export function planFanvueMediaUpload(
  byteSize: number,
  session: { partSize: number; maxParts: number; totalParts: number | null },
): FanvueUploadPlan {
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) throw new Error('Invalid media size');
  if (!Number.isSafeInteger(session.partSize) || session.partSize <= 0)
    throw new Error('Invalid Fanvue upload part size');
  const partCount = Math.ceil(byteSize / session.partSize);
  if (
    !Number.isSafeInteger(session.maxParts) ||
    session.maxParts <= 0 ||
    partCount > session.maxParts ||
    partCount > MAX_FANVUE_PARTS ||
    (session.totalParts !== null && session.totalParts !== partCount)
  )
    throw new Error('Fanvue upload session cannot represent this media');
  return { partSize: session.partSize, partCount, byteSize };
}

export function fanvuePartRange(plan: FanvueUploadPlan, partNumber: number) {
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > plan.partCount)
    throw new Error('Fanvue upload part is out of range');
  const start = (partNumber - 1) * plan.partSize;
  const end = Math.min(start + plan.partSize, plan.byteSize) - 1;
  return { start, end, byteLength: end - start + 1 };
}

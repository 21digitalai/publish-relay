import { z } from 'zod';

import { fanvuePartRange, planFanvueMediaUpload } from './fanvue-media-upload-plan.js';

const sessionSchema = z.strictObject({
  uploadId: z.string().min(1).max(512),
  mediaUuid: z.uuid(),
  byteSize: z.number().int().positive(),
  partSize: z.number().int().positive(),
  partCount: z.number().int().positive().max(256),
  parts: z
    .array(z.strictObject({ PartNumber: z.number().int().positive(), ETag: z.string().min(1) }))
    .max(256),
});

export type FanvueUploadSession = z.infer<typeof sessionSchema>;

export function createFanvueUploadSession(
  byteSize: number,
  provider: {
    uploadId: string;
    mediaUuid: string;
    partSize: number;
    maxParts: number;
    totalParts: number | null;
  },
): FanvueUploadSession {
  const plan = planFanvueMediaUpload(byteSize, provider);
  return sessionSchema.parse({
    uploadId: provider.uploadId,
    mediaUuid: provider.mediaUuid,
    byteSize,
    partSize: plan.partSize,
    partCount: plan.partCount,
    parts: [],
  });
}

export function parseFanvueUploadSession(value: unknown): FanvueUploadSession {
  const state = sessionSchema.parse(value);
  const plan = planFanvueMediaUpload(state.byteSize, {
    partSize: state.partSize,
    maxParts: state.partCount,
    totalParts: state.partCount,
  });
  if (plan.partCount !== state.partCount) throw new Error('Fanvue upload progress is inconsistent');
  for (const [index, part] of state.parts.entries())
    if (part.PartNumber !== index + 1)
      throw new Error('Fanvue upload part receipts are inconsistent');
  return state;
}

export function appendFanvuePartReceipt(
  state: FanvueUploadSession,
  partNumber: number,
  etag: string,
): { state: FanvueUploadSession; nextByteOffset: number } {
  const current = parseFanvueUploadSession(state);
  if (partNumber !== current.parts.length + 1 || !etag)
    throw new Error('Fanvue upload part is not next in sequence');
  const range = fanvuePartRange(current, partNumber);
  return {
    state: { ...current, parts: [...current.parts, { PartNumber: partNumber, ETag: etag }] },
    nextByteOffset: range.end + 1,
  };
}

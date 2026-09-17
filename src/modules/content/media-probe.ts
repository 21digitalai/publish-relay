import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface VideoMetadata {
  container: 'mp4';
  durationMs: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
}

export interface MediaProbe {
  probeMp4(bytes: Buffer): Promise<VideoMetadata>;
  probeMp4File?(file: string): Promise<VideoMetadata>;
}

interface ProbeOutput {
  format?: { duration?: string; format_name?: string };
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
}

function parseProbeOutput(output: ProbeOutput): VideoMetadata {
  const formats = output.format?.format_name?.split(',') ?? [];
  const video = output.streams?.find((stream) => stream.codec_type === 'video');
  const audio = output.streams?.find((stream) => stream.codec_type === 'audio');
  const durationMs = Math.round(Number(output.format?.duration) * 1000);
  if (!formats.includes('mp4') || !video?.codec_name || !video.width || !video.height)
    throw new Error('Invalid MP4: a supported container and video track are required');
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
    throw new Error('Invalid MP4: a positive duration is required');
  return {
    container: 'mp4',
    durationMs,
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name ?? null,
  };
}

export class FfprobeMediaProbe implements MediaProbe {
  constructor(
    private readonly executable = 'ffprobe',
    private readonly timeoutMs = 15_000,
  ) {}

  async probeMp4(bytes: Buffer): Promise<VideoMetadata> {
    const directory = await mkdtemp(join(tmpdir(), 'publish-relay-probe-'));
    const file = join(directory, 'upload.mp4');
    try {
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      return await this.probeMp4File(file);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async probeMp4File(file: string): Promise<VideoMetadata> {
    try {
      const { stdout } = await execFileAsync(
        this.executable,
        [
          '-v',
          'error',
          '-show_entries',
          'format=format_name,duration:stream=codec_type,codec_name,width,height',
          '-of',
          'json',
          file,
        ],
        { timeout: this.timeoutMs, maxBuffer: 1024 * 1024 },
      );
      return parseProbeOutput(JSON.parse(stdout) as ProbeOutput);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Invalid MP4')) throw error;
      throw new Error('Invalid MP4: container probe failed');
    }
  }
}

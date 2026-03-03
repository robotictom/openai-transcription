import { execa } from "execa";

export type ProbeResult = {
  durationSeconds?: number;
};

export async function ensureFfmpegAvailable(): Promise<void> {
  await execa("ffmpeg", ["-version"]);
}

export async function probeDuration(inputPath: string): Promise<ProbeResult> {
  try {
    const result = await execa("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath
    ]);

    const duration = Number(result.stdout.trim());

    if (Number.isFinite(duration)) {
      return { durationSeconds: duration };
    }

    return {};
  } catch {
    return {};
  }
}

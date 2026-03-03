import path from "node:path";

export type AudioFormat = "m4a" | "mp3" | "wav";

export type FfmpegRenderInput = {
  inputPath: string;
  outputPath: string;
  isVideo: boolean;
  extractAudio: boolean;
  trimStart?: string;
  trimEnd?: string;
  audioFormat: AudioFormat;
  audioBitrateKbps: number;
  sampleRateHz: number;
  mono: boolean;
  normalize: boolean;
};

export type RenderedCommand = {
  command: string;
  args: string[];
  commandString: string;
  reencode: boolean;
};

function isM4aCopyCompatible(inputPath: string, isVideo: boolean): boolean {
  if (isVideo) {
    return true;
  }

  const ext = path.extname(inputPath).toLowerCase();
  return ext === ".m4a";
}

export function shouldReencode(input: FfmpegRenderInput): boolean {
  if (input.normalize) {
    return true;
  }

  if (input.audioFormat !== "m4a") {
    return true;
  }

  return !isM4aCopyCompatible(input.inputPath, input.isVideo);
}

export function renderFfmpegCommand(input: FfmpegRenderInput): RenderedCommand {
  const reencode = shouldReencode(input);

  const args: string[] = ["-hide_banner", "-loglevel", "error", "-y"];

  if (input.trimStart) {
    args.push("-ss", input.trimStart);
  }

  args.push("-i", input.inputPath);

  if (input.trimEnd) {
    args.push("-to", input.trimEnd);
  }

  if (input.isVideo || input.extractAudio) {
    args.push("-vn");
  }

  if (reencode) {
    if (input.normalize) {
      args.push("-af", "loudnorm");
    }

    if (input.mono) {
      args.push("-ac", "1");
    }

    if (input.sampleRateHz > 0) {
      args.push("-ar", String(input.sampleRateHz));
    }

    if (input.audioFormat === "m4a") {
      args.push("-c:a", "aac");
    }

    if (input.audioFormat === "mp3") {
      args.push("-b:a", `${input.audioBitrateKbps}k`);
    }
  } else {
    args.push("-c", "copy");
  }

  args.push(input.outputPath);

  const command = "ffmpeg";
  const commandString = [command, ...args].join(" ");

  return {
    command,
    args,
    commandString,
    reencode
  };
}

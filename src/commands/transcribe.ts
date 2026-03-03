import path from "node:path";
import { access, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import readline from "node:readline";
import { execa } from "execa";
import { Command, InvalidArgumentError } from "commander";
import { z } from "zod";
import { ensureFfmpegAvailable, probeDuration } from "../ffmpeg/probe.js";
import { renderFfmpegCommand, type AudioFormat } from "../ffmpeg/render.js";
import { transcribeWithOpenAI, type ResponseFormat } from "../openai/transcribe.js";
import {
  normalizeSegments,
  transcriptMarkdownFromSegments,
  transcriptTextFromResponse
} from "../types/diarized.js";
import { writeOutputs } from "../output/writers.js";

const EXIT_GENERAL = 1;
const EXIT_FFMPEG = 2;
const EXIT_API = 3;
const EXIT_INVALID_ARGS = 4;

const TimeStringSchema = z.string().regex(/^\d{2}:\d{2}:\d{2}$/, "time must be HH:MM:SS");
const AudioFormatSchema = z.enum(["m4a", "mp3", "wav"]);
const ResponseFormatSchema = z.enum(["diarized_json", "json", "text"]);

class FfmpegError extends Error {}
class OpenAIApiError extends Error {}

type TranscribeOptions = {
  outDir?: string;
  trimStart?: string;
  trimEnd?: string;
  extractAudio?: boolean;
  audioFormat: AudioFormat;
  audioBitrate: string;
  sampleRate?: string;
  mono?: boolean;
  normalize?: boolean;
  model: string;
  responseFormat: ResponseFormat;
  language?: string;
  dryRun?: boolean;
  keepTemp?: boolean;
};

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`${label} must be a positive integer`);
  }

  return parsed;
}

function parseTimeString(value: string): string {
  const parsed = TimeStringSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError(parsed.error.issues[0]?.message ?? "invalid time value");
  }

  return parsed.data;
}

function parseAudioFormat(value: string): AudioFormat {
  const parsed = AudioFormatSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError("audio-format must be one of: m4a, mp3, wav");
  }
  return parsed.data;
}

function parseResponseFormat(value: string): ResponseFormat {
  const parsed = ResponseFormatSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError("response-format must be one of: diarized_json, json, text");
  }
  return parsed.data;
}

function timestampLabel(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function getInputType(inputPath: string): "video" | "audio" {
  const ext = path.extname(inputPath).toLowerCase();
  if ([".mp4", ".mov", ".mkv", ".webm"].includes(ext)) {
    return "video";
  }

  return "audio";
}

async function validateInputPath(inputPath: string): Promise<void> {
  try {
    await access(inputPath, constants.R_OK);
  } catch {
    const error = new Error(`input not found or unreadable: ${inputPath}`);
    (error as NodeJS.ErrnoException).code = "EINVAL";
    throw error;
  }
}

function normalizeOutDir(inputPath: string, outDir?: string): string {
  if (outDir) {
    return path.resolve(outDir);
  }

  const base = path.basename(inputPath, path.extname(inputPath));
  return path.resolve("out", `${base}-${timestampLabel(new Date())}`);
}

function asExitCode(error: unknown): number {
  if (error instanceof InvalidArgumentError) {
    return EXIT_INVALID_ARGS;
  }

  if (error instanceof FfmpegError) {
    return EXIT_FFMPEG;
  }

  if (error instanceof OpenAIApiError) {
    return EXIT_API;
  }

  if (error instanceof Error && /OPENAI_API_KEY/.test(error.message)) {
    return EXIT_INVALID_ARGS;
  }

  if (error && typeof error === "object" && "shortMessage" in error) {
    return EXIT_FFMPEG;
  }

  if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EINVAL") {
    return EXIT_INVALID_ARGS;
  }

  if (error instanceof Error && /OpenAI|API|transcription/i.test(error.message)) {
    return EXIT_API;
  }

  return EXIT_GENERAL;
}

function ensureDiarizedCompatibility(model: string, responseFormat: ResponseFormat): void {
  if (responseFormat === "diarized_json" && model !== "gpt-4o-transcribe-diarize") {
    throw new InvalidArgumentError("diarized_json requires model gpt-4o-transcribe-diarize");
  }
}

function hhmmssToSeconds(value: string): number {
  const [hours, minutes, seconds] = value.split(":").map((part) => Number.parseInt(part, 10));
  return hours * 3600 + minutes * 60 + seconds;
}

function expectedSubmittedDurationSeconds(
  inputDurationSeconds: number | undefined,
  trimStart: string | undefined,
  trimEnd: string | undefined
): number | undefined {
  const start = trimStart ? hhmmssToSeconds(trimStart) : 0;
  const end = trimEnd ? hhmmssToSeconds(trimEnd) : inputDurationSeconds;

  if (typeof end !== "number" || !Number.isFinite(end)) {
    return undefined;
  }

  const duration = end - start;
  if (!Number.isFinite(duration) || duration <= 0) {
    return undefined;
  }

  return duration;
}

async function runFfmpegWithProgress(
  command: string,
  args: string[],
  expectedDurationSeconds?: number
): Promise<void> {
  const outputPath = args[args.length - 1];
  const execArgs = [
    ...args.slice(0, -1),
    "-progress",
    "pipe:2",
    "-nostats",
    outputPath
  ];

  const child = execa(command, execArgs);
  const stderrStream = child.stderr;
  let lastPercentPrinted = -1;

  if (stderrStream) {
    const rl = readline.createInterface({ input: stderrStream });
    rl.on("line", (line) => {
      if (!line.startsWith("out_time_ms=") || !expectedDurationSeconds) {
        return;
      }

      const value = Number.parseInt(line.replace("out_time_ms=", ""), 10);
      if (!Number.isFinite(value) || value <= 0) {
        return;
      }

      const seconds = value / 1_000_000;
      const percent = Math.min(100, Math.floor((seconds / expectedDurationSeconds) * 100));

      if (percent >= 0 && percent !== lastPercentPrinted && percent % 10 === 0) {
        lastPercentPrinted = percent;
        console.log(`[2/4] Preparing audio with ffmpeg: ${percent}%`);
      }
    });
  }

  await child;
  console.log("[2/4] Preparing audio with ffmpeg: done");
}

type AudioChunk = {
  path: string;
  startSeconds: number;
  durationSeconds: number;
};

async function splitAudioIntoChunks(
  inputPath: string,
  tmpDir: string,
  ext: AudioFormat,
  totalDurationSeconds: number,
  commandsExecuted: string[]
): Promise<AudioChunk[]> {
  const chunkDir = path.join(tmpDir, "chunks");
  await mkdir(chunkDir, { recursive: true });

  const targetChunkSeconds = 180;
  const chunks: AudioChunk[] = [];

  for (let start = 0; start < totalDurationSeconds; start += targetChunkSeconds) {
    const duration = Math.min(targetChunkSeconds, totalDurationSeconds - start);
    const chunkPath = path.join(chunkDir, `chunk-${String(chunks.length).padStart(3, "0")}.${ext}`);
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(start),
      "-t",
      String(duration),
      "-i",
      inputPath,
      "-c",
      "copy",
      chunkPath
    ];

    try {
      await execa("ffmpeg", args);
      commandsExecuted.push(`ffmpeg ${args.join(" ")}`);
    } catch {
      // Fallback to re-encode when stream copy chunking is unsupported by input codec/container.
      const audioCodec = ext === "mp3" ? "libmp3lame" : (ext === "wav" ? "pcm_s16le" : "aac");
      const reencodeArgs = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        String(start),
        "-t",
        String(duration),
        "-i",
        inputPath,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        audioCodec,
        chunkPath
      ];

      await execa("ffmpeg", reencodeArgs);
      commandsExecuted.push(`ffmpeg ${reencodeArgs.join(" ")}`);
    }

    chunks.push({
      path: chunkPath,
      startSeconds: start,
      durationSeconds: duration
    });
  }

  return chunks;
}

function toNumberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function mergeChunkResponses(
  responses: unknown[],
  chunks: AudioChunk[],
  responseFormat: ResponseFormat
): unknown {
  if (responseFormat === "text") {
    const joined = responses.map((value) => String(value)).join("\n").trim();
    return joined;
  }

  if (responseFormat === "json") {
    const text = responses
      .map((value) => (value && typeof value === "object" && "text" in value ? String((value as { text?: unknown }).text ?? "") : ""))
      .join(" ")
      .trim();
    return { text };
  }

  const mergedSegments: Array<Record<string, unknown>> = [];
  const textParts: string[] = [];

  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index];
    const chunk = chunks[index];

    if (!response || typeof response !== "object") {
      continue;
    }

    const typed = response as { text?: unknown; segments?: unknown[] };
    if (typeof typed.text === "string" && typed.text.trim()) {
      textParts.push(typed.text.trim());
    }

    if (!Array.isArray(typed.segments)) {
      continue;
    }

    for (const segment of typed.segments) {
      if (!segment || typeof segment !== "object") {
        continue;
      }

      const obj = { ...(segment as Record<string, unknown>) };
      const start = toNumberOrUndefined(obj.start);
      const end = toNumberOrUndefined(obj.end);

      if (typeof start === "number") {
        obj.start = start + chunk.startSeconds;
      }
      if (typeof end === "number") {
        obj.end = end + chunk.startSeconds;
      }

      mergedSegments.push(obj);
    }
  }

  return {
    text: textParts.join(" ").trim(),
    segments: mergedSegments
  };
}

async function withTranscriptionProgress<T>(fn: (onStatus: (message: string) => void) => Promise<T>): Promise<T> {
  const start = Date.now();
  let latestStatus = "request in progress";
  const onStatus = (message: string): void => {
    latestStatus = message;
    console.log(`[3/4] ${message}`);
  };

  const timer = setInterval(() => {
    const elapsedMinutes = Math.floor((Date.now() - start) / 60000);
    console.log(
      `[3/4] Waiting for OpenAI transcription... ${elapsedMinutes} minute(s) elapsed (${latestStatus})`
    );
  }, 60_000);

  try {
    console.log("[3/4] Waiting for OpenAI transcription... this can take several minutes for longer files");
    const result = await fn(onStatus);
    return result;
  } finally {
    clearInterval(timer);
    console.log("[3/4] Waiting for OpenAI transcription: done");
  }
}

async function runTranscribe(inputPath: string, options: TranscribeOptions): Promise<void> {
  const absoluteInputPath = path.resolve(inputPath);
  console.log("[1/4] Validating inputs and environment...");
  await validateInputPath(absoluteInputPath);

  await ensureFfmpegAvailable();

  if (!process.env.OPENAI_API_KEY && !options.dryRun) {
    throw new InvalidArgumentError("OPENAI_API_KEY is not set");
  }

  ensureDiarizedCompatibility(options.model, options.responseFormat);

  if (options.trimStart && options.trimEnd) {
    if (hhmmssToSeconds(options.trimEnd) <= hhmmssToSeconds(options.trimStart)) {
      throw new InvalidArgumentError("trim-end must be later than trim-start");
    }
  }

  const inputType = getInputType(absoluteInputPath);
  const isVideo = inputType === "video";
  const extractAudio = options.extractAudio ?? isVideo;

  const audioBitrateKbps = parsePositiveInt(options.audioBitrate, "audio-bitrate");
  const sampleRateHz = options.sampleRate
    ? parsePositiveInt(options.sampleRate, "sample-rate")
    : 16000;

  const shouldReencode = options.normalize || options.audioFormat !== "m4a";
  const mono = options.mono ?? shouldReencode;

  const outDir = normalizeOutDir(absoluteInputPath, options.outDir);
  await mkdir(outDir, { recursive: true });

  const tmpDir = path.join(outDir, ".tmp");
  await mkdir(tmpDir, { recursive: true });

  const finalAudioPath = path.join(tmpDir, `submitted.${options.audioFormat}`);

  const rendered = renderFfmpegCommand({
    inputPath: absoluteInputPath,
    outputPath: finalAudioPath,
    isVideo,
    extractAudio,
    trimStart: options.trimStart,
    trimEnd: options.trimEnd,
    audioFormat: options.audioFormat,
    audioBitrateKbps,
    sampleRateHz,
    mono,
    normalize: options.normalize ?? false
  });

  const inputProbe = await probeDuration(absoluteInputPath);
  const estimatedSubmittedSeconds = expectedSubmittedDurationSeconds(
    inputProbe.durationSeconds,
    options.trimStart,
    options.trimEnd
  );
  const commandsExecuted = [rendered.commandString];

  if (options.dryRun) {
    console.log("Dry run");
    console.log(`ffmpeg command: ${rendered.commandString}`);
    console.log(`output directory: ${outDir}`);
    return;
  }

  try {
    console.log("[2/4] Preparing audio with ffmpeg...");
    await runFfmpegWithProgress(rendered.command, rendered.args, estimatedSubmittedSeconds);
  } catch (error) {
    const err = error as Error;
    throw new FfmpegError(`ffmpeg failed: ${err.message}`);
  }

  const outputProbe = await probeDuration(finalAudioPath);

  let rawResponse: unknown;
  try {
    console.log("[3/4] Sending audio to OpenAI...");
    const outputDurationSeconds = outputProbe.durationSeconds;
    const canChunk = options.responseFormat === "diarized_json" && typeof outputDurationSeconds === "number";
    const shouldChunk = canChunk && outputDurationSeconds > 240;

    if (shouldChunk) {
      console.log("[3/4] Long audio detected, using client-side chunking to avoid request timeouts...");
      const chunks = await splitAudioIntoChunks(
        finalAudioPath,
        tmpDir,
        options.audioFormat,
        outputDurationSeconds,
        commandsExecuted
      );
      console.log(`[3/4] Created ${chunks.length} chunk(s), starting transcription...`);

      const responses: unknown[] = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const chunkLabel = `${index + 1}/${chunks.length}`;
        console.log(`[3/4] Transcribing chunk ${chunkLabel} (${Math.round(chunk.durationSeconds)}s)...`);

        const chunkResponse = await withTranscriptionProgress((onStatus) => transcribeWithOpenAI({
          filePath: chunk.path,
          model: options.model,
          responseFormat: options.responseFormat,
          language: options.language,
          onStatus: (message) => onStatus(`chunk ${chunkLabel}: ${message}`)
        }));
        responses.push(chunkResponse);
      }

      rawResponse = mergeChunkResponses(responses, chunks, options.responseFormat);
    } else {
      rawResponse = await withTranscriptionProgress((onStatus) => transcribeWithOpenAI({
        filePath: finalAudioPath,
        model: options.model,
        responseFormat: options.responseFormat,
        language: options.language,
        onStatus
      }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OpenAIApiError(`OpenAI transcription API error: ${message}`);
  }

  const segments = normalizeSegments(rawResponse);
  const transcriptText = transcriptTextFromResponse(rawResponse);
  const transcriptMarkdown = transcriptMarkdownFromSegments(segments);

  const meta = {
    inputPath: absoluteInputPath,
    outputDirectory: outDir,
    createdAt: new Date().toISOString(),
    model: options.model,
    responseFormat: options.responseFormat,
    language: options.language,
    ffmpeg: {
      commandsExecuted
    },
    config: {
      trimStart: options.trimStart,
      trimEnd: options.trimEnd,
      extractAudio,
      audioFormat: options.audioFormat,
      audioBitrateKbps,
      sampleRateHz,
      mono,
      normalize: options.normalize ?? false
    },
    durations: {
      inputSeconds: inputProbe.durationSeconds,
      submittedAudioSeconds: outputProbe.durationSeconds
    }
  };

  console.log("[4/4] Writing outputs...");
  await writeOutputs({
    outDir,
    submittedAudioPath: finalAudioPath,
    submittedAudioExt: options.audioFormat,
    rawResponse,
    transcriptText,
    transcriptMarkdown,
    segments,
    meta
  });

  if (!options.keepTemp) {
    await rm(tmpDir, { recursive: true, force: true });
  }

  const uniqueSpeakers = new Set(segments.map((segment) => segment.speaker));

  if (typeof inputProbe.durationSeconds === "number") {
    console.log(`input duration: ${inputProbe.durationSeconds.toFixed(2)}s`);
  } else {
    console.log("input duration: unavailable");
  }

  if (typeof outputProbe.durationSeconds === "number") {
    console.log(`submitted audio duration: ${outputProbe.durationSeconds.toFixed(2)}s`);
  } else {
    console.log("submitted audio duration: unavailable");
  }

  console.log(`model: ${options.model}`);
  console.log(`response format: ${options.responseFormat}`);
  console.log(`output directory: ${outDir}`);
  console.log(`summary: ${segments.length} segments, ${uniqueSpeakers.size} speakers`);
}

export function registerTranscribeCommand(program: Command): void {
  program
    .command("transcribe")
    .argument("<input>", "input media file path")
    .option("--out-dir <path>", "output directory")
    .option("--trim-start <HH:MM:SS>", "trim start timestamp", parseTimeString)
    .option("--trim-end <HH:MM:SS>", "trim end timestamp", parseTimeString)
    .option("--extract-audio", "extract audio stream from input")
    .option("--audio-format <m4a|mp3|wav>", "audio output format", parseAudioFormat, "m4a")
    .option("--audio-bitrate <kbps>", "audio bitrate kbps", "64")
    .option("--sample-rate <hz>", "sample rate hz")
    .option("--mono", "use mono channel when re-encoding")
    .option("--normalize", "apply loudness normalization")
    .option("--model <string>", "transcription model", "gpt-4o-transcribe-diarize")
    .option(
      "--response-format <diarized_json|json|text>",
      "API response format",
      parseResponseFormat,
      "diarized_json"
    )
    .option("--language <bcp47>", "language hint")
    .option("--dry-run", "print steps without execution")
    .option("--keep-temp", "keep intermediate files")
    .action(async (input: string, options: TranscribeOptions) => {
      try {
        await runTranscribe(input, options);
      } catch (error) {
        const exitCode = asExitCode(error);
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exitCode = exitCode;
      }
    });
}

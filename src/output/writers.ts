import { mkdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import type { NormalizedSegment } from "../types/diarized.js";

export type OutputWriteInput = {
  outDir: string;
  submittedAudioPath: string;
  submittedAudioExt: string;
  rawResponse: unknown;
  transcriptText: string;
  transcriptMarkdown: string;
  segments: NormalizedSegment[];
  meta: Record<string, unknown>;
};

export async function writeOutputs(input: OutputWriteInput): Promise<void> {
  await mkdir(input.outDir, { recursive: true });

  const audioOutPath = path.join(input.outDir, `audio.${input.submittedAudioExt}`);
  const rawOutPath = path.join(input.outDir, "transcript.diarized.json");
  const textOutPath = path.join(input.outDir, "transcript.txt");
  const markdownOutPath = path.join(input.outDir, "transcript.md");
  const segmentsOutPath = path.join(input.outDir, "segments.json");
  const metaOutPath = path.join(input.outDir, "meta.json");

  await copyFile(input.submittedAudioPath, audioOutPath);
  await writeFile(rawOutPath, JSON.stringify(input.rawResponse, null, 2) + "\n", "utf8");
  await writeFile(textOutPath, input.transcriptText + "\n", "utf8");
  await writeFile(markdownOutPath, input.transcriptMarkdown + "\n", "utf8");
  await writeFile(segmentsOutPath, JSON.stringify(input.segments, null, 2) + "\n", "utf8");
  await writeFile(metaOutPath, JSON.stringify(input.meta, null, 2) + "\n", "utf8");
}

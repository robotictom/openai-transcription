#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { registerTranscribeCommand } from "./commands/transcribe.js";

const program = new Command();

program
  .name("openai-transcription")
  .description("Transcribe media with OpenAI diarization")
  .showHelpAfterError();

registerTranscribeCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

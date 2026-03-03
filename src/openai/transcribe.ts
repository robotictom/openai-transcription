import { createReadStream } from "node:fs";
import OpenAI from "openai";

export type ResponseFormat = "diarized_json" | "json" | "text";

export type OpenAITranscribeInput = {
  filePath: string;
  model: string;
  responseFormat: ResponseFormat;
  language?: string;
  onStatus?: (message: string) => void;
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  if (
    message.includes("timed out")
    || message.includes("etimedout")
    || message.includes("econnreset")
    || message.includes("econnaborted")
    || message.includes("fetch failed")
  ) {
    return true;
  }

  const maybeStatus = error as { status?: number };
  if (typeof maybeStatus.status === "number" && maybeStatus.status >= 500) {
    return true;
  }

  return false;
}

export async function transcribeWithOpenAI(input: OpenAITranscribeInput): Promise<unknown> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const client = new OpenAI({ apiKey });

  const chunkingStrategy = input.model === "gpt-4o-transcribe-diarize" ? "auto" : undefined;

  const maxAttempts = 3;
  const perAttemptTimeoutMs = 15 * 60 * 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      input.onStatus?.(
        `OpenAI request attempt ${attempt}/${maxAttempts} started (upload + transcription in one request)`
      );

      const response = await client.audio.transcriptions.create(
        {
          file: createReadStream(input.filePath),
          model: input.model,
          response_format: input.responseFormat,
          chunking_strategy: chunkingStrategy,
          language: input.language
        },
        {
          timeout: perAttemptTimeoutMs,
          maxRetries: 0
        }
      );

      input.onStatus?.(`OpenAI request attempt ${attempt}/${maxAttempts} completed`);
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      input.onStatus?.(`OpenAI request attempt ${attempt}/${maxAttempts} failed: ${message}`);

      if (attempt >= maxAttempts || !isRetryable(error)) {
        throw error;
      }

      input.onStatus?.(`Retrying after transient failure (attempt ${attempt + 1}/${maxAttempts})...`);
      await wait(1000 * attempt);
    }
  }

  throw new Error("OpenAI transcription failed after retries");
}

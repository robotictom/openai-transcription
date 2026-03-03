import { z } from "zod";

const UnknownSegmentSchema = z.object({
  speaker: z.string().optional(),
  start: z.union([z.number(), z.string()]).optional(),
  end: z.union([z.number(), z.string()]).optional(),
  text: z.string().optional()
});

const UnknownDiarizedSchema = z.object({
  text: z.string().optional(),
  segments: z.array(UnknownSegmentSchema).optional()
});

export const NormalizedSegmentSchema = z.object({
  speaker: z.string(),
  start: z.number(),
  end: z.number(),
  text: z.string()
});

export type NormalizedSegment = z.infer<typeof NormalizedSegmentSchema>;

export type ParsedDiarized = z.infer<typeof UnknownDiarizedSchema>;

function toNumber(value: string | number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

export function parseDiarizedResponse(value: unknown): ParsedDiarized {
  return UnknownDiarizedSchema.parse(value);
}

export function normalizeSegments(value: unknown): NormalizedSegment[] {
  const parsed = parseDiarizedResponse(value);
  const segments = parsed.segments ?? [];

  return segments.map((segment, index) => {
    const start = toNumber(segment.start, 0);
    const endRaw = toNumber(segment.end, start);
    const end = endRaw >= start ? endRaw : start;

    return NormalizedSegmentSchema.parse({
      speaker: segment.speaker?.trim() || "unknown",
      start,
      end,
      text: segment.text?.trim() ?? ""
    });
  }).filter((segment) => segment.text.length > 0 || segment.end > segment.start || segment.speaker !== "unknown");
}

export function transcriptTextFromResponse(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  const parsed = parseDiarizedResponse(value);
  if (parsed.text && parsed.text.trim()) {
    return parsed.text.trim();
  }

  const normalized = normalizeSegments(value);
  return normalized.map((segment) => segment.text).join(" ").trim();
}

export function transcriptMarkdownFromSegments(segments: NormalizedSegment[]): string {
  return segments
    .map((segment) => `- [${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] **${segment.speaker}**: ${segment.text}`)
    .join("\n");
}

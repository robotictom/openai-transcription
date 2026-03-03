import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeSegments } from "../src/types/diarized.js";

const FIXTURE_DIR = path.resolve("test/fixtures");

async function loadJson(fileName: string): Promise<unknown> {
  const fullPath = path.join(FIXTURE_DIR, fileName);
  return JSON.parse(await readFile(fullPath, "utf8"));
}

describe("normalizeSegments", () => {
  it("normalizes diarized_json fixtures", async () => {
    const input = await loadJson("diarized.input.json");
    const expected = await loadJson("diarized.expected.json");

    expect(normalizeSegments(input)).toEqual(expected);
  });
});

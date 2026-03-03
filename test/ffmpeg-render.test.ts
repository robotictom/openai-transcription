import { describe, expect, it } from "vitest";
import { renderFfmpegCommand } from "../src/ffmpeg/render.js";

describe("renderFfmpegCommand", () => {
  it("renders fast trim copy for m4a", () => {
    const rendered = renderFfmpegCommand({
      inputPath: "/tmp/in.m4a",
      outputPath: "/tmp/out.m4a",
      isVideo: false,
      extractAudio: false,
      trimStart: "00:10:20",
      audioFormat: "m4a",
      audioBitrateKbps: 64,
      sampleRateHz: 16000,
      mono: false,
      normalize: false
    });

    expect(rendered.commandString).toMatchInlineSnapshot(
      '"ffmpeg -hide_banner -loglevel error -y -ss 00:10:20 -i /tmp/in.m4a -c copy /tmp/out.m4a"'
    );
  });

  it("renders extract+trim+mp3 re-encode for video", () => {
    const rendered = renderFfmpegCommand({
      inputPath: "/tmp/in.mp4",
      outputPath: "/tmp/out.mp3",
      isVideo: true,
      extractAudio: true,
      trimStart: "00:10:20",
      audioFormat: "mp3",
      audioBitrateKbps: 64,
      sampleRateHz: 16000,
      mono: true,
      normalize: false
    });

    expect(rendered.commandString).toMatchInlineSnapshot(
      '"ffmpeg -hide_banner -loglevel error -y -ss 00:10:20 -i /tmp/in.mp4 -vn -ac 1 -ar 16000 -b:a 64k /tmp/out.mp3"'
    );
  });

  it("renders normalization with re-encode", () => {
    const rendered = renderFfmpegCommand({
      inputPath: "/tmp/in.m4a",
      outputPath: "/tmp/out.m4a",
      isVideo: false,
      extractAudio: false,
      trimEnd: "00:12:00",
      audioFormat: "m4a",
      audioBitrateKbps: 64,
      sampleRateHz: 16000,
      mono: true,
      normalize: true
    });

    expect(rendered.commandString).toMatchInlineSnapshot(
      '"ffmpeg -hide_banner -loglevel error -y -i /tmp/in.m4a -to 00:12:00 -af loudnorm -ac 1 -ar 16000 -c:a aac /tmp/out.m4a"'
    );
  });
});

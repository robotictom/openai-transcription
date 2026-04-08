# openai-transcription (CLI) — SPEC

## Goal

Build a local CLI tool that:

1. takes a meeting recording (MP4/M4A/WAV/MP3),
2. optionally trims leading silence (e.g., skip first 00:10:20),
3. optionally extracts / compresses audio for upload,
4. submits it to OpenAI’s Transcriptions API using `gpt-4o-transcribe-diarize`,
5. saves structured outputs (speaker segments + plain text) to a directory.

Primary use case: transcribe public meetings with speaker diarization (speaker labels + timestamps).

## Non-goals

- Live/streaming transcription
- Real-time audio capture
- UI app
- Advanced VAD or custom diarization beyond what the model returns

## Key API facts (source of truth)

- Use the Audio API `audio/transcriptions` endpoint for speech-to-text.
- Use model `gpt-4o-transcribe-diarize` for speaker labels + timestamps (non-latency-sensitive workloads).
- To receive speaker annotations, request `response_format: "diarized_json"`.

## CLI Requirements

### Command

`openai-transcription transcribe <input> [options]`

### Options

- `--out-dir <path>` (default: `./out/<basename>-<timestamp>/`)
- `--trim-start <HH:MM:SS>` (optional; e.g., `00:10:20`)
- `--trim-end <HH:MM:SS>` (optional; if present, cut at this timestamp)
- `--extract-audio` (default true if input is video)
- `--audio-format <m4a|mp3|wav>` (default: `m4a`)
- `--audio-bitrate <kbps>` (default: `64` when mp3; ignored for m4a copy mode)
- `--sample-rate <hz>` (default: `16000` when re-encoding; otherwise keep)
- `--mono` (default true when re-encoding)
- `--normalize` (optional; apply loudness normalization via ffmpeg)
- `--model <string>` (default: `gpt-4o-transcribe-diarize`)
- `--response-format <diarized_json|json|text>` (default: `diarized_json`)
- `--language <bcp47>` (optional; pass through to API if provided)
- `--dry-run` (prints planned steps without running)
- `--keep-temp` (keep intermediate audio files)

### Exit codes

- `0` success
- `1` general failure
- `2` ffmpeg missing or failed
- `3` OpenAI API error
- `4` invalid arguments / input not found

## Behavior & Processing Pipeline

### 1) Validate environment

- Ensure input exists and is readable.
- Ensure `ffmpeg` is available (`ffmpeg -version`).
- Ensure `OPENAI_API_KEY` is set.

### 2) Prepare audio

If input is MP4 (video):

- Extract audio (no video stream) into a working audio file.

If `--trim-start/--trim-end` provided:

- Trim the media first (preferred: trim during extraction if video).
- Default approach should be stream copy when possible for speed, but re-encode when user requests mp3/wav or normalization.

Recommended ffmpeg strategies:

- Fast trim (copy) when output container/codecs allow:
    - `ffmpeg -ss <start> -i input.m4a -c copy out.m4a`
- Extract + trim from MP4 into m4a (copy if possible):
    - `ffmpeg -ss <start> -i input.mp4 -vn -acodec copy out.m4a`
- Speech-optimized mp3 (smaller files, consistent for upload):
    - `ffmpeg -ss <start> -i input.mp4 -vn -ac 1 -ar 16000 -b:a 64k out.mp3`

Normalization (if `--normalize`):

- Use a standard loudness filter (e.g., `loudnorm`) and re-encode.

### 3) Call OpenAI Transcriptions API

- POST to `audio/transcriptions`
- Send `file`, `model`, and `response_format`.
- For diarization, require `response_format="diarized_json"` and model `gpt-4o-transcribe-diarize`.

### 4) Save outputs

In `--out-dir`, write:

- `audio.<ext>` (final audio submitted to API)
- `transcript.diarized.json` (raw API response for diarization)
- `transcript.txt` (plain text transcript extracted from response)
- `transcript.md` (markdown formatted transcript extracted from response)
- `segments.json` (normalized segments array: speaker, start, end, text)
- `meta.json` (input file info, ffmpeg commands executed, timestamps, model, response_format)

Segment normalization:

- Use the diarized response’s segments list (speaker + timestamps) as the source of truth.
- Provide a stable internal schema:
    ```json
    {
        "speaker": "speaker_0",
        "start": 12.34,
        "end": 18.9,
        "text": "..."
    }
    ```

### 5) Console output

Print:

- input duration (if available)
- effective audio duration submitted
- model + response format
- output directory
- a brief summary: number of segments, number of speakers detected (unique speaker ids)

## Tech choices

- Language: Node.js (TypeScript)
- Packages:
    - `openai` official SDK
    - `commander` (CLI args)
    - `execa` (run ffmpeg)
    - `zod` (validate config and response shape)

- Target Node: 20+

## File structure

.
├─ package.json
├─ tsconfig.json
├─ src/
│ ├─ cli.ts
│ ├─ commands/
│ │ └─ transcribe.ts
│ ├─ ffmpeg/
│ │ ├─ probe.ts
│ │ └─ render.ts
│ ├─ openai/
│ │ └─ transcribe.ts
│ ├─ output/
│ │ └─ writers.ts
│ └─ types/
│ └─ diarized.ts
└─ README.md

## Testing

- Unit tests for:
    - argument parsing
    - ffmpeg command rendering (string snapshots)
    - diarized_json normalization (fixtures)

- Integration test (optional, gated):
    - requires `OPENAI_API_KEY`
    - runs on a short sample audio file (≤ 30 seconds)

## Documentation

README should include:

- install steps
- environment variable setup
- examples:
    - trim first 10:20 and diarize:
      `openai-transcription transcribe meeting.mp4 --trim-start 00:10:20`
    - force mp3 16k mono 64k:
      `openai-transcription transcribe meeting.mp4 --trim-start 00:10:20 --audio-format mp3 --sample-rate 16000 --audio-bitrate 64 --mono`

- notes on diarization output format and where speaker labels come from. ([OpenAI Developers][1])

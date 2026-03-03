# openai-transcription

`openai-transcription` is a Node.js (TypeScript) CLI that prepares audio with `ffmpeg` and transcribes it with OpenAI's Audio Transcriptions API.

## Requirements

- Node.js 20+
- `ffmpeg` + `ffprobe` in `PATH`
- `OPENAI_API_KEY` set in environment

## Install

```bash
npm install
npm run build
npm link
```

Then run:

```bash
openai-transcription transcribe <input> [options]
```

## Environment

```bash
export OPENAI_API_KEY="your_key_here"
```

## Usage

### Basic diarized transcription

```bash
openai-transcription transcribe meeting.mp4
```

### Trim first 10:20 and diarize

```bash
openai-transcription transcribe meeting.mp4 --trim-start 00:10:20
```

### Force MP3 16k mono 64k

```bash
openai-transcription transcribe meeting.mp4 --trim-start 00:10:20 --audio-format mp3 --sample-rate 16000 --audio-bitrate 64 --mono
```

### Dry run

```bash
openai-transcription transcribe meeting.mp4 --dry-run
```

## Options

- `--out-dir <path>` default `./out/<basename>-<timestamp>/`
- `--trim-start <HH:MM:SS>`
- `--trim-end <HH:MM:SS>`
- `--extract-audio`
- `--audio-format <m4a|mp3|wav>` default `m4a`
- `--audio-bitrate <kbps>` default `64` (MP3)
- `--sample-rate <hz>` default `16000` when re-encoding
- `--mono` default `true` when re-encoding
- `--normalize` apply `loudnorm`
- `--model <string>` default `gpt-4o-transcribe-diarize`
- `--response-format <diarized_json|json|text>` default `diarized_json`
- `--language <bcp47>` pass-through language hint
- `--dry-run`
- `--keep-temp`

## Output files

In `--out-dir` the CLI writes:

- `audio.<ext>` (the submitted audio)
- `transcript.diarized.json` (raw API response)
- `transcript.txt` (plain transcript)
- `transcript.md` (markdown transcript)
- `segments.json` normalized segments (`speaker`, `start`, `end`, `text`)
- `meta.json` input/config metadata + ffmpeg commands

## Exit codes

- `0` success
- `1` general failure
- `2` ffmpeg missing/failed
- `3` OpenAI API error
- `4` invalid args/input missing

## Notes on diarization

When using `model=gpt-4o-transcribe-diarize` with `response_format=diarized_json`, speaker labels and segment timestamps come directly from the model response segments.

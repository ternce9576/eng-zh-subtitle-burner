# eng-zh-subtitle-burner

Transcribe English audio, translate to Chinese, and burn or mux EN/ZH subtitles into video. Supports local translation via Ollama or cloud APIs (Claude, ChatGPT, Gemini).

## Prerequisites

- NVIDIA GPU with CUDA (for transcription and optional GPU encoding)
- Docker + Docker Compose
- ~15 GB disk space (CUDA image + whisper model + translation model)

## Setup (Docker — recommended)

### 1. Ensure GPU access

```sh
docker run --rm --gpus all nvidia/cuda:12.4.1-runtime-ubuntu22.04 nvidia-smi
```

If this fails, update your NVIDIA drivers. On WSL2, also enable Docker Desktop's WSL integration.

### 2. Clone the repo

```sh
git clone https://github.com/tomasvana10/eng-zh-subtitle-burner
cd eng-zh-subtitle-burner
```

### 3. Run

```sh
chmod +x run.sh
./run.sh ./input.mp4
```

First run takes several minutes (builds container, downloads models).

## Setup (local, no Docker)

Requires: Python 3.10+, Node.js 22+, pnpm, ffmpeg (with libass), CUDA toolkit.

```sh
pip install faster-whisper torch
pnpm install
pnpm build
```

Start an Ollama server separately, then:

```sh
node dist/src/cli.js ./input.mp4 --ollama-url http://localhost:11434
```

Or use a cloud API instead of Ollama:

```sh
node dist/src/cli.js ./input.mp4 --translate-via claude --api-key sk-ant-...
```

## Usage

```
subtitle-burner <input> [options]
```

### Output options

| Flag | Description |
|---|---|
| `-o, --output <path>` | Output file path (default: `<input>_subtitled.<ext>`) |
| `--soft` | Mux as soft subtitles (no re-encode, MKV output) |
| `--no-english` | Only show Chinese subtitles |
| `--crf <n>` | CRF quality for burn mode (default: 23, lower = better) |
| `--preset <name>` | Encoder preset (default: medium) |

### Translation options

| Flag | Description |
|---|---|
| `--translate-via <mode>` | `local` (default), `chatgpt`, `gemini`, or `claude` |
| `--api-key <key>` | API key (required for chatgpt/gemini/claude) |
| `--model <name>` | Model name — local ollama model or API model override (default: `qwen3:14b`) |
| `--ollama-url <url>` | Ollama server URL (default: `http://ollama:11434`) |
| `--batch-size <n>` | Translation batch size (default: 20) |
| `--fix-transcription` | Use AI to fix misheard words in transcription before translating |
| `--context <text>` | Additional context for AI — passed to both transcription fix AND translation. Strongly recommended for any video with jargon, slang, or proper nouns (e.g. `"youtuber plays minecraft hypixel bedwars, casual gaming commentary"`) |

### Transcription options

| Flag | Description |
|---|---|
| `--whisper-model <name>` | Whisper model (default: `deepdml/faster-whisper-large-v3-turbo-ct2`) |

### Subtitle styling

| Flag | Description |
|---|---|
| `--en-font-size <n>` | English font size (default: 16) |
| `--zh-font-size <n>` | Chinese font size (default: 18) |
| `--margin-v-en <n>` | English bottom margin (default: 12) |
| `--margin-v-zh <n>` | Chinese bottom margin (default: 38) |

## Examples

```sh
# Basic usage with local Ollama
./run.sh ./lecture.mp4

# Chinese-only subtitles, higher quality
./run.sh ./lecture.mp4 --no-english --crf 18

# Soft subtitles (no re-encode, fast)
./run.sh ./lecture.mp4 --soft

# Use Claude API for translation
./run.sh ./lecture.mp4 --translate-via claude --api-key sk-ant-...

# Use ChatGPT API
./run.sh ./lecture.mp4 --translate-via chatgpt --api-key sk-...

# Use Gemini API
./run.sh ./lecture.mp4 --translate-via gemini --api-key AIza...

# Custom output path and model
./run.sh ./lecture.mp4 -o ./output.mkv --model qwen3:8b

# Fix misheard words with video context
./run.sh ./gameplay.mp4 --translate-via chatgpt --api-key sk-... \
  --fix-transcription --context "youtuber plays minecraft hypixel bedwars"
```

## Getting the most natural Chinese

The translator is prompted to keep English game/community jargon (GG, OP, clutch, AFK,
Hypixel, Bedwars, etc.) verbatim and to use colloquial Chinese with appropriate particles
(啊、吧、嘛、咯). For best results:

- **Always use `--context`.** It is now passed to the translation step (not just
  transcription fix). A good context tells the model the genre, speaker style, and
  any unusual proper nouns. Examples:
  - `"youtuber plays minecraft hypixel bedwars, hype casual commentary"`
  - `"tech reviewer covers iphone 17 pro, neutral informative"`
  - `"valorant ranked gameplay with friends, lots of trash talk and game slang"`
- **Claude tends to produce the most natural idiomatic Chinese.** ChatGPT is solid; Gemini
  Flash is fast but more literal. If quality matters more than cost/speed, try
  `--translate-via claude --api-key sk-ant-...`.
- **Batch size 20–30 works well.** The translator now passes the last few translated
  pairs to each new batch as continuity context, so consistency is much better than v1.
- Watch the run output for `lines unparsed (kept original english)` warnings — if those
  appear, you have English fragments in your zh.srt; lower `--batch-size` and re-run.


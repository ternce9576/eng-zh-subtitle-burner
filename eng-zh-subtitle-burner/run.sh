#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CALLER_DIR="$(pwd)"

# Resolve the input BEFORE cd'ing into the script dir, otherwise a relative
# path from the caller (e.g. `new/creator/video.mkv`) would be resolved against
# the repo instead of the caller's cwd.
if [[ $# -gt 0 ]]; then
  INPUT_HOST="$(realpath "$1")"
  shift
else
  echo "usage: run.sh <input video> [options]" >&2
  exit 1
fi

cd "$SCRIPT_DIR"

# Check if using API translation (skip ollama setup if so)
USE_API=false
for arg in "$@"; do
  if [[ "$arg" == "--translate-via" ]]; then
    USE_API=__next__
  elif [[ "$USE_API" == "__next__" ]]; then
    [[ "$arg" == "local" || -z "$arg" ]] && USE_API=false || USE_API=true
  fi
done

docker compose build worker

if [[ "$USE_API" != "true" ]]; then
  docker compose up -d ollama

  echo "waiting for ollama..."
  until docker compose exec ollama ollama list &>/dev/null; do
    sleep 1
  done

  MODEL="${MODEL:-qwen3:14b}"
  if ! docker compose exec ollama ollama list | grep -q "${MODEL%%:*}"; then
    echo "pulling $MODEL..."
    docker compose exec ollama ollama pull "$MODEL"
  fi
fi

echo "running subtitle pipeline..."

# INPUT_HOST was resolved above, before the cd into SCRIPT_DIR.
INPUT_DIR="$(dirname "$INPUT_HOST")"
INPUT_NAME="$(basename "$INPUT_HOST")"

# /data = caller's cwd (for output), /input = input file's directory
# Forward API keys by NAME, not value — `-e VAR` makes docker read the value
# from this environment, so the key never lands in the container's command
# line where `ps` and `docker inspect` would expose it.
ENV_ARGS=()
for VAR in GEMINI_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY; do
  [[ -n "${!VAR:-}" ]] && ENV_ARGS+=(-e "$VAR")
done

HOST_DIR="$CALLER_DIR" docker compose run "${ENV_ARGS[@]}" -v "$INPUT_DIR:/input" --rm worker "/input/$INPUT_NAME" "$@"

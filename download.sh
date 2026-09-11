#!/bin/bash
# Downloads new uploads in the best available quality with their thumbnails,
# skips members-only and age-restricted videos, and reports any ids that are
# still missing at the end.
# source /mnt/c/Users/ternc/myenv/bin/activate

set -u
set -o pipefail

CHANNELS_FILE="channels.txt"
INPUT_DIR="incoming"          # downloads stored under incoming/<creator>/
DONE_DIR="done"          # thumbnails archived under done/<creator>/
DOWNLOAD_LIMIT="${DOWNLOAD_LIMIT:-10}"
STATE_DIR=".state"
SKIP_LIST=""
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
# SLEEP_BETWEEN_BATCHES=1800
# Short: under a systemd timer the NEXT scheduled run is the real retry.
# A long in-script sleep would block every subsequent run.
SLEEP_ON_FAILURE=120
MAX_CONSECUTIVE_FAILS=3

OUTPUT_CONTAINER="mkv"
# COOKIES_FLAG=( --cookies /mnt/d/wsl_work/cookies.txt )
COOKIES_FLAG=()

downloaded=0
consecutive_failures=0

command -v yt-dlp >/dev/null 2>&1 || { echo "Error: yt-dlp not found in PATH." >&2; exit 1; }
command -v ffmpeg  >/dev/null 2>&1 || { echo "Error: ffmpeg not found in PATH." >&2; exit 1; }

mkdir -p "$INPUT_DIR" "$DONE_DIR"

normalize_channels() {
  sed -i -e 's/\r$//' -e '$a\' "$CHANNELS_FILE"
}

# ---------- SIMPLE TITLES ----------
# Exactly what you asked: title only (no date, no id)
NAME_TEMPLATE="$YTDLP_NAME_TEMPLATE"

# Prefer 1080p60/720p60, then 1080p, then 720p, then best
# YTDLP_FORMAT_CHAIN now lives in lib.sh, shared with add-creator.sh.

# Robust settings + subtitle fetch (we’ll keep only one later)
YTDLP_COMMON=(
  -f "$YTDLP_FORMAT_CHAIN"
  --remux-video "$OUTPUT_CONTAINER"
  --ignore-errors
  --retries infinite
  --fragment-retries infinite
  -N 4
  --no-progress
  --no-part
  --no-continue
  --force-overwrites
  --force-ipv4
  --sleep-requests 1
  --min-sleep-interval 1
  --max-sleep-interval 3

  # No subtitles. YouTube's are rolling auto-captions with overlapping
  # timestamps, and the pipeline transcribes with whisper anyway -- it needs
  # word-level timings and its own segmentation, which a downloaded SRT
  # cannot provide. Fetching them was two wasted requests per video.

  # thumbnails
  --write-thumbnail
  --convert-thumbnails jpg
)

download_try() {
  local video_id="$1"
  local archive="$2"
  local outdir="$3"
  local client="$4"   # "", web, android, ios

  local log
  log=$(mktemp)

  if [[ -n "$client" ]]; then
    if yt-dlp \
      --download-archive "$archive" \
      --output "$outdir/$NAME_TEMPLATE" \
      --extractor-args "youtube:player_client=$client" \
      "${COOKIES_FLAG[@]}" \
      "${YTDLP_COMMON[@]}" \
      "https://www.youtube.com/watch?v=$video_id" \
      2> "$log"
    then
      rm -f "$log"
      return 0
    fi
  else
    if yt-dlp \
      --download-archive "$archive" \
      --output "$outdir/$NAME_TEMPLATE" \
      "${COOKIES_FLAG[@]}" \
      "${YTDLP_COMMON[@]}" \
      "https://www.youtube.com/watch?v=$video_id" \
      2> "$log"
    then
      rm -f "$log"
      return 0
    fi
  fi

  # If we reach here, yt-dlp failed. Members-only videos go to a SEPARATE skip
  # list, never the archive: an archived id is indistinguishable from a
  # successful download, so a video that later becomes public would never be
  # revisited. The skip list is hand-editable, and RETRY_SKIPPED=1 clears it.
  if grep -qi "members-only" "$log" || grep -qi "This video is available to this channel's members" "$log"; then
    echo "Skipping members-only video: $video_id (recorded in skip list)"
    mkdir -p "$STATE_DIR"
    grep -qxF "$video_id" "$SKIP_LIST" 2>/dev/null || echo "$video_id" >> "$SKIP_LIST"
    rm -f "$log"
    return 0
  fi

  # Age-restricted videos need a signed-in session. Deliberately not fetched:
  # what YouTube age-gates is what Bilibili is most likely to reject on review.
  # Without this they stay unarchived, so every single round picks the same one
  # up again, retries it, and fails -- jamming the queue behind one video.
  if grep -qi "Sign in to confirm your age" "$log" || grep -qi "age-restricted" "$log"; then
    echo "Skipping age-restricted video: $video_id (recorded in skip list)"
    mkdir -p "$STATE_DIR"
    grep -qxF "$video_id" "$SKIP_LIST" 2>/dev/null || echo "$video_id" >> "$SKIP_LIST"
    rm -f "$log"
    return 0
  fi

  # Other errors: show log, fail this attempt
  cat "$log" >&2
  rm -f "$log"
  return 1
}

download_with_clients() {
  local video_id="$1"
  local archive="$2"
  local outdir="$3"

  download_try "$video_id" "$archive" "$outdir" ""        && return 0
  download_try "$video_id" "$archive" "$outdir" "web"     && return 0
  download_try "$video_id" "$archive" "$outdir" "android" && return 0
  download_try "$video_id" "$archive" "$outdir" "ios"
}

# Move latest thumbnail (simple name) into done/<creator>/
move_latest_thumb() {
  local from_dir="$1"
  local to_dir="$2"
  # the latest converted jpg will already match the simple title base
  local jpg
  jpg=$(ls -t "$from_dir"/*.jpg 2>/dev/null | head -n 1 || true)
  [[ -n "${jpg:-}" ]] && mv -f -- "$jpg" "$to_dir/"
}

fetch_next_video() {
  local creator="$1"
  local url="$2"
  local dir="$INPUT_DIR/$creator"
  local done_dir="$DONE_DIR/$creator"
  local archive="$dir/downloaded.txt"

  SKIP_LIST="$STATE_DIR/skipped-$creator.list"
  mkdir -p "$dir" "$done_dir" "$STATE_DIR"
  touch "$archive" "$SKIP_LIST"
  # RETRY_SKIPPED=1 forgets previous skips (members-only videos often unlock).
  [[ "${RETRY_SKIPPED:-0}" == "1" ]] && : > "$SKIP_LIST"

  # Oldest-first id that is not already downloaded, not members-only, and
  # inside the processable duration range. Out-of-range videos (shorts,
  # streams) are RECORDED as filtered rather than silently dropped, so the
  # audit can distinguish them from videos that were genuinely missed.
  local video_id=""
  local candidate dur
  while read -r candidate; do
    [[ -n "$candidate" ]] || continue
    grep -qF "youtube $candidate" "$archive" 2>/dev/null && continue
    grep -qxF "$candidate" "$SKIP_LIST" 2>/dev/null && continue
    is_filtered "$creator" "$candidate" && continue

    dur=$(duration_for "$creator" "$candidate")
    if ! duration_ok "$dur"; then
      if awk -v d="$dur" -v lo="$MIN_DURATION" 'BEGIN{exit !(d+0<=lo)}' 2>/dev/null; then
        mark_filtered "$creator" "$candidate" "short(${dur}s)"
      else
        mark_filtered "$creator" "$candidate" "long(${dur}s)"
      fi
      continue
    fi

    video_id="$candidate"
    break
  done < <(yt-dlp --flat-playlist --print "%(id)s" --playlist-reverse \
            --match-filter "!is_live" \
            "${COOKIES_FLAG[@]}" \
            "$url" 2>/dev/null)

  [[ -n "${video_id:-}" ]] || return 1

  # Try up to 3 rounds
  local attempt=1
  while (( attempt <= 3 )); do
    if download_with_clients "$video_id" "$archive" "$dir"; then
      # At this point, files are: "<Title>.mkv", "<Title>.(lang).srt", "<Title>.jpg"
      move_latest_thumb "$dir" "$done_dir"

      # Use the plain title (strip extension) as base
      # Find the mkv we just wrote to get the exact title
      local mkv
      mkv=$(ls -t "$dir"/*.mkv 2>/dev/null | head -n 1 || true)
      if [[ -n "${mkv:-}" ]]; then
        local title_base; title_base="$(basename "$mkv" .mkv)"
        # Remember which YouTube video this file came from. Bilibili requires
        # a 转载来源 URL for reposted uploads, and the id is otherwise gone the
        # moment the download finishes -- the filename is the title, not the id.
        mkdir -p "$STATE_DIR"
        local map="$STATE_DIR/videoids-$(basename "$dir").tsv"
        touch "$map"
        grep -qF "	$title_base" "$map" 2>/dev/null \
          || printf '%s\t%s\n' "$video_id" "$title_base" >> "$map"
      fi
      return 0
    else
      ((attempt++))
      sleep 300
    fi
  done

  return 1
}

report_missing_ids() {
  echo "=== Missing video IDs per channel (not in downloaded.txt) ==="
  while IFS="|" read -r creator url _rest; do
    [[ -z "${creator:-}" || -z "${url:-}" ]] && continue

    local dir="$INPUT_DIR/$creator"
    local archive="$dir/downloaded.txt"

    mkdir -p "$dir"
    touch "$archive"

    # Build set of already-archived IDs ("youtube <id>")
    local line
    local -A seen=()
    while IFS= read -r line; do
      [[ "$line" =~ ^youtube[[:space:]]+ ]] || continue
      id="${line#youtube }"
      id="${id%%[[:space:]]*}"
      seen["$id"]=1
    done < "$archive"


    # Get full playlist IDs for the channel, earliest first
    mapfile -t all_ids < <(yt-dlp --flat-playlist --playlist-reverse \
      --print "youtube %(id)s" \
      "${COOKIES_FLAG[@]}" \
      "$url" 2>/dev/null || true)

    local missing_any=0
    for vid in "${all_ids[@]}"; do
      [[ "$vid" =~ ^youtube[[:space:]]+ ]] || continue
      id="${vid#youtube }"
      id="${id%%[[:space:]]*}"
      if [[ -z "${seen["$id"]+x}" ]]; then
        echo "$vid"
      fi
    done


    (( missing_any == 1 )) && echo
  done < "$CHANNELS_FILE"
}

main_loop() {
  normalize_channels
  while true; do
    round_downloaded=0
    while IFS="|" read -r creator url _rest; do
      [[ -z "${creator:-}" || -z "${url:-}" ]] && continue

      if fetch_next_video "$creator" "$url"; then
        ((downloaded++))
        consecutive_failures=0
        round_downloaded=1
      else
        ((consecutive_failures++))
        if ((consecutive_failures >= MAX_CONSECUTIVE_FAILS)); then
          sleep "$SLEEP_ON_FAILURE"
          consecutive_failures=0
        fi
      fi

      if ((downloaded >= DOWNLOAD_LIMIT)); then
        # A real cap. Resetting the counter here instead (as this used to)
        # meant the loop never stopped, so a first run on a daily uploader
        # would pull their entire back catalogue in one pass. Under the timer
        # the next scheduled run picks the backlog up where this one left off.
        echo "reached DOWNLOAD_LIMIT ($DOWNLOAD_LIMIT) — the next run continues the backlog"
        report_missing_ids
        exit 0
      fi
    done < "$CHANNELS_FILE"

    if (( round_downloaded == 0 )); then
      # Nothing new downloaded this pass; report missing IDs and exit.
      report_missing_ids
      exit 0
    fi
  done
}

main_loop

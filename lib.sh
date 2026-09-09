#!/usr/bin/env bash
# Shared helpers for download.sh and orchestrate.sh.

# Only regular videos get processed. Shorts and multi-hour streams are skipped
# ON PURPOSE — but they are RECORDED as filtered rather than silently dropped,
# so the audit can tell "deliberately not processed" apart from "missed".
MIN_DURATION="${MIN_DURATION:-181}"    # < 3 min  -> short
MAX_DURATION="${MAX_DURATION:-6000}"   # > 100 min -> stream/vod

STATE_DIR="${STATE_DIR:-.state}"

# Duration isn't present in a flat playlist listing (yt-dlp returns NA), so it
# costs one metadata request per video. Cache it permanently: the first audit
# pays for the whole back catalogue, every run after that only fetches ids it
# has never seen.
duration_for() {
  local creator="$1" id="$2"
  local cache="$STATE_DIR/durations-$creator.tsv"
  mkdir -p "$STATE_DIR"; touch "$cache"

  local hit
  hit=$(grep -m1 -P "^\Q$id\E\t" "$cache" 2>/dev/null | cut -f2)
  if [[ -z "$hit" ]]; then
    hit=$(grep -m1 "^$id	" "$cache" 2>/dev/null | cut -f2)
  fi
  if [[ -n "$hit" ]]; then printf '%s' "$hit"; return 0; fi

  local d
  d=$(yt-dlp --skip-download --no-warnings --print "%(duration)s" \
        "https://www.youtube.com/watch?v=$id" 2>/dev/null | head -1)
  [[ -z "$d" ]] && d="NA"
  printf '%s\t%s\n' "$id" "$d" >> "$cache"
  printf '%s' "$d"
}

# True when a duration is in the processable range.
# An unknown duration deliberately passes: failing OPEN means a video might get
# processed unnecessarily, while failing closed would mean silently missing one.
duration_ok() {
  local d="$1"
  [[ -z "$d" || "$d" == "NA" || "$d" == "None" ]] && return 0
  awk -v d="$d" -v lo="$MIN_DURATION" -v hi="$MAX_DURATION" \
    'BEGIN{exit !(d+0>lo && d+0<hi)}'
}

# Records an id as intentionally filtered, with the reason, so the audit can
# account for it instead of reporting it missing.
mark_filtered() {
  local creator="$1" id="$2" reason="$3"
  local f="$STATE_DIR/filtered-$creator.list"
  mkdir -p "$STATE_DIR"; touch "$f"
  grep -q "^$id	" "$f" 2>/dev/null || printf '%s\t%s\n' "$id" "$reason" >> "$f"
}

is_filtered() {
  local creator="$1" id="$2"
  grep -q "^$id	" "$STATE_DIR/filtered-$creator.list" 2>/dev/null
}

# Download shape, shared by download.sh and add-creator.sh so a sample video
# fetched during onboarding is byte-for-byte what the pipeline would have
# fetched later -- otherwise the caption analysis runs against a different
# resolution than the one that gets burned.
YTDLP_NAME_TEMPLATE='%(title).200s.%(ext)s'
YTDLP_FORMAT_CHAIN='299+140/298+140/bv*[height>=1080][ext=mp4]+ba[ext=m4a]/bv*[height>=1080]+ba/bv*[height>=720]+ba/best'

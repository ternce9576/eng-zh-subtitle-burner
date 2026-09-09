#!/usr/bin/env bash
#
# End-to-end: watch channels -> download new uploads -> burn EN/ZH subtitles ->
# park the finished MP4 and its thumbnail in done/<creator>/ ready to upload.
#
#   ./run.sh                  # normal run
#   ./run.sh --full           # skip the RSS gate, ask yt-dlp directly
#   ./run.sh --no-download    # process what's already in incoming/
#   ./run.sh --audit-only     # just check nothing has been missed
#   ./run.sh --only "Part 2"  # process only matching filenames
#
# Env knobs:
#   CONCURRENCY=8         translation batches in parallel (default 4)
#   YTDLP_MAX_AGE_DAYS=7  how often to refresh yt-dlp (default 14)
#   FIX_TRANSCRIPTION=1   enable the AI transcription-fix pass (doubles API cost)
#   BATCH_SIZE=20         lines per translation request (default 40)
#   MODEL=gemini-3.7-flash  cheaper/faster translator (lower quality)
#   EN_FONT / ZH_FONT / OUTLINE   subtitle styling overrides
#
# channels.txt 4th field controls burned languages:
#   zh    -> Chinese only (creator already burns their own English captions)
#   both  -> Chinese + English (default, for creators with no on-screen subs)
#   DELETE_SOURCE=1       remove incoming/<creator>/<video> after a successful burn
#   RETRY_SKIPPED=1       forget members-only skips and retry them
#   DOWNLOAD_LIMIT=1      cap new downloads per run (default 10)
#
# channels.txt format — add creators with ./add-creator.sh, which fills in
# fields 4 and 5 by measuring one of their videos:
#   creator|url|context|sub_mode|zh_margin
#
# A glossary at glossary/<creator>.txt, if present, is picked up automatically:
# its terms bias transcription and pin how they come out in Chinese.
#
set -uo pipefail
cd "$(dirname "$0")"

# One run at a time. An hourly timer will happily start a second run while the
# first is still burning a 20-minute video; both would then pick the same file
# out of incoming/ and both would append it to the ledger. flock releases the
# lock automatically if the run is killed, so a crash can't wedge the pipeline.
mkdir -p .state
LOCK_FILE="${LOCK_FILE:-/var/lock/subtitle-pipeline.lock}"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "another run is already in progress ($LOCK_FILE) — exiting" >&2
  exit 0
fi

CHANNELS_FILE="channels.txt"
NEW_DIR="incoming"
GLOSSARY_DIR="${GLOSSARY_DIR:-glossary}"
DONE_DIR="done"
SUBS_DIR="sub"
BURNER_DIR="eng-zh-subtitle-burner"
STATE_DIR=".state"
CHANNEL_IDS="$STATE_DIR/channel_ids"
LEDGER="$STATE_DIR/completed.list"
FAIL_LOG="$STATE_DIR/failures.log"
MISSING_LOG="$STATE_DIR/missing.log"

# yt-dlp rots fast: YouTube changes extraction every few weeks and a stale
# build fails EVERY download with HTTP 403. Left alone, the pipeline would run
# hourly, download nothing, and the only symptom would be the audit quietly
# reporting videos as missing. Refresh it on a schedule instead.
YTDLP_MAX_AGE_DAYS="${YTDLP_MAX_AGE_DAYS:-14}"

DEFAULT_CONTEXT="youtuber plays minecraft hypixel bedwars, casual gaming commentary"
TRANSLATE_VIA="gemini"
CONCURRENCY="${CONCURRENCY:-4}"
# Off by default: measured at 173s of a 449s run (~half the API spend) for no
# visible translation gain — --context already handles the jargon it was there
# to fix. FIX_TRANSCRIPTION=1 restores it.
FIX_TRANSCRIPTION="${FIX_TRANSCRIPTION:-0}"
# 40 tested clean (zero parse failures). Bigger batches re-send the ~2k-token
# system prompt fewer times, which is most of the per-line cost.
BATCH_SIZE="${BATCH_SIZE:-40}"
# Subtitle fonts. Poppins ExtraBold matches the heavy geometric captions
# creators burn into gaming footage; Noto Sans CJK SC carries the Chinese.
EN_FONT="${EN_FONT:-Poppins ExtraBold}"
ZH_FONT="${ZH_FONT:-Noto Sans CJK SC Black}"
OUTLINE="${OUTLINE:-4}"
# Flash chosen 2026-09-02 after a four-way comparison: punchier slang peaks
# (纯被当狗遛了属于是, 负reach) at a fraction of Pro's cost. Trade-off is
# occasional off-source or malformed lines — ~1 drift per 60 in one sample,
# 3/40 degraded in another. MODEL=gemini-3.1-pro-preview reverts to Pro,
# which showed no such defects.
MODEL="${MODEL:-gemini-3.7-flash}"
DELETE_SOURCE="${DELETE_SOURCE:-0}"

DO_DOWNLOAD=1
FORCE_FULL=0
AUDIT_ONLY=0
ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-download) DO_DOWNLOAD=0 ;;
    --full) FORCE_FULL=1 ;;
    --audit-only) AUDIT_ONLY=1; DO_DOWNLOAD=0 ;;
    # Process only videos whose filename contains this substring. Handy for
    # testing one video end to end without touching the rest of the backlog.
    --only) shift; ONLY="${1:-}" ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

mkdir -p "$STATE_DIR" "$NEW_DIR" "$DONE_DIR" "$SUBS_DIR"
touch "$CHANNEL_IDS" "$LEDGER" "$FAIL_LOG" "$MISSING_LOG"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
# Windows toast, via WSL interop. Best-effort: every notification is also
# appended to the log, so nothing depends on the toast actually appearing.
# ---------------------------------------------------------------------------
notify() {
  local title="$1" body="$2"
  printf '%s  %s — %s\n' "$(date -Is)" "$title" "$body" >> "$STATE_DIR/notifications.log"
  command -v powershell.exe >/dev/null 2>&1 || return 0
  powershell.exe -NoProfile -NonInteractive -Command "
    \$ErrorActionPreference='SilentlyContinue'
    [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]>\$null
    \$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    \$n=\$t.GetElementsByTagName('text')
    \$n.Item(0).AppendChild(\$t.CreateTextNode('$title'))>\$null
    \$n.Item(1).AppendChild(\$t.CreateTextNode('$body'))>\$null
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Subtitle Pipeline').Show(\$t)
  " >/dev/null 2>&1 || true
}

command -v yt-dlp  >/dev/null || { echo "yt-dlp not found" >&2; exit 1; }
command -v curl    >/dev/null || { echo "curl not found" >&2; exit 1; }
command -v ffprobe >/dev/null || { echo "ffprobe not found" >&2; exit 1; }
if [[ -z "${GEMINI_API_KEY:-}" && $AUDIT_ONLY -eq 0 ]]; then
  echo "GEMINI_API_KEY is not set — export it before running." >&2
  exit 1
fi

channel_id_for() {
  local creator="$1" url="$2" cached
  cached=$(grep -m1 "^${creator}|" "$CHANNEL_IDS" 2>/dev/null | cut -d'|' -f2)
  if [[ -n "$cached" ]]; then printf '%s' "$cached"; return 0; fi
  local cid
  cid=$(yt-dlp --flat-playlist --playlist-items 1 --print channel_id "$url" 2>/dev/null | head -n1)
  [[ -n "$cid" ]] || return 1
  printf '%s|%s\n' "$creator" "$cid" >> "$CHANNEL_IDS"
  printf '%s' "$cid"
}

# RSS lists only the ~15 newest uploads, so it can CONFIRM new videos but never
# rule out an older backlog — hence every uncertain case falls through to yt-dlp.
channel_has_new() {
  local creator="$1" url="$2"
  local archive="$NEW_DIR/$creator/downloaded.txt"
  [[ $FORCE_FULL -eq 1 ]] && return 0
  [[ -s "$archive" ]] || return 0
  local cid; cid=$(channel_id_for "$creator" "$url") || return 0
  local feed
  feed=$(curl -sf --max-time 20 "https://www.youtube.com/feeds/videos.xml?channel_id=$cid") || return 0
  [[ -n "$feed" ]] || return 0
  local id
  while read -r id; do
    [[ -n "$id" ]] || continue
    grep -qF "youtube $id" "$archive" || return 0
  done < <(printf '%s' "$feed" | grep -o '<yt:videoId>[^<]*' | sed 's/.*>//')
  return 1
}

# A shutdown mid-download leaves a truncated file that looks fine (download.sh
# runs with --no-part). Compare decoded duration against container metadata.
video_is_intact() {
  local f="$1" dur
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null)
  [[ -n "$dur" ]] || return 1
  awk -v d="$dur" 'BEGIN{exit !(d>1)}' || return 1
  return 0
}

ledger_has() { grep -qxF "$1" "$LEDGER" 2>/dev/null; }

# A video that fails for a structural reason -- a corrupt download, an
# unsupported stream -- fails identically every hour, forever. Count attempts
# so it gets set aside and reported instead of quietly eating a GPU slot on
# every run.
BURN_ATTEMPTS="$STATE_DIR/burn-attempts.tsv"
MAX_BURN_ATTEMPTS="${MAX_BURN_ATTEMPTS:-3}"

burn_attempts_for() {
  grep -m1 -F "$1	" "$BURN_ATTEMPTS" 2>/dev/null | cut -f2
}

burn_exhausted() {
  local n; n=$(burn_attempts_for "$1")
  [[ -n "$n" ]] && (( n >= MAX_BURN_ATTEMPTS ))
}

# Called from parallel burn jobs, so the read-modify-write needs serialising.
record_burn_failure() {
  local key="$1" n
  exec 8>>"$STATE_DIR/.attempts.lock"; flock 8
  n=$(burn_attempts_for "$key"); n=$(( ${n:-0} + 1 ))
  mkdir -p "$STATE_DIR"; touch "$BURN_ATTEMPTS"
  grep -v -F "$key	" "$BURN_ATTEMPTS" > "$BURN_ATTEMPTS.tmp" 2>/dev/null || true
  printf '%s\t%s\n' "$key" "$n" >> "$BURN_ATTEMPTS.tmp"
  mv -f "$BURN_ATTEMPTS.tmp" "$BURN_ATTEMPTS"
  printf '%s' "$n"
}

clear_burn_failures() {
  [[ -f "$BURN_ATTEMPTS" ]] || return 0
  grep -v -F "$1	" "$BURN_ATTEMPTS" > "$BURN_ATTEMPTS.tmp" 2>/dev/null || true
  mv -f "$BURN_ATTEMPTS.tmp" "$BURN_ATTEMPTS"
}

ensure_ytdlp_fresh() {
  local stamp="$STATE_DIR/ytdlp-updated" now age
  now=$(date +%s)
  if [[ -f "$stamp" ]]; then
    age=$(( (now - $(cat "$stamp" 2>/dev/null || echo 0)) / 86400 ))
    (( age < YTDLP_MAX_AGE_DAYS )) && return 0
  fi
  local before after
  before=$(yt-dlp --version 2>/dev/null)
  log "Refreshing yt-dlp (last checked ${age:-never} days ago)"
  # Prefer the standalone build: it bundles its own Python, so updates keep
  # arriving after yt-dlp drops support for whatever the distro ships. A stale
  # yt-dlp means HTTP 403 on every download, which reads as "creator posted
  # nothing" -- a silent miss, the one failure mode that matters here.
  if [[ -w "$(dirname "$(command -v yt-dlp 2>/dev/null || echo /usr/local/bin/yt-dlp)")" ]] \
     && curl -fsSL -o "$STATE_DIR/yt-dlp.new" \
          "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" 2>/dev/null \
     && chmod +x "$STATE_DIR/yt-dlp.new" \
     && "$STATE_DIR/yt-dlp.new" --version >/dev/null 2>&1; then
    mv -f "$STATE_DIR/yt-dlp.new" "$(command -v yt-dlp 2>/dev/null || echo /usr/local/bin/yt-dlp)"
  else
    rm -f "$STATE_DIR/yt-dlp.new"
    python3 -m pip install -U yt-dlp >/dev/null 2>&1 \
      || pip install -U yt-dlp >/dev/null 2>&1 \
      || echo "  warning: could not update yt-dlp" >&2
  fi
  after=$(yt-dlp --version 2>/dev/null)
  echo "$now" > "$stamp"
  if [[ -n "$after" && "$before" != "$after" ]]; then
    echo "  yt-dlp $before -> $after"
    notify "yt-dlp updated" "$before -> $after"
  fi
}

# ---------------------------------------------------------------------------
# 1. Download
# ---------------------------------------------------------------------------
if [[ $DO_DOWNLOAD -eq 1 ]]; then
  ensure_ytdlp_fresh
  any_new=0
  while IFS="|" read -r creator url _context; do
    [[ -z "${creator:-}" || -z "${url:-}" ]] && continue
    [[ "$creator" == \#* ]] && continue
    if channel_has_new "$creator" "$url"; then
      log "New uploads detected for $creator"
      any_new=1
    else
      log "$creator is up to date (RSS)"
    fi
  done < <(sed -e 's/\r$//' "$CHANNELS_FILE")

  if [[ $any_new -eq 1 ]]; then
    ./download.sh || echo "download.sh exited non-zero — continuing" >&2
  fi
fi

# ---------------------------------------------------------------------------
# 2. Burn
# ---------------------------------------------------------------------------
processed=0; skipped=0; failed=0; broken=0
declare -a ready=()

# Burning one video at a time leaves the machine idle. Measured on an RTX
# 5070 Ti, each concurrent burn costs roughly 23% of the NVENC encoder: two
# jobs sat at 51%, four at 89-95% -- saturated, and the machine felt slow to
# use. Three is the practical ceiling. Higher also multiplies whisper's VRAM
# copies and the per-video translation concurrency into API rate limits.
MAX_PARALLEL="${MAX_PARALLEL:-3}"
JOB_DIR=$(mktemp -d)
trap 'rm -rf "$JOB_DIR"' EXIT

# Runs one video to completion and does its own bookkeeping, because a
# background job cannot update the parent's counters. Results are left as
# files for the parent to tally once every job has finished.
burn_one() {
  local video="$1" creator="$2" base="$3" out_dir="$4" tag="$5"; shift 5
  local rc=0
  # Two jobs write to the same log, so every line is prefixed with the video
  # it belongs to -- otherwise the two progress bars are indistinguishable.
  { "./$BURNER_DIR/run.sh" "$@" </dev/null; echo $? > "$JOB_DIR/rc.$tag"; } 2>&1 \
    | sed -u "s/^/[$base] /"
  rc=$(cat "$JOB_DIR/rc.$tag" 2>/dev/null || echo 1)

  if [[ "$rc" == "0" ]]; then
    # A single short append is atomic on Linux, so concurrent jobs can share
    # the ledger without a lock.
    echo "$creator/$base" >> "$LEDGER"
    clear_burn_failures "$creator/$base"
    [[ -f "$NEW_DIR/$creator/$base.jpg" ]] && mv -f -- "$NEW_DIR/$creator/$base.jpg" "$out_dir/"
    [[ "$DELETE_SOURCE" == "1" ]] && rm -f -- "$video"
    printf '%s\n' "$base" > "$JOB_DIR/ok.$tag"
  else
    local attempts
    attempts=$(record_burn_failure "$creator/$base")
    echo "$(date -Is) FAILED (attempt $attempts/$MAX_BURN_ATTEMPTS) $video" >> "$FAIL_LOG"
    if (( attempts >= MAX_BURN_ATTEMPTS )); then
      echo "!! failed: $base — giving up after $attempts attempts" >&2
    else
      echo "!! failed: $base (attempt $attempts/$MAX_BURN_ATTEMPTS)" >&2
    fi
    printf '%s\n' "$base" > "$JOB_DIR/fail.$tag"
  fi
}

job_tag=0
if [[ $AUDIT_ONLY -eq 0 ]]; then
  while IFS= read -r -d '' video; do
    rel="${video#$NEW_DIR/}"
    creator="$(dirname "$rel")"
    base="$(basename "$video")"; base="${base%.*}"
    [[ "$base" == *_subtitled ]] && continue
    if [[ -n "$ONLY" && "$base" != *"$ONLY"* ]]; then continue; fi

    # The ledger — not the presence of the output file — is the record of
    # completion, so you can delete an uploaded video without it coming back.
    if ledger_has "$creator/$base"; then skipped=$((skipped+1)); continue; fi
    if burn_exhausted "$creator/$base"; then
      broken=$((broken+1))
      continue
    fi

    if ! video_is_intact "$video"; then
      broken=$((broken+1))
      echo "$(date -Is) TRUNCATED $video" >> "$FAIL_LOG"
      echo "!! unreadable/truncated, skipping: $base" >&2
      continue
    fi

    out_dir="$DONE_DIR/$creator"; mkdir -p "$out_dir" "$SUBS_DIR/$creator"
    out="$out_dir/$base.mp4"

    context="$DEFAULT_CONTEXT"
    chan_context=$(grep -m1 "^${creator}|" "$CHANNELS_FILE" 2>/dev/null | cut -d'|' -f3 | sed 's/\r$//')
    [[ -n "$chan_context" ]] && context="$chan_context"

    # 4th field of channels.txt: "zh" burns Chinese only (the creator already
    # burns their own English captions into the frame, so a second English
    # line would just stack on top of theirs). Anything else = both languages.
    # This can't be auto-detected: burned-in captions are pixels, not a
    # subtitle track, so ffprobe sees nothing.
    sub_mode=$(grep -m1 "^${creator}|" "$CHANNELS_FILE" 2>/dev/null | cut -d'|' -f4 | sed 's/\r$//' | tr -d ' ')
    [[ -z "$sub_mode" ]] && sub_mode="both"

    # 5th field: how far off the bottom of the frame the Chinese line sits, in
    # ASS units (PlayResY is 288, so 288 = top of frame). Creators who burn
    # their own captions mid-frame need ours lifted clear of theirs; the
    # position of that band differs per creator, so it can't be a global.
    zh_margin=$(grep -m1 "^${creator}|" "$CHANNELS_FILE" 2>/dev/null | cut -d'|' -f5 | sed 's/\r$//' | tr -d ' ')

    log "Processing [$creator] $base"
    args=(
      "$video" -o "$out"
      --ass-out "$SUBS_DIR/$creator/$base.ass"
      --translate-via "$TRANSLATE_VIA"
      --concurrency "$CONCURRENCY"
      --batch-size "$BATCH_SIZE"
      --context "$context"
      --en-font "$EN_FONT"
      --zh-font "$ZH_FONT"
      --outline "$OUTLINE"
    )
    [[ "$sub_mode" == "zh" ]] && args+=(--chinese-only)
    [[ -n "$zh_margin" ]] && args+=(--margin-v-zh "$zh_margin")
    # Per-creator term list, if one exists. Biases transcription toward names
    # whisper would otherwise mishear, and pins how they come out in Chinese.
    [[ -f "$GLOSSARY_DIR/$creator.txt" ]] && args+=(--glossary "$GLOSSARY_DIR/$creator.txt")
    [[ -n "$MODEL" ]] && args+=(--model "$MODEL")
    [[ "$FIX_TRANSCRIPTION" == "1" ]] && args+=(--fix-transcription)

    # Wait for a free slot before starting the next one.
    while (( $(jobs -rp | wc -l) >= MAX_PARALLEL )); do wait -n; done
    job_tag=$((job_tag + 1))
    burn_one "$video" "$creator" "$base" "$out_dir" "$job_tag" "${args[@]}" </dev/null &
  # An interrupted download leaves fragments like "Title.f299.mp4" behind.
  # Without the prune they are queued as videos, fail, and are retried on
  # every single run.
  done < <(find "$NEW_DIR" -type f \( -name '*.mkv' -o -name '*.mp4' \) \
             ! -name '*.f[0-9]*.mp4' ! -name '*.part' -print0 | sort -z)

  wait
  processed=$(ls "$JOB_DIR"/ok.* 2>/dev/null | wc -l)
  failed=$((failed + $(ls "$JOB_DIR"/fail.* 2>/dev/null | wc -l)))
  mapfile -t ready < <(cat "$JOB_DIR"/ok.* 2>/dev/null)
fi

# ---------------------------------------------------------------------------
# 3. Audit — the actual "nothing was missed" guarantee.
#
# Doesn't trust RSS or the download loop: pulls the channel's full video list
# and checks every id is either downloaded or explicitly skipped.
# ---------------------------------------------------------------------------
log "Auditing channels"
: > "$MISSING_LOG"
missing_total=0
while IFS="|" read -r creator url _context; do
  [[ -z "${creator:-}" || -z "${url:-}" ]] && continue
  [[ "$creator" == \#* ]] && continue

  archive="$NEW_DIR/$creator/downloaded.txt"
  skip="$STATE_DIR/skipped-$creator.list"
  touch "$archive" "$skip" "$STATE_DIR/filtered-$creator.list" 2>/dev/null

  missing=0; filtered_now=0
  while read -r id; do
    [[ -n "$id" ]] || continue
    grep -qF "youtube $id" "$archive" 2>/dev/null && continue
    grep -qxF "$id" "$skip" 2>/dev/null && continue
    is_filtered "$creator" "$id" && continue

    # Not seen before — classify it. Shorts and streams are recorded as
    # deliberately filtered; anything in range that isn't downloaded is a
    # genuine miss and gets reported.
    dur=$(duration_for "$creator" "$id")
    if ! duration_ok "$dur"; then
      if awk -v d="$dur" -v lo="$MIN_DURATION" 'BEGIN{exit !(d+0<=lo)}' 2>/dev/null; then
        mark_filtered "$creator" "$id" "short(${dur}s)"
      else
        mark_filtered "$creator" "$id" "long(${dur}s)"
      fi
      filtered_now=$((filtered_now+1))
      continue
    fi

    echo "$creator https://www.youtube.com/watch?v=$id (${dur}s)" >> "$MISSING_LOG"
    missing=$((missing+1))
  done < <(yt-dlp --flat-playlist --print "%(id)s" --match-filter "!is_live" "$url" 2>/dev/null)

  skipped_n=$(wc -l < "$skip" 2>/dev/null | tr -d ' ')
  filtered_n=$(wc -l < "$STATE_DIR/filtered-$creator.list" 2>/dev/null | tr -d ' ')
  echo "  $creator: $missing missing, ${filtered_n:-0} filtered (shorts/streams), ${skipped_n:-0} members-only"
  missing_total=$((missing_total + missing))
done < <(sed -e 's/\r$//' "$CHANNELS_FILE")

# ---------------------------------------------------------------------------
# 4. Report
# ---------------------------------------------------------------------------
log "$processed processed, $skipped already done, $failed failed, $broken truncated"

if [[ $processed -gt 0 ]]; then
  notify "$processed video(s) ready to upload" "$(printf '%s; ' "${ready[@]}" | cut -c1-150)"
fi
if [[ $failed -gt 0 || $broken -gt 0 ]]; then
  notify "Subtitle pipeline had $((failed + broken)) failure(s)" "See .state/failures.log"
fi
if [[ $missing_total -gt 0 ]]; then
  notify "$missing_total video(s) NOT downloaded" "See .state/missing.log"
  echo "!! $missing_total video(s) missing — see $MISSING_LOG" >&2
fi

[[ $failed -gt 0 || $broken -gt 0 || $missing_total -gt 0 ]] && exit 1
exit 0

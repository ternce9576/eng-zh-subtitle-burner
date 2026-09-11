#!/usr/bin/env bash
#
# End-to-end: watch channels -> download new uploads -> burn EN/ZH subtitles ->
# park the finished MP4 and its thumbnail in done/<creator>/ ready to upload.
#
#   ./run.sh                  # normal run
#   ./run.sh --full           # skip the RSS gate, ask yt-dlp directly
#   ./run.sh --no-download    # process what's already in incoming/
#   ./run.sh --audit-only     # just check nothing has been missed
#   ./run.sh --upload-only    # upload finished videos that were burned earlier
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

# Keep the unattended log from growing without limit -- it is the only record
# of what happened overnight, and an unbounded one eventually becomes too big
# to open. Copy and truncate rather than rename: systemd holds the file open,
# and a rename would leave it writing to a file nothing can find. Its append
# mode means writes resume at offset zero after the truncate.
PIPELINE_LOG="${PIPELINE_LOG:-.state/pipeline.log}"
LOG_MAX_BYTES="${LOG_MAX_BYTES:-10485760}"   # 10 MB
if [[ -f "$PIPELINE_LOG" ]] && (( $(stat -c%s "$PIPELINE_LOG" 2>/dev/null || echo 0) > LOG_MAX_BYTES )); then
  cp -f "$PIPELINE_LOG" "$PIPELINE_LOG.1" 2>/dev/null && : > "$PIPELINE_LOG"
fi

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
WORKER_IMAGE="${WORKER_IMAGE:-eng-zh-subtitle-burner-worker:latest}"
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
UPLOAD_ONLY=0
ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-download) DO_DOWNLOAD=0 ;;
    --full) FORCE_FULL=1 ;;
    --audit-only) AUDIT_ONLY=1; DO_DOWNLOAD=0 ;;
    --upload-only) UPLOAD_ONLY=1; AUDIT_ONLY=1; DO_DOWNLOAD=0 ;;
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

# Per-creator settings live in creators/<name>.conf as `key = value`, because
# channels.txt had grown to five positional pipe-separated fields and uploading
# needs several more. channels.txt still holds name and URL.
CREATOR_DIR="${CREATOR_DIR:-creators}"

creator_cfg() {
  local creator="$1" key="$2" default="${3:-}" val=""
  local f="$CREATOR_DIR/$creator.conf"
  if [[ -f "$f" ]]; then
    val=$(sed -e 's/#.*$//' "$f" | grep -m1 -E "^[[:space:]]*$key[[:space:]]*=" \
          | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/\r$//')
  fi
  printf '%s' "${val:-$default}"
}

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

# ---------------------------------------------------------------------------
# Bilibili upload
# ---------------------------------------------------------------------------
# Off until the dry run looks right. With it off every upload is logged in full
# but nothing is submitted and nothing is deleted.
UPLOAD_ENABLED="${UPLOAD_ENABLED:-0}"
UPLOADED="$STATE_DIR/uploaded.list"
BILIUP="${BILIUP:-biliup}"

uploaded_has() { grep -q "^$1	" "$UPLOADED" 2>/dev/null; }

# Submissions already made for this creator today. The publish schedule alone
# would space them out, but submitting a whole backlog in one afternoon still
# means pushing tens of gigabytes at Bilibili in a burst, which is exactly the
# shape of traffic that gets an account rate-limited.
uploads_today() {
  grep -c "^$1/[^	]*	$(date +%Y-%m-%d)" "$UPLOADED" 2>/dev/null || true
}

# Bilibili answers 21566 投稿过于频繁 when an account is submitting too fast --
# typically a new account, or one whose logins come from an unexpected country.
# The whole file has already been transferred by the time that answer arrives,
# so retrying immediately costs another full upload and fails identically. Back
# the creator off entirely instead.
UPLOAD_BACKOFF_SEC="${UPLOAD_BACKOFF_SEC:-21600}"   # 6 hours

upload_backoff_active() {
  local f="$STATE_DIR/upload-backoff-$1" until_ts
  [[ -f "$f" ]] || return 1
  until_ts=$(cat "$f" 2>/dev/null || echo 0)
  (( $(date +%s) < until_ts ))
}

set_upload_backoff() {
  mkdir -p "$STATE_DIR"
  echo $(( $(date +%s) + UPLOAD_BACKOFF_SEC )) > "$STATE_DIR/upload-backoff-$1"
}

upload_quota_left() {
  local creator="$1" limit done_today
  limit=$(creator_cfg "$creator" daily_limit 1)
  done_today=$(uploads_today "$creator")
  (( done_today < limit ))
}

# The YouTube id behind a downloaded file, recorded at download time. Bilibili
# requires a 转载来源 URL whenever copyright=2.
source_url_for() {
  local creator="$1" base="$2" id
  id=$(grep -m1 -F "	$base" "$STATE_DIR/videoids-$creator.tsv" 2>/dev/null | cut -f1)
  [[ -n "$id" ]] && printf 'https://www.youtube.com/watch?v=%s' "$id"
}

# yt-dlp sanitises illegal filename characters, and not always identically
# between the thumbnail and the video -- "I'm" became "Im" in one and not the
# other. Fall back to matching on letters and digits alone, or the video posts
# with no cover, which badly hurts its click-through.
cover_for() {
  local dir="$1" base="$2" want f
  [[ -f "$dir/$base.jpg" ]] && { printf '%s' "$dir/$base.jpg"; return 0; }
  want=$(printf '%s' "$base" | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]')
  for f in "$dir"/*.jpg; do
    [[ -e "$f" ]] || continue
    if [[ "$(basename "$f" .jpg | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]')" == "$want" ]]; then
      printf '%s' "$f"; return 0
    fi
  done
  return 1
}

# Bilibili's 延时发布 takes a unix timestamp and requires it to be at least 4
# hours out. Videos are spaced one per day per creator at the creator's chosen
# hour, so a cleared backlog trickles out instead of dumping twenty uploads in
# an afternoon -- which reads as spam to viewers and to the algorithm.
#
# 18:00 China time is the default: of 250 currently-popular videos sampled from
# the popular API, 18:00 was the single most common publish hour (42), ahead of
# 17:00 (31) and the lunch bump at 11:00-12:00.
next_publish_slot() {
  local creator="$1" hour last now slot
  hour=$(creator_cfg "$creator" publish_hour 18)
  local f="$STATE_DIR/next-slot-$creator"
  now=$(date +%s)

  # Earliest legal slot: today at $hour China time, or tomorrow if that has
  # passed or is inside the 4 hour minimum.
  slot=$(TZ=Asia/Shanghai date -d "today ${hour}:00" +%s 2>/dev/null)
  while (( slot < now + 4*3600 + 600 )); do
    slot=$(( slot + 86400 ))
  done

  # Never schedule two videos into the same slot, including ones queued by an
  # earlier run that have not published yet.
  if [[ -f "$f" ]]; then
    last=$(cat "$f" 2>/dev/null || echo 0)
    while (( slot <= last )); do slot=$(( slot + 86400 )); done
  fi
  printf '%s' "$slot"
}

# Allocation and claim happen together under a lock, because uploads run inside
# the parallel burn jobs and two of them could otherwise read the same slot and
# both schedule for the same day. Claimed up front rather than after the upload
# succeeds: a failed upload then leaves a one-day gap in the schedule, which
# costs nothing, whereas a collision publishes two videos into one slot.
reserve_publish_slot() {
  local creator="$1" slot
  mkdir -p "$STATE_DIR"
  exec 7>>"$STATE_DIR/.slots.lock"; flock 7
  # Remember what the slot was, so a failed upload can hand it back instead of
  # pushing the whole schedule a day further out every time it fails.
  cp -f "$STATE_DIR/next-slot-$creator" "$STATE_DIR/.prev-slot-$creator" 2>/dev/null \
    || rm -f "$STATE_DIR/.prev-slot-$creator"
  slot=$(next_publish_slot "$creator")
  echo "$slot" > "$STATE_DIR/next-slot-$creator"
  flock -u 7
  printf '%s' "$slot"
}

release_publish_slot() {
  local creator="$1"
  exec 7>>"$STATE_DIR/.slots.lock"; flock 7
  if [[ -f "$STATE_DIR/.prev-slot-$creator" ]]; then
    mv -f "$STATE_DIR/.prev-slot-$creator" "$STATE_DIR/next-slot-$creator"
  else
    rm -f "$STATE_DIR/next-slot-$creator"
  fi
  flock -u 7
}

# Attribution, plus the original link. Kept in the creator's config so the
# wording is yours, not mine.
bili_desc_for() {
  local creator="$1" base="$2" tpl source
  tpl=$(creator_cfg "$creator" desc "")
  [[ -n "$tpl" ]] || return 0
  source=$(source_url_for "$creator" "$base")
  tpl="${tpl//\{source\}/$source}"
  tpl="${tpl//\{creator\}/$(creator_cfg "$creator" author "$creator")}"
  tpl="${tpl//\{title\}/$base}"
  # \n in the config becomes a real newline.
  printf '%b' "$tpl"
}

# Translated once, here rather than during the burn, so a title is never spent
# on a video that failed to encode.
bili_title_for() {
  local creator="$1" base="$2" ctx glossary_arg=()
  ctx=$(creator_cfg "$creator" context "$DEFAULT_CONTEXT")
  [[ -f "$GLOSSARY_DIR/$creator.txt" ]] && glossary_arg=(--glossary "$GLOSSARY_DIR/$creator.txt")
  docker run --rm -e GEMINI_API_KEY -e ANTHROPIC_API_KEY -e OPENAI_API_KEY \
    -v "$PWD:/data" -w /data "$WORKER_IMAGE" \
    --translate-title "$base" --model "$MODEL" --context "$ctx" \
    "${glossary_arg[@]}" 2>/dev/null | tail -1
}

# Returns 0 only when Bilibili has accepted the submission. Anything else
# leaves every file untouched: believing a video is published when it is not is
# the one failure this pipeline cannot recover from on its own.
upload_one() {
  local creator="$1" base="$2" mp4="$3" cover="$4"
  local cookie tid tags copyright title source

  uploaded_has "$creator/$base" && return 0
  if upload_backoff_active "$creator"; then
    echo "   $creator is backed off until $(date -d "@$(cat "$STATE_DIR/upload-backoff-$creator")" '+%H:%M') — skipping" >&2
    return 1
  fi
  if ! upload_quota_left "$creator"; then
    echo "   $creator already at its daily upload limit — $base waits for tomorrow" >&2
    return 1
  fi

  cookie=$(creator_cfg "$creator" cookie "bilibili/$creator.json")
  tid=$(creator_cfg "$creator" tid "")
  tags=$(creator_cfg "$creator" tags "")
  copyright=$(creator_cfg "$creator" copyright 2)
  source=$(source_url_for "$creator" "$base")

  # Refuse rather than guess. A wrong 分区 buries the video, a missing 转载来源
  # gets it rejected at review, and no tags means no discovery.
  local problem=""
  [[ -z "$tid"  ]] && problem="no tid in $CREATOR_DIR/$creator.conf"
  [[ -z "$tags" ]] && problem="no tags in $CREATOR_DIR/$creator.conf"
  [[ "$copyright" == "2" && -z "$source" ]] && problem="copyright=2 needs a source URL, none recorded for this video"
  [[ -f "$cookie" ]] || problem="no credentials at $cookie — run: biliup -u $cookie login"
  if [[ -n "$problem" ]]; then
    echo "!! upload skipped for $base: $problem" >&2
    return 1
  fi

  title=$(bili_title_for "$creator" "$base")
  [[ -n "$title" ]] || title="$base"

  local desc; desc=$(bili_desc_for "$creator" "$base")
  local args=(
    -u "$cookie" upload
    --title "$title"
    --tid "$tid"
    --tag "$tags"
    --copyright "$copyright"
  )
  [[ -n "$desc" ]] && args+=(--desc "$desc")
  # 转载来源 belongs to reposts only; sending it with 自制 is contradictory.
  [[ "$copyright" == "2" && -n "$source" ]] && args+=(--source "$source")
  [[ -n "$cover" && -f "$cover" ]] && args+=(--cover "$cover")
  local dtime=""
  if [[ "$(creator_cfg "$creator" schedule 1)" == "1" ]]; then
    # A dry run only previews the slot; it must not reserve one.
    if [[ "$UPLOAD_ENABLED" == "1" ]]; then
      dtime=$(reserve_publish_slot "$creator")
    else
      dtime=$(next_publish_slot "$creator")
    fi
    args+=(--dtime "$dtime")
    echo "   scheduled for $(TZ=Asia/Shanghai date -d "@$dtime" '+%Y-%m-%d %H:%M CST')" >&2
  fi
  [[ "$(creator_cfg "$creator" no_reprint 0)" == "1" ]] && args+=(--no-reprint 1)
  args+=("$mp4")

  if [[ "$UPLOAD_ENABLED" != "1" ]]; then
    echo "   [dry run] would upload: $title" >&2
    echo "   [dry run] $BILIUP ${args[*]}" >&2
    return 1
  fi

  # biliup writes credentials to stdout on some paths, so its output goes to a
  # file and only the lines we choose are echoed.
  local ulog="$STATE_DIR/.upload-$creator-$$.log"
  if ! "$BILIUP" "${args[@]}" >"$ulog" 2>&1; then
    if grep -q "21566\|过于频繁" "$ulog"; then
      set_upload_backoff "$creator"
      [[ -n "$dtime" ]] && release_publish_slot "$creator"
      echo "!! $creator is rate limited by Bilibili — backing off ${UPLOAD_BACKOFF_SEC}s, files left in place" >&2
      notify "Bilibili rate limit" "$creator: submissions throttled, retrying later"
      rm -f "$ulog"
      return 1
    fi
    # Anything else might be a stale cookie, which a refresh does fix.
    echo "   upload failed, refreshing credentials and retrying once" >&2
    "$BILIUP" -u "$cookie" renew >/dev/null 2>&1
    if ! "$BILIUP" "${args[@]}" >"$ulog" 2>&1; then
      grep -q "21566\|过于频繁" "$ulog" && set_upload_backoff "$creator"
      [[ -n "$dtime" ]] && release_publish_slot "$creator"
      echo "!! upload failed for $base — files left in place" >&2
      tail -3 "$ulog" | sed 's/^/     /' >&2
      notify "Bilibili upload failed" "$creator: $base"
      rm -f "$ulog"
      return 1
    fi
  fi
  rm -f "$ulog"

  printf '%s\t%s\t%s\t%s\n' "$creator/$base" "$(date -Is)" \
    "${dtime:+$(TZ=Asia/Shanghai date -d "@$dtime" '+%Y-%m-%d %H:%M CST')}" "$title" >> "$UPLOADED"
  echo "   uploaded: $title" >&2
  return 0
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
    printf '%s\n' "$base" > "$JOB_DIR/ok.$tag"

    # Disk is only reclaimed once Bilibili has actually accepted the video.
    # Until then the source stays put: it is what makes a restyle or a reburn
    # free, and deleting it early would mean re-downloading to fix anything.
    if upload_one "$creator" "$base" "$out_dir/$base.mp4" "$(cover_for "$out_dir" "$base" || true)"; then
      rm -f -- "$out_dir/$base.mp4" "$video"
      cover=$(cover_for "$out_dir" "$base" || true); [[ -n "$cover" ]] && rm -f -- "$cover"
      printf '%s\n' "$base" > "$JOB_DIR/up.$tag"
    else
      [[ "$DELETE_SOURCE" == "1" ]] && rm -f -- "$video"
    fi
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

    # creators/<name>.conf first, then the old channels.txt positional fields,
    # then the built-in default.
    chan_context=$(grep -m1 "^${creator}|" "$CHANNELS_FILE" 2>/dev/null | cut -d'|' -f3 | sed 's/\r$//')
    context=$(creator_cfg "$creator" context "${chan_context:-$DEFAULT_CONTEXT}")

    # 4th field of channels.txt: "zh" burns Chinese only (the creator already
    # burns their own English captions into the frame, so a second English
    # line would just stack on top of theirs). Anything else = both languages.
    # This can't be auto-detected: burned-in captions are pixels, not a
    # subtitle track, so ffprobe sees nothing.
    chan_sub_mode=$(grep -m1 "^${creator}|" "$CHANNELS_FILE" 2>/dev/null | cut -d'|' -f4 | sed 's/\r$//' | tr -d ' ')
    sub_mode=$(creator_cfg "$creator" sub_mode "${chan_sub_mode:-both}")

    # 5th field: how far off the bottom of the frame the Chinese line sits, in
    # ASS units (PlayResY is 288, so 288 = top of frame). Creators who burn
    # their own captions mid-frame need ours lifted clear of theirs; the
    # position of that band differs per creator, so it can't be a global.
    chan_margin=$(grep -m1 "^${creator}|" "$CHANNELS_FILE" 2>/dev/null | cut -d'|' -f5 | sed 's/\r$//' | tr -d ' ')
    zh_margin=$(creator_cfg "$creator" zh_margin "$chan_margin")

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
  uploaded=$(ls "$JOB_DIR"/up.* 2>/dev/null | wc -l)
fi

# ---------------------------------------------------------------------------
# 3. Audit — the actual "nothing was missed" guarantee.
#
# Doesn't trust RSS or the download loop: pulls the channel's full video list
# and checks every id is either downloaded or explicitly skipped.
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# 2b. Upload videos burned by an earlier run
# ---------------------------------------------------------------------------
# Completion is recorded in the ledger, so a video burned before uploading
# existed would otherwise never be offered to Bilibili at all.
# Runs on every pass, not just --upload-only: a video burned before uploading
# existed, or one that waited out a daily limit, would otherwise sit in done/
# forever waiting to be asked for.
if [[ $UPLOAD_ONLY -eq 1 || ( $AUDIT_ONLY -eq 0 && "$UPLOAD_ENABLED" == "1" ) ]]; then
  log "Uploading finished videos"
  touch "$UPLOADED"
  up_ok=0; up_skip=0
  while IFS= read -r -d '' mp4; do
    creator="$(basename "$(dirname "$mp4")")"
    base="$(basename "$mp4" .mp4)"
    [[ -n "$ONLY" && "$base" != *"$ONLY"* ]] && continue
    uploaded_has "$creator/$base" && continue
    echo "  [$creator] $base"
    cover=$(cover_for "$DONE_DIR/$creator" "$base" || true)
    if upload_one "$creator" "$base" "$mp4" "$cover"; then
      rm -f -- "$mp4" ${cover:+"$cover"} "$NEW_DIR/$creator/$base.mkv"
      up_ok=$((up_ok+1))
    else
      up_skip=$((up_skip+1))
    fi
  done < <(find "$DONE_DIR" -type f -name '*.mp4' -print0 | sort -z)
  log "$up_ok uploaded, $up_skip skipped"
fi

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

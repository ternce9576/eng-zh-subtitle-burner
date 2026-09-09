#!/usr/bin/env bash
# Onboard a creator: work out how their videos are captioned, draft their
# glossary, and write the channels.txt line.
#
#   ./add-creator.sh https://www.youtube.com/@somebody
#
# Everything it decides is printed for review before anything is committed, and
# nothing here touches creators already in channels.txt.
set -u
set -o pipefail

CHANNELS_FILE="${CHANNELS_FILE:-channels.txt}"
INPUT_DIR="${INPUT_DIR:-incoming}"
GLOSSARY_DIR="${GLOSSARY_DIR:-glossary}"
STATE_DIR=".state"
TOOLS="$(dirname "$0")/tools"
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

url="${1:-}"
[[ -n "$url" ]] || { echo "usage: $0 <channel-url> [creator-name]" >&2; exit 1; }

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

# ---------------------------------------------------------------- identity
creator="${2:-}"
if [[ -z "$creator" ]]; then
  creator=$(sed -E 's#.*/@([^/?]+).*#\1#' <<<"$url")
  [[ "$creator" == "$url" ]] && creator=$(sed -E 's#.*/(channel|c|user)/([^/?]+).*#\2#' <<<"$url")
fi
[[ -n "$creator" && "$creator" != "$url" ]] || { echo "cannot derive a name from $url — pass one as the second argument" >&2; exit 1; }

if grep -q "^${creator}|" "$CHANNELS_FILE" 2>/dev/null; then
  echo "$creator is already in $CHANNELS_FILE — nothing to do." >&2
  exit 1
fi

# Normalise to the /videos tab: the bare channel URL returns the Home layout,
# whose "playlist" is a mix of shorts, streams and shelves.
listing="${url%/}"
[[ "$listing" == *videos ]] || listing="$listing/videos"

step "Reading channel: $creator"
note "$listing"

# A handle that doesn't exist doesn't error -- YouTube serves back whatever it
# thinks you meant, and the first sign of trouble would otherwise be a 500MB
# download of somebody else's videos. Resolve the real channel and show it.
identity=$(yt-dlp --no-warnings --playlist-end 1 --skip-download \
  --print "%(channel)s|%(channel_id)s" "$listing" 2>/dev/null | head -1)
chan_name="${identity%%|*}"
chan_id="${identity##*|}"
[[ -n "$chan_name" && "$chan_name" != "NA" ]] || { echo "could not resolve a channel at $listing" >&2; exit 1; }
note "resolved to: $chan_name ($chan_id)"

# ---------------------------------------------------- pick a sample video
step "Finding a representative video"
mapfile -t rows < <(yt-dlp --flat-playlist --no-warnings --playlist-end 25 \
  --print "%(id)s|%(title)s" "$listing" 2>/dev/null)
[[ ${#rows[@]} -gt 0 ]] || { echo "no videos listed — is the URL right?" >&2; exit 1; }
note "${#rows[@]} recent uploads listed"

sample_id=""; sample_title=""
for row in "${rows[@]}"; do
  id="${row%%|*}"; title="${row#*|}"
  d=$(duration_for "$creator" "$id")
  if duration_ok "$d" && [[ "$d" != "NA" ]]; then
    sample_id="$id"; sample_title="$title"
    note "sample: $title (${d}s)"
    break
  fi
done
[[ -n "$sample_id" ]] || { echo "no video between ${MIN_DURATION}s and ${MAX_DURATION}s in the last ${#rows[@]} uploads" >&2; exit 1; }

if [[ "${ASSUME_YES:-0}" != "1" ]]; then
  echo
  echo "  Recent uploads:"
  printf '    %s\n' "${rows[@]:0:3}" | sed 's/^\(    \)[^|]*|/\1/'
  echo
  read -r -p "  Is this the right channel? [y/N] " answer
  [[ "$answer" =~ ^[Yy] ]] || { echo "aborted — nothing written." >&2; exit 1; }
fi

# ------------------------------------------------------------- download it
step "Downloading the sample"
mkdir -p "$INPUT_DIR/$creator"
yt-dlp -f "$YTDLP_FORMAT_CHAIN" --remux-video mkv --no-warnings --no-progress \
  --download-archive "$INPUT_DIR/$creator/downloaded.txt" \
  --force-ipv4 -N 4 --no-part --write-thumbnail --convert-thumbnails jpg \
  -o "$INPUT_DIR/$creator/$YTDLP_NAME_TEMPLATE" \
  "https://www.youtube.com/watch?v=$sample_id" || {
    echo "download failed" >&2; exit 1; }

video=$(find "$INPUT_DIR/$creator" -maxdepth 1 -name '*.mkv' -newermt '-10 minutes' | head -1)
[[ -n "$video" ]] || { echo "downloaded file not found" >&2; exit 1; }
note "$(basename "$video")"

# ------------------------------------------------- caption band analysis
step "Measuring their captions"
analysis=$(python3 "$TOOLS/detect_captions.py" "$video") || { echo "analysis failed" >&2; exit 1; }
sub_mode=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["sub_mode"])' <<<"$analysis")
zh_margin=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["margin_v"])' <<<"$analysis")
consistency=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["band_consistency"])' <<<"$analysis")

if [[ "$sub_mode" == "zh" ]]; then
  note "they burn their own captions (consistency $consistency)"
  note "our Chinese will sit at MarginV $zh_margin, above theirs"
else
  note "no burned-in captions found — we'll add English as well as Chinese"
fi

# ------------------------------------------------------------- glossary
step "Drafting the glossary"
mkdir -p "$GLOSSARY_DIR"
yt-dlp --flat-playlist --no-warnings --playlist-end 60 --print "%(title)s" \
  "$listing" 2>/dev/null | python3 "$TOOLS/seed_glossary.py" > "$GLOSSARY_DIR/$creator.txt"
note "$(grep -cvE '^\s*(#|$)' "$GLOSSARY_DIR/$creator.txt") terms -> $GLOSSARY_DIR/$creator.txt"

# -------------------------------------------------------------- context
step "Drafting the context line"
terms=$(grep -vE '^\s*(#|$)' "$GLOSSARY_DIR/$creator.txt" | head -5 | paste -sd', ' -)
context="$chan_name — $terms"
note "$context"

# ------------------------------------------------------- back catalogue
# Default is to pull everything a creator has ever posted -- the whole point of
# adding them is their catalogue, not just what they upload from tomorrow on.
# SKIP_BACKLOG=1 marks the existing uploads as already handled instead, which
# is for testing the pipeline without committing to a full download.
archive="$INPUT_DIR/$creator/downloaded.txt"
touch "$archive"
if [[ "${SKIP_BACKLOG:-0}" == "1" ]]; then
  step "Marking the back catalogue as already handled (SKIP_BACKLOG=1)"
  seeded=0
  while read -r vid; do
    [[ -n "$vid" ]] || continue
    grep -q "youtube $vid" "$archive" || { echo "youtube $vid" >> "$archive"; seeded=$((seeded+1)); }
  done < <(yt-dlp --flat-playlist --no-warnings --print "%(id)s" "$listing" 2>/dev/null)
  note "$seeded existing uploads skipped — only new ones will be fetched"
  note "to pull one in later, delete its line from $archive"
else
  step "Back catalogue"
  total=$(yt-dlp --flat-playlist --no-warnings --print "%(id)s" "$listing" 2>/dev/null | grep -c .)
  note "$total uploads listed — all will be downloaded, ${MIN_DURATION}s-${MAX_DURATION}s only"
  note "DOWNLOAD_LIMIT caps each run, so the backlog clears over several runs"
fi

# --------------------------------------------------------------- commit
step "Writing channels.txt"
printf '%s|%s|%s|%s|%s\n' "$creator" "$listing" "$context" "$sub_mode" "$zh_margin" >> "$CHANNELS_FILE"
note "$(tail -1 "$CHANNELS_FILE")"

cat <<TXT

Review before the next pipeline run:
  $GLOSSARY_DIR/$creator.txt   drop anything that isn't a real name or jargon,
                               and add '=> 中文' where a term has a fixed
                               Chinese rendering
  $CHANNELS_FILE               field 3 is the context sentence — make it
                               describe what they actually do

Then process just this one to check the result:
  ./run.sh --no-download --only "$sample_title"
TXT

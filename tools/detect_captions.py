#!/usr/bin/env python3
"""Work out whether a creator burns their own captions, and where they sit.

Both facts are needed per creator: whether to add an English line of our own
(they'd collide with the creator's), and how far up the frame to lift the
Chinese so it clears theirs. Neither can be read from the file -- burned-in
captions are pixels, not a subtitle track -- but they can be measured.

Captions are large, bright, horizontally centred, and appear again and again in
the same band. HUD elements are bright too, so brightness alone is not enough:
the discriminator is a tall run of bright rows in the middle of the frame that
recurs across unrelated moments in the video.
"""
import argparse
import json
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

from PIL import Image

# A caption glyph is a substantial fraction of frame height. Anything shorter is
# HUD text, a nameplate or chat.
MIN_BAND_FRAC = 0.030      # >= 3% of frame height
MAX_BAND_FRAC = 0.170      # more than this is a scene, not a caption
BRIGHT = 232               # captions are white or near-white
MIN_RUN_FRAC = 0.020       # ignore bright runs thinner than this
ASS_PLAY_RES_Y = 288       # matches the ASS header the burner writes
CLEARANCE_FRAC = 0.020     # gap left between our line and the creator's


def sample_times(duration: float, n: int) -> list[float]:
    # Skip the intro and outro: both tend to be title cards, which are bright
    # and centred and would read as captions.
    lo, hi = duration * 0.12, duration * 0.88
    step = (hi - lo) / max(n - 1, 1)
    return [lo + step * i for i in range(n)]


def bright_bands(path: Path) -> list[tuple[int, int, int]]:
    """Bright row-runs in the lower half of one frame, as (top, bottom, h)."""
    im = Image.open(path).convert("L")
    w, h = im.size
    px = im.load()
    x0, x1 = int(w * 0.25), int(w * 0.75)
    step = max((x1 - x0) // 160, 1)
    need = ((x1 - x0) // step) // 12          # enough lit pixels to be text

    lit = []
    for y in range(int(h * 0.45), h):
        c = sum(1 for x in range(x0, x1, step) if px[x, y] > BRIGHT)
        lit.append(y if c > need else -1)

    bands, run = [], []
    for y in lit + [-1]:
        if y >= 0:
            run.append(y)
            continue
        if run and len(run) >= h * MIN_RUN_FRAC:
            bands.append((run[0], run[-1], len(run)))
        run = []
    return bands


def analyse(video: Path, frames: int) -> dict:
    duration = float(
        subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(video)],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    )
    height = int(
        subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=height", "-of", "csv=p=0", str(video)],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    )

    tops: list[int] = []
    with tempfile.TemporaryDirectory() as tmp:
        for i, t in enumerate(sample_times(duration, frames)):
            out = Path(tmp) / f"f{i}.png"
            subprocess.run(
                ["ffmpeg", "-v", "error", "-ss", f"{t:.2f}", "-i", str(video),
                 "-frames:v", "1", str(out), "-y"],
                check=False,
            )
            if not out.exists():
                continue
            for top, _bot, run in bright_bands(out):
                if height * MIN_BAND_FRAC <= run <= height * MAX_BAND_FRAC:
                    tops.append(top)

    hit_rate = len(tops) / frames

    # A caption band recurs at the same height. Bucket the tops and see whether
    # one bucket dominates; scattered hits are HUD noise, not captions.
    bucket = max(height // 40, 1)
    common = Counter(t // bucket for t in tops).most_common(1)
    consistent = 0.0
    band_top = 0
    if common:
        band, hits = common[0]
        consistent = hits / frames
        band_top = band * bucket

    has_captions = consistent >= 0.30 and hit_rate >= 0.30

    margin = 12
    if has_captions:
        # MarginV is measured off the bottom of the frame, and ASS units are
        # PlayResY, not pixels.
        clear_px = (height - band_top) + height * CLEARANCE_FRAC
        margin = round(clear_px / height * ASS_PLAY_RES_Y)
        margin = max(12, min(margin, 200))

    return {
        "duration": round(duration, 1),
        "height": height,
        "frames_sampled": frames,
        "caption_hit_rate": round(hit_rate, 2),
        "band_consistency": round(consistent, 2),
        "band_top_px": band_top,
        "has_burned_captions": has_captions,
        "sub_mode": "zh" if has_captions else "both",
        "margin_v": margin,
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--frames", type=int, default=24)
    a = ap.parse_args()
    v = Path(a.video)
    if not v.exists():
        sys.exit(f"no such file: {v}")
    print(json.dumps(analyse(v, a.frames), indent=2))

import argparse
import logging
import subprocess
import sys
import time

from faster_whisper import BatchedInferencePipeline, WhisperModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("whisper")


def gpu_description() -> str:
    """Name and memory of the first GPU, straight from nvidia-smi."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total",
             "--format=csv,noheader"],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout.strip().splitlines()
        return out[0] if out else "unknown"
    except Exception:
        return "unknown"


def seconds_to_srt_time(s: float) -> str:
    hours = int(s // 3600)
    minutes = int((s % 3600) // 60)
    secs = int(s % 60)
    millis = int((s % 1) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def transcribe(
    input_path: str, output_path: str, model_name: str, hotwords: str = ""
) -> None:
    # faster-whisper runs on ctranslate2, never on torch, so ctranslate2's own
    # device count is the authoritative answer here. Asking it directly also
    # drops torch from the image -- multiple gigabytes that existed solely to
    # answer this one question, and whose download kept timing out.
    import ctranslate2

    gpus = ctranslate2.get_cuda_device_count()
    log.info(f"ctranslate2 {ctranslate2.__version__}, CUDA devices: {gpus}")

    device = "cpu"
    compute_type = "int8"
    if gpus > 0:
        device = "cuda"
        compute_type = "float16"
        log.info(f"GPU: {gpu_description()}")
    else:
        log.warning("CUDA not available — falling back to CPU (this will be slow)")

    log.info(f"loading whisper model ({model_name}) on {device} ({compute_type})...")
    t0 = time.time()
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    log.info(f"model loaded in {time.time() - t0:.1f}s")

    batched = BatchedInferencePipeline(model=model)

    log.info(f"transcribing: {input_path}")
    t0 = time.time()
    # Hotwords bias decoding toward names the model would otherwise mishear --
    # "Bed Wars" came back as "Pet Wars" without them. Fixing it here is free
    # and keeps the English transcript honest, rather than leaving the
    # translator to guess the right term from context.
    if hotwords:
        log.info(f"hotwords: {hotwords}")
    segments, info = batched.transcribe(
        input_path,
        language="en",
        batch_size=16,
        word_timestamps=True,
        hotwords=hotwords or None,
    )

    max_words = 7
    min_words = 3

    with open(output_path, "w", encoding="utf-8") as f:
        idx = 0
        for seg in segments:
            # faster-whisper yields lazily, so seg.end tracks how far into the
            # audio we are. The TS side parses these to drive its progress bar.
            print(f"__PROGRESS__ {seg.end:.2f} {info.duration:.2f}", file=sys.stderr, flush=True)
            words = [w for w in (seg.words or []) if w.word.strip()]
            if not words:
                continue

            # Group words into subtitle-sized chunks using actual timestamps
            chunks: list[list] = []
            chunk: list = []
            for w in words:
                chunk.append(w)
                tok = w.word.rstrip()
                is_sentence_end = tok.endswith((".", "!", "?"))
                if len(chunk) >= max_words or (is_sentence_end and len(chunk) >= min_words):
                    chunks.append(chunk)
                    chunk = []
            if chunk:
                if len(chunk) <= 2 and chunks:
                    chunks[-1].extend(chunk)
                else:
                    chunks.append(chunk)

            for c in chunks:
                text = "".join(w.word for w in c).strip()
                text = " ".join(text.split())
                text = text.replace("-->", "- >")
                if not text or c[-1].end <= c[0].start:
                    continue
                idx += 1
                f.write(f"{idx}\n{seconds_to_srt_time(c[0].start)} --> {seconds_to_srt_time(c[-1].end)}\n{text}\n\n")

    elapsed = time.time() - t0
    log.info(f"transcribed {info.duration:.1f}s of audio -> {idx} segments in {elapsed:.1f}s ({info.duration / elapsed:.1f}x realtime)")
    log.info(f"output: {output_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="Input audio/video file")
    parser.add_argument("output", help="Output SRT file")
    parser.add_argument("--model", default="deepdml/faster-whisper-large-v3-turbo-ct2", help="Whisper model name")
    parser.add_argument("--hotwords", default="", help="Terms to bias decoding toward")
    args = parser.parse_args()
    transcribe(args.input, args.output, args.model, args.hotwords)

FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip fonts-noto-cjk fonts-noto-cjk-extra curl ca-certificates xz-utils unzip fontconfig \
    && rm -rf /var/lib/apt/lists/*

# ffmpeg with NVENC/NVDEC + libass support (static build)
RUN mkdir -p /tmp/ff && cd /tmp/ff \
    && curl -L -o ff.tar.xz https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz \
    && tar -xf ff.tar.xz \
    && cp */bin/ffmpeg */bin/ffprobe /usr/local/bin/ \
    && cd / && rm -rf /tmp/ff

# Heavy geometric sans matching the YouTube-gaming caption style creators use.
# OFL-licensed, so it can live in the image.
RUN mkdir -p /usr/share/fonts/truetype/pipeline \
    && curl -fsSL -o /usr/share/fonts/truetype/pipeline/Poppins-ExtraBold.ttf \
       "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-ExtraBold.ttf" \
    && curl -fsSL -o /usr/share/fonts/truetype/pipeline/Poppins-Bold.ttf \
       "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Bold.ttf" \
    && curl -fsSL -o /tmp/smiley.zip \
       "https://github.com/atelier-anchor/smiley-sans/releases/download/v2.0.1/smiley-sans-v2.0.1.zip" \
    && unzip -j -o /tmp/smiley.zip '*.ttf' -d /usr/share/fonts/truetype/pipeline/ \
    && rm -f /tmp/smiley.zip \
    && fc-cache -f >/dev/null 2>&1 || true

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,video

RUN pip3 install --no-cache-dir --retries 10 --timeout 120 faster-whisper

WORKDIR /app

COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN corepack enable && corepack prepare pnpm@latest --activate && pnpm install --frozen-lockfile

COPY src/ src/
COPY whisper.py ./
RUN pnpm build

WORKDIR /data

ENTRYPOINT ["node", "/app/dist/src/cli.js"]

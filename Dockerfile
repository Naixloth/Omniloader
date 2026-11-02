FROM mwader/static-ffmpeg:8.0.1 AS ffmpeg_base

FROM node:22-bookworm-slim AS node_base

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates python3 build-essential pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil \
    && cd /opt/bgutil/server \
    && npm ci \
    && npx tsc \
    && npm prune --omit=dev \
    && rm -rf /var/lib/apt/lists/*

FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CLOUD_MODE=1 \
    PORT=10000

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ffmpeg_base /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg_base /ffprobe /usr/local/bin/ffprobe
COPY --from=node_base /usr/local/bin/node /usr/local/bin/node
COPY --from=node_base /opt/bgutil/server /opt/bgutil/server

RUN useradd -m -u 1000 appuser
WORKDIR /app

COPY requirements-cloud.txt /app/requirements-cloud.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir --upgrade -r /app/requirements-cloud.txt

COPY app /app/app
COPY static /app/static

RUN mkdir -p /app/downloads /app/data/temp /app/bin && \
    chown -R appuser:appuser /app /opt/bgutil && \
    chmod -R 777 /app/downloads /app/data

USER appuser
EXPOSE 10000

CMD ["sh", "-c", "node --max-old-space-size=128 /opt/bgutil/server/build/main.js --port 4416 >/dev/null 2>&1 & exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-10000}"]

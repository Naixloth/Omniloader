FROM node:22-bookworm-slim AS node_base

FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CLOUD_MODE=1 \
    PORT=10000

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node_base /usr/local/bin/node /usr/local/bin/node

RUN useradd -m -u 1000 appuser
WORKDIR /app

COPY requirements-cloud.txt /app/requirements-cloud.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r /app/requirements-cloud.txt

COPY app /app/app
COPY static /app/static

RUN mkdir -p /app/downloads /app/data/temp /app/bin && \
    chown -R appuser:appuser /app && \
    chmod -R 777 /app/downloads /app/data

USER appuser
EXPOSE 10000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-10000}"]

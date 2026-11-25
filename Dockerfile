# syntax=docker/dockerfile:1

# Frontend build. The frontend (Task 4) sets Vite build.outDir to
# ../backend/folio/static; older/absent layouts land in dist/. Both are
# normalised into /out so this stage keeps working unchanged.
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/ ./
RUN if [ -f package.json ]; then npm ci || npm install; npm run build; fi; \
    mkdir -p /out && \
    for d in /web/dist /backend/folio/static; do \
      [ -d "$d" ] && cp -a "$d"/. /out/ 2>/dev/null || true; \
    done; \
    true

FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
# Calibre CLI (ebook-convert/ebook-meta) for Kindle ingest; PyMuPDF ships
# self-contained wheels, so no extra system libs are needed. ffmpeg encodes a
# live start's PCM stream to the clip format (folio/tts/live.py).
RUN apt-get update \
    && apt-get install -y --no-install-recommends calibre ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home folio \
    && mkdir -p /data && chown folio:folio /data
WORKDIR /app/backend
COPY backend/requirements.lock ./
RUN pip install -r requirements.lock
COPY backend/ ./
COPY --from=web /out/ ./folio/static/
USER folio
ENV HOME=/app
EXPOSE 8000
CMD ["uvicorn", "folio.main:app", "--host", "0.0.0.0", "--port", "8000"]

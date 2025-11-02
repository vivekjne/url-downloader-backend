# URL Downloader API

FastAPI microservice that inspects and downloads media from a URL with the help of `yt-dlp`.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Running

```bash
uvicorn app.main:app --reload
```

> **Note:** yt-dlp relies on `ffmpeg` to merge the separate audio/video streams returned by most providers. Install ffmpeg (e.g. `brew install ffmpeg` or `conda install -c conda-forge ffmpeg`) for full-quality downloads.

## Frontend (Next.js)

The `frontend` directory contains a Next.js UI for probing/downloading URLs.

### Setup

```bash
cd frontend
npm install
```

Optionally configure the FastAPI base URL during development:

```bash
echo "NEXT_PUBLIC_API_BASE=http://localhost:8000" > .env.local
```

### Run

```bash
npm run dev
```

The app renders a probe form, format selector, and download progress indicator wired to the FastAPI endpoints.

## API

- `POST /probe` – body: `{"url": "<media url>"}`. Returns metadata, thumbnail, and the list of available formats.
- `POST /download` – body: `{"url": "<media url>", "format_id": "<optional format id>"}`. Starts a background download and responds with `{ "task_id": "..." }`. Video-only selections are automatically muxed with the best matching audio stream when available.
- `GET /progress/{task_id}` – Inspect the current download status, bytes transferred, and ETA.
- `GET /download/{task_id}` – Retrieve the finished file once the task reports `status=finished` (automatically used by the Next.js UI).

Errors from `yt-dlp` propagate as `400` responses and include the extractor's message. Unexpected failures fall back to `500`.

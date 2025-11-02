from __future__ import annotations

import logging
import mimetypes
import os
import shutil
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional
from uuid import uuid4

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, HttpUrl
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError, YoutubeDLError

try:  # pragma: no cover - optional dependency
    import certifi
except ImportError:  # pragma: no cover - optional dependency
    certifi = None


logger = logging.getLogger("uvicorn.error")

# Ensure OpenSSL relies on certifi when available.
if certifi:
    cert_path = certifi.where()
    os.environ.setdefault("SSL_CERT_FILE", cert_path)
    os.environ.setdefault("REQUESTS_CA_BUNDLE", cert_path)


app = FastAPI(title="URL Downloader API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)


class UrlPayload(BaseModel):
    url: HttpUrl


class FormatInfo(BaseModel):
    format_id: str
    ext: Optional[str]
    resolution: Optional[str]
    fps: Optional[float]
    filesize: Optional[int]
    filesize_approx: Optional[int]
    format_note: Optional[str]
    abr: Optional[float]
    vbr: Optional[float]
    acodec: Optional[str]
    vcodec: Optional[str]
    has_audio: bool
    has_video: bool


class ProbeResponse(BaseModel):
    url: HttpUrl
    title: Optional[str]
    duration: Optional[float]
    uploader: Optional[str]
    extractor: Optional[str]
    is_downloadable: bool
    thumbnail: Optional[str]
    formats: List[FormatInfo] = Field(default_factory=list)
    default_format_id: Optional[str] = None


class DownloadRequest(BaseModel):
    url: HttpUrl
    format_id: Optional[str] = None
    format_has_audio: Optional[bool] = None
    format_has_video: Optional[bool] = None


class DownloadInitResponse(BaseModel):
    task_id: str


class TaskStatusResponse(BaseModel):
    task_id: str
    status: Literal["pending", "downloading", "finished", "error"]
    progress: Optional[float]
    downloaded_bytes: Optional[int]
    total_bytes: Optional[int]
    speed: Optional[float]
    eta: Optional[float]
    filename: Optional[str]
    format_expr: Optional[str]
    detail: Optional[str] = None


# In-memory task registry guarded by a lock.
TASKS: Dict[str, Dict[str, Any]] = {}
TASK_LOCK = threading.Lock()


def _build_ydl(**overrides: Any) -> YoutubeDL:
    """Return a YoutubeDL instance with defaults tuned for API usage."""
    base_opts = {
        "quiet": True,
        "skip_download": True,
        "ignoreerrors": False,
        "restrictfilenames": True,
        "nocheckcertificate": True,
        "no_warnings": True,
        "progress_hooks": [],
        "call_home": False,
    }
    base_opts.update(overrides)
    return YoutubeDL(base_opts)


def _extract_formats(info: Dict[str, Any]) -> List[FormatInfo]:
    formats: List[FormatInfo] = []
    raw_formats = info.get("formats") or []
    for fmt in raw_formats:
        fmt_id = fmt.get("format_id")
        if not fmt_id:
            continue

        resolution = None
        width = fmt.get("width")
        height = fmt.get("height")
        if width and height:
            resolution = f"{width}x{height}"
        elif fmt.get("resolution"):
            resolution = fmt.get("resolution")

        filesize = fmt.get("filesize")
        filesize_approx = fmt.get("filesize_approx")

        has_audio = fmt.get("acodec") not in (None, "none")
        has_video = fmt.get("vcodec") not in (None, "none")

        formats.append(
            FormatInfo(
                format_id=str(fmt_id),
                ext=fmt.get("ext"),
                resolution=resolution,
                fps=fmt.get("fps"),
                filesize=int(filesize) if filesize else None,
                filesize_approx=int(filesize_approx) if filesize_approx else None,
                format_note=fmt.get("format_note"),
                abr=fmt.get("abr"),
                vbr=fmt.get("tbr"),
                acodec=fmt.get("acodec"),
                vcodec=fmt.get("vcodec"),
                has_audio=has_audio,
                has_video=has_video,
            )
        )

    def sort_key(item: FormatInfo) -> tuple[int, float]:
        # Prefer higher resolution, then higher bitrate.
        audio_priority = 1 if item.has_audio else 0
        height = 0
        if item.resolution and "x" in item.resolution:
            try:
                height = int(item.resolution.split("x")[1])
            except (ValueError, IndexError):
                height = 0
        vbr = item.vbr or 0.0
        return (-audio_priority, -height, -(vbr or 0))

    formats.sort(key=sort_key)
    return formats


def _create_task(
    url: str,
    format_id: Optional[str],
    format_has_audio: Optional[bool],
    format_has_video: Optional[bool],
) -> str:
    task_id = uuid4().hex
    with TASK_LOCK:
        TASKS[task_id] = {
            "task_id": task_id,
            "status": "pending",
            "progress": 0.0,
            "downloaded_bytes": 0,
            "total_bytes": None,
            "speed": None,
            "eta": None,
            "filename": None,
            "file_path": None,
            "temp_dir": None,
            "detail": None,
            "url": url,
            "format_id": format_id,
            "format_expr": None,
            "format_has_audio": format_has_audio,
            "format_has_video": format_has_video,
        }
    return task_id


def _update_task(task_id: str, **updates: Any) -> None:
    with TASK_LOCK:
        task = TASKS.get(task_id)
        if not task:
            return
        task.update({k: v for k, v in updates.items() if v is not None or k in task})


def _get_task(task_id: str) -> Optional[Dict[str, Any]]:
    with TASK_LOCK:
        task = TASKS.get(task_id)
        return dict(task) if task else None


def _cleanup_task(task_id: str) -> None:
    task = _get_task(task_id)
    if not task:
        return

    file_path = task.get("file_path")
    temp_dir = task.get("temp_dir")

    if file_path:
        Path(file_path).unlink(missing_ok=True)

    if temp_dir:
        shutil.rmtree(temp_dir, ignore_errors=True)

    with TASK_LOCK:
        TASKS.pop(task_id, None)


def _resolve_format_expression(
    url: str,
    format_id: Optional[str],
    has_audio_override: Optional[bool],
    has_video_override: Optional[bool],
) -> str:
    """Decide which yt-dlp format expression to use for the download."""
    if not format_id:
        return "bv*+ba/best"

    if has_audio_override is True:
        return format_id

    if has_video_override is False:
        return format_id

    needs_audio = has_audio_override is False

    if has_audio_override is None or (needs_audio and has_video_override is None):
        try:
            with _build_ydl() as ydl:
                info = ydl.extract_info(url, download=False)
        except Exception:  # pragma: no cover - probing failure shouldn't stop download
            return f"{format_id}+bestaudio/best" if needs_audio else format_id

        formats = (info or {}).get("formats") or []
        selected = next((fmt for fmt in formats if str(fmt.get("format_id")) == format_id), None)
        if not selected:
            return format_id

        has_audio = selected.get("acodec") not in (None, "none")
        has_video = selected.get("vcodec") not in (None, "none")

        if has_audio:
            return format_id

        if not has_video:
            return format_id

        audio_candidate = next(
            (
                fmt
                for fmt in formats
                if str(fmt.get("acodec")) not in (None, "none")
                and str(fmt.get("format_id")) != format_id
                and fmt.get("vcodec") in (None, "none")
            ),
            None,
        )
        if audio_candidate:
            return f"{format_id}+{audio_candidate.get('format_id')}"
        return f"{format_id}+bestaudio/best"

    if needs_audio:
        return f"{format_id}+bestaudio/best"

    return format_id


def _download_worker(
    task_id: str,
    url: str,
    format_id: Optional[str],
    format_has_audio: Optional[bool],
    format_has_video: Optional[bool],
) -> None:
    temp_dir = Path(tempfile.mkdtemp(prefix="yt_dlp_"))
    output_template = str(temp_dir / "%(title)s.%(ext)s")

    format_expr = _resolve_format_expression(url, format_id, format_has_audio, format_has_video)
    _update_task(task_id, format_expr=format_expr)

    def hook(status: Dict[str, Any]) -> None:
        state = status.get("status")
        if state == "downloading":
            total = status.get("total_bytes")
            estimate = status.get("total_bytes_estimate")
            current = _get_task(task_id)
            existing_total = current.get("total_bytes") if current else None
            if isinstance(existing_total, float):
                existing_total = int(existing_total)
            if total is None:
                total = estimate if existing_total is None else existing_total
            elif existing_total is not None:
                total = existing_total
            downloaded = status.get("downloaded_bytes")
            if total is not None:
                try:
                    total = int(total)
                except (ValueError, TypeError):
                    total = None
            if downloaded is not None:
                try:
                    downloaded = int(downloaded)
                except (ValueError, TypeError):
                    downloaded = None
            progress = None
            if total and downloaded is not None and total > 0:
                progress = min(1.0, downloaded / total)
            updates = {
                "status": "downloading",
                "downloaded_bytes": downloaded,
                "speed": status.get("speed"),
                "eta": status.get("eta"),
                "progress": progress,
            }
            if total is not None:
                updates["total_bytes"] = total
            _update_task(task_id, **updates)
        elif state == "finished":
            output_path = status.get("filename") or status.get("_filename")
            pathlib_path = Path(output_path) if output_path else None
            downloaded_value = status.get("total_bytes") or status.get("downloaded_bytes")
            if downloaded_value is not None:
                try:
                    downloaded_value = int(downloaded_value)
                except (ValueError, TypeError):
                    downloaded_value = None
            _update_task(
                task_id,
                status="finished",
                progress=1.0,
                downloaded_bytes=downloaded_value,
                filename=pathlib_path.name if pathlib_path else None,
                file_path=str(pathlib_path) if pathlib_path else output_path,
                temp_dir=str(temp_dir),
            )

    _update_task(
        task_id,
        status="downloading",
        progress=0.0,
        downloaded_bytes=0,
        total_bytes=None,
        speed=None,
        eta=None,
        detail=None,
    )

    opts = {
        "skip_download": False,
        "outtmpl": output_template,
        "progress_hooks": [hook],
        "nocheckcertificate": True,
        "quiet": True,
        "restrictfilenames": True,
        "noplaylist": True,
        "merge_output_format": "mp4",
        "postprocessors": [{"key": "FFmpegVideoConvertor", "preferedformat": "mp4"}],
    }
    if format_expr:
        opts["format"] = format_expr

    try:
        with _build_ydl(**opts) as ydl:
            ydl.download([url])
    except (DownloadError, YoutubeDLError) as exc:
        _update_task(task_id, status="error", detail=str(exc))
    except Exception as exc:  # pragma: no cover - unexpected failure
        logger.exception("Unexpected error during download for %s", url)
        _update_task(task_id, status="error", detail=str(exc))
    finally:
        task = _get_task(task_id)
        if not task:
            shutil.rmtree(temp_dir, ignore_errors=True)
            return
        if task.get("status") != "finished":
            shutil.rmtree(temp_dir, ignore_errors=True)
        else:
            # Ensure temp_dir is recorded for later cleanup.
            _update_task(task_id, temp_dir=str(temp_dir))


def _guess_media_type(filename: str) -> Optional[str]:
    media_type, _ = mimetypes.guess_type(filename)
    return media_type


@app.post("/probe", response_model=ProbeResponse)
def probe_url(payload: UrlPayload) -> ProbeResponse:
    """Check if the URL is downloadable and return key metadata."""
    url_str = str(payload.url)
    try:
        with _build_ydl() as ydl:
            info = ydl.extract_info(url_str, download=False)
    except (DownloadError, YoutubeDLError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - fallback for unexpected errors
        logger.exception("Unexpected error during probe for %s", payload.url)
        raise HTTPException(status_code=400, detail=f"Probe failed: {exc}") from exc

    if info is None:
        raise HTTPException(status_code=400, detail="No information returned for URL")

    if isinstance(info, list):
        if not info:
            raise HTTPException(status_code=400, detail="No downloadable entries found")
        info = info[0]

    if not isinstance(info, dict):
        raise HTTPException(status_code=400, detail="Unsupported response from extractor")

    is_downloadable = info.get("_type") != "playlist" or bool(info.get("entries"))
    formats = _extract_formats(info)

    return ProbeResponse(
        url=payload.url,
        title=info.get("title"),
        duration=info.get("duration"),
        uploader=info.get("uploader"),
        extractor=info.get("extractor"),
        is_downloadable=is_downloadable,
        thumbnail=info.get("thumbnail"),
        formats=formats,
        default_format_id=info.get("format_id"),
    )


@app.post("/download", response_model=DownloadInitResponse)
def start_download(payload: DownloadRequest, background_tasks: BackgroundTasks) -> DownloadInitResponse:
    """Kick off a background download job and return a task id."""
    url_str = str(payload.url)
    task_id = _create_task(url_str, payload.format_id, payload.format_has_audio, payload.format_has_video)
    background_tasks.add_task(
        _download_worker,
        task_id,
        url_str,
        payload.format_id,
        payload.format_has_audio,
        payload.format_has_video,
    )
    return DownloadInitResponse(task_id=task_id)


@app.get("/progress/{task_id}", response_model=TaskStatusResponse)
def get_progress(task_id: str) -> TaskStatusResponse:
    task = _get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    return TaskStatusResponse(
        task_id=task_id,
        status=task.get("status", "pending"),
        progress=task.get("progress"),
        downloaded_bytes=(
            int(downloaded) if isinstance((downloaded := task.get("downloaded_bytes")), (int, float)) else downloaded
        ),
        total_bytes=(int(total) if isinstance((total := task.get("total_bytes")), (int, float)) else total),
        speed=task.get("speed"),
        eta=task.get("eta"),
        filename=task.get("filename"),
        format_expr=task.get("format_expr"),
        detail=task.get("detail"),
    )


@app.get("/download/{task_id}")
def fetch_download(task_id: str, background_tasks: BackgroundTasks) -> FileResponse:
    task = _get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.get("status") != "finished" or not task.get("file_path"):
        raise HTTPException(status_code=409, detail="Download is not ready")

    file_path = Path(task["file_path"])
    if not file_path.exists():
        _cleanup_task(task_id)
        raise HTTPException(status_code=410, detail="Download file no longer available")

    background_tasks.add_task(_cleanup_task, task_id)

    return FileResponse(
        path=file_path,
        filename=task.get("filename") or file_path.name,
        media_type=_guess_media_type(file_path.name) or "application/octet-stream",
    )

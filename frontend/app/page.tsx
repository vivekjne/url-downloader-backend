"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type FormatInfo = {
  format_id: string;
  ext?: string | null;
  resolution?: string | null;
  fps?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  format_note?: string | null;
  abr?: number | null;
  vbr?: number | null;
  acodec?: string | null;
  vcodec?: string | null;
  has_audio: boolean;
  has_video: boolean;
};

type ProbeResult = {
  url: string;
  title?: string | null;
  duration?: number | null;
  uploader?: string | null;
  extractor?: string | null;
  is_downloadable: boolean;
  thumbnail?: string | null;
  formats: FormatInfo[];
  default_format_id?: string | null;
};

type TaskStatus = {
  task_id: string;
  status: "pending" | "downloading" | "finished" | "error";
  progress?: number | null;
  downloaded_bytes?: number | null;
  total_bytes?: number | null;
  speed?: number | null;
  eta?: number | null;
  filename?: string | null;
  format_expr?: string | null;
  detail?: string | null;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

function formatBytes(bytes?: number | null): string | null {
  if (!bytes || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[exponent]}`;
}

function formatLabel(fmt: FormatInfo): string {
  const parts: string[] = [];
  if (fmt.resolution) parts.push(fmt.resolution);
  if (fmt.ext) parts.push(fmt.ext.toUpperCase());
  if (fmt.fps) parts.push(`${fmt.fps}fps`);
  const size = formatBytes(fmt.filesize ?? fmt.filesize_approx ?? null);
  if (size) parts.push(size);
  if (fmt.format_note) parts.push(fmt.format_note);
  if (fmt.has_audio && fmt.has_video) parts.push("AV");
  else if (fmt.has_video) parts.push("Video only");
  else if (fmt.has_audio) parts.push("Audio only");
  return parts.length > 0 ? parts.join(" · ") : fmt.format_id;
}

export default function HomePage() {
  const [url, setUrl] = useState("");
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [loadingProbe, setLoadingProbe] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFormat, setSelectedFormat] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskStatus, setTaskStatus] = useState<TaskStatus | null>(null);

  const pollTimeoutRef = useRef<number | null>(null);
  const fetchingFileRef = useRef(false);

  const disableDownload = useMemo(() => {
    if (!url || loadingProbe || downloading) return true;
    if (!probeResult || !probeResult.is_downloadable) return true;
    return false;
  }, [url, loadingProbe, downloading, probeResult]);

  useEffect(() => {
    if (!taskId) {
      if (pollTimeoutRef.current) {
        window.clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
      return;
    }

    const poll = async () => {
      try {
        const response = await fetch(`${API_BASE}/progress/${taskId}`);
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          throw new Error(
            typeof detail?.detail === "string"
              ? detail.detail
              : "Unable to read progress"
          );
        }

        const data: TaskStatus = await response.json();
        setTaskStatus(data);

        if (data.status === "finished") {
          await finalizeDownload(taskId, data.filename ?? undefined);
          return;
        }

        if (data.status === "error") {
          setError(data.detail ?? "Download failed");
          setDownloading(false);
          setTaskId(null);
          return;
        }

        pollTimeoutRef.current = window.setTimeout(poll, 1000);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Unexpected error while tracking download"
        );
        setDownloading(false);
        setTaskId(null);
      }
    };

    poll();

    return () => {
      if (pollTimeoutRef.current) {
        window.clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  function clearPolling() {
    if (pollTimeoutRef.current) {
      window.clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }

  async function handleProbe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!url) return;
    setLoadingProbe(true);
    setDownloading(false);
    setError(null);
    setProbeResult(null);
    setSelectedFormat(null);
    setTaskId(null);
    setTaskStatus(null);

    try {
      const response = await fetch(`${API_BASE}/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(
          typeof detail?.detail === "string"
            ? detail.detail
            : "Unable to probe URL"
        );
      }

      const data: ProbeResult = await response.json();
      const sortedFormats = [...data.formats].sort((a, b) => {
        const aHasAV = Number(a.has_audio && a.has_video);
        const bHasAV = Number(b.has_audio && b.has_video);
        if (aHasAV !== bHasAV) return bHasAV - aHasAV;
        const aHasAudio = Number(a.has_audio);
        const bHasAudio = Number(b.has_audio);
        if (aHasAudio !== bHasAudio) return bHasAudio - aHasAudio;
        return 0;
      });
      const nextProbe: ProbeResult = { ...data, formats: sortedFormats };
      setProbeResult(nextProbe);
      const audioFriendly =
        sortedFormats.find((format) => format.has_audio && format.has_video) ??
        sortedFormats.find((format) => format.has_audio);
      const initialFormat =
        data.default_format_id ??
        audioFriendly?.format_id ??
        sortedFormats?.[0]?.format_id ??
        null;
      setSelectedFormat(sortedFormats?.[0]?.format_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoadingProbe(false);
    }
  }

  function handleReset() {
    clearPolling();
    if (fetchingFileRef.current) {
      fetchingFileRef.current = false;
    }
    setUrl("");
    setProbeResult(null);
    setSelectedFormat(null);
    setTaskStatus(null);
    setTaskId(null);
    setError(null);
    setDownloading(false);
    setLoadingProbe(false);
  }

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setUrl(text.trim());
      }
    } catch (err) {
      console.error("Clipboard read failed", err);
      setError("Unable to read from clipboard");
    }
  }

  function extractFilename(contentDisposition: string | null): string | null {
    if (!contentDisposition) return null;

    const starMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (starMatch?.[1]) {
      try {
        return decodeURIComponent(starMatch[1]);
      } catch {
        // ignore decode failures and fall back to other patterns
      }
    }

    const match = contentDisposition.match(/filename="?([^";]+)"?/i);
    return match?.[1] ?? null;
  }

  function extensionFromMime(mime: string | null): string | null {
    if (!mime) return null;
    const lookup: Record<string, string> = {
      "video/mp4": ".mp4",
      "video/webm": ".webm",
      "audio/mpeg": ".mp3",
      "audio/mp4": ".m4a",
      "audio/webm": ".webm",
      "application/vnd.apple.mpegurl": ".m3u8",
      "application/x-mpegURL": ".m3u8",
    };
    return lookup[mime] ?? null;
  }

  async function finalizeDownload(task: string, hintedName?: string) {
    if (fetchingFileRef.current) return;
    fetchingFileRef.current = true;

    try {
      const response = await fetch(`${API_BASE}/download/${task}`);
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(
          typeof detail?.detail === "string"
            ? detail.detail
            : "Unable to download file"
        );
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get("content-disposition");
      let filename =
        extractFilename(contentDisposition) ?? hintedName ?? undefined;
      if (!filename) {
        const extension = extensionFromMime(
          response.headers.get("content-type")
        );
        filename = `download${extension ?? ".bin"}`;
      }

      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(blobUrl);
      setTaskStatus((prev) =>
        prev ? { ...prev, status: "finished", progress: 1 } : prev
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unexpected error while downloading file"
      );
      setTaskStatus((prev) => (prev ? { ...prev, status: "error" } : prev));
    } finally {
      fetchingFileRef.current = false;
      setDownloading(false);
      setTaskId(null);
    }
  }

  async function handleDownload() {
    if (!url) return;
    setDownloading(true);
    setError(null);
    setTaskStatus(null);

    try {
      const payload: {
        url: string;
        format_id?: string;
        format_has_audio?: boolean;
        format_has_video?: boolean;
      } = { url };
      if (selectedFormat) {
        payload.format_id = selectedFormat;
        const selectedMeta = probeResult?.formats.find(
          (format) => format.format_id === selectedFormat
        );
        if (selectedMeta) {
          payload.format_has_audio = selectedMeta.has_audio;
          payload.format_has_video = selectedMeta.has_video;
        }
      }

      const response = await fetch(`${API_BASE}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(
          typeof detail?.detail === "string"
            ? detail.detail
            : "Unable to start download"
        );
      }

      const data: { task_id: string } = await response.json();
      setTaskId(data.task_id);
      setTaskStatus({
        task_id: data.task_id,
        status: "pending",
        progress: 0,
        downloaded_bytes: 0,
        total_bytes: null,
        speed: null,
        eta: null,
        filename: null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
      setDownloading(false);
    }
  }

  const progressPercent =
    taskStatus?.progress != null
      ? Math.min(100, Math.round((taskStatus.progress || 0) * 100))
      : null;
  const speedText = formatBytes(taskStatus?.speed ?? null);
  const downloadedText = formatBytes(taskStatus?.downloaded_bytes ?? null);

  return (
    <main className="page">
      <article className="card">
        <h1>URL Downloader</h1>
        <p className="subtitle">
          Check, choose a format, and download media via the FastAPI + yt-dlp
          backend.
        </p>

        <form onSubmit={handleProbe} className="form">
          <label htmlFor="url">Media URL</label>
          <div className="row">
            <div className="input-container">
              <input
                id="url"
                type="url"
                placeholder="https://www.youtube.com/watch?v=123"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                required
              />
              <button
                type="button"
                onClick={handlePaste}
                className="icon-button inline"
                title="Paste URL from clipboard"
                aria-label="Paste URL from clipboard"
              >
                📋
              </button>
            </div>
            <button type="submit" disabled={loadingProbe} className="secondary">
              {loadingProbe ? "Checking url..." : "Download"}
            </button>
            {probeResult && (
              <button
                type="button"
                onClick={handleReset}
                className="icon-button"
                title="Reset form"
                aria-label="Reset form"
              >
                ⟲
              </button>
            )}
          </div>
        </form>

        {error && <p className="error">{error}</p>}

        {probeResult && (
          <section className="probe">
            <div className="probe-header">
              <div>
                <h2>Probe Result</h2>
                <dl>
                  <dt>Title</dt>
                  <dd>{probeResult.title ?? "—"}</dd>
                  <dt>Uploader</dt>
                  <dd>{probeResult.uploader ?? "—"}</dd>
                  <dt>Duration</dt>
                  <dd>
                    {probeResult.duration ? `${probeResult.duration} sec` : "—"}
                  </dd>
                  <dt>Extractor</dt>
                  <dd>{probeResult.extractor ?? "—"}</dd>
                  <dt>Downloadable</dt>
                  <dd>{probeResult.is_downloadable ? "Yes" : "No"}</dd>
                </dl>
              </div>
              {probeResult.thumbnail && (
                <div className="thumbnail-wrapper">
                  <img
                    src={probeResult.thumbnail}
                    alt="Thumbnail"
                    className="thumbnail"
                    loading="lazy"
                  />
                </div>
              )}
            </div>

            {probeResult.formats.length > 0 && (
              <div className="formats">
                <label htmlFor="format">Format</label>
                <select
                  id="format"
                  value={selectedFormat ?? ""}
                  onChange={(event) =>
                    setSelectedFormat(event.target.value || null)
                  }
                >
                  {probeResult.formats.map((format) => (
                    <option key={format.format_id} value={format.format_id}>
                      {`${format.format_id} · ${formatLabel(format)}`}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </section>
        )}

        {probeResult && (
          <button
            type="button"
            onClick={handleDownload}
            disabled={disableDownload}
            className="download"
          >
            {downloading ? "Downloading..." : "Download"}
          </button>
        )}

        {taskStatus && (
          <section className="progress">
            <h2>Status: {taskStatus.status}</h2>
            {progressPercent !== null && (
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            )}
            <p className="progress-meta">
              {downloadedText ? `${downloadedText} downloaded` : ""}
              {taskStatus.eta
                ? ` · ETA ${Math.max(0, Math.round(taskStatus.eta))}s`
                : ""}
              {speedText ? ` · ${speedText}/s` : ""}
            </p>
            {taskStatus.format_expr && (
              <p className="progress-format">
                Format: {taskStatus.format_expr}
              </p>
            )}
            {taskStatus.detail && (
              <p className="progress-detail">{taskStatus.detail}</p>
            )}
          </section>
        )}

        <footer>
          <small>
            API Base: <code>{API_BASE}</code>
          </small>
        </footer>
      </article>

      <style jsx>{`
        .page {
          display: flex;
          justify-content: center;
          align-items: center;
          padding: 3rem 1rem;
        }
        .card {
          width: min(820px, 100%);
          background: #fff;
          border-radius: 16px;
          padding: 2.5rem;
          box-shadow: 0 18px 40px rgba(15, 23, 42, 0.08);
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }
        h1 {
          margin: 0;
        }
        .subtitle {
          margin: 0;
          color: #475569;
        }
        .form {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }
        label {
          font-weight: 600;
        }
        .row {
          display: flex;
          gap: 0.75rem;
          flex-wrap: wrap;
        }
        .input-container {
          position: relative;
          flex: 1;
          min-width: 240px;
        }
        input {
          width: 100%;
          padding: 0.75rem 2.75rem 0.75rem 0.75rem;
          border: 1px solid #cbd5f5;
          border-radius: 12px;
          font-size: 1rem;
        }
        input:focus {
          outline: none;
          border-color: #3b82f6;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25);
        }
        button {
          padding: 0.75rem 1.5rem;
          border-radius: 12px;
          border: none;
          background: #2563eb;
          color: #fff;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
        }
        button.secondary {
          background: #0f172a;
        }
        .icon-button {
          width: 44px;
          padding: 0.75rem;
          background: transparent;
          border: 1px solid #cbd5f5;
          color: #0f172a;
          font-size: 1.1rem;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .icon-button.inline {
          position: absolute;
          top: 0;
          right: 0;
          height: 100%;
          border-left: none;
          border-top-left-radius: 0;
          border-bottom-left-radius: 0;
        }
        .icon-button:hover {
          background: rgba(15, 23, 42, 0.06);
        }
        button[disabled] {
          cursor: not-allowed;
          background: #94a3b8;
        }
        select {
          width: 100%;
          padding: 0.7rem;
          border-radius: 12px;
          border: 1px solid #cbd5f5;
          font-size: 1rem;
        }
        select:focus {
          outline: none;
          border-color: #3b82f6;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25);
        }
        .error {
          margin: 0;
          color: #dc2626;
          font-weight: 600;
        }
        .probe {
          border-radius: 12px;
          border: 1px solid #e2e8f0;
          background: #f8fafc;
          padding: 1.5rem;
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }
        .probe-header {
          display: flex;
          gap: 1rem;
          align-items: flex-start;
          flex-wrap: wrap;
        }
        .thumbnail-wrapper {
          flex-shrink: 0;
          width: 200px;
          height: 120px;
          border-radius: 12px;
          overflow: hidden;
          position: relative;
        }
        .thumbnail {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        @media (max-width: 600px) {
          .thumbnail-wrapper {
            width: 100%;
            height: 180px;
          }
        }
        dl {
          display: grid;
          grid-template-columns: 120px 1fr;
          row-gap: 0.5rem;
          column-gap: 1rem;
          margin: 0;
        }
        dt {
          font-weight: 600;
          color: #1e293b;
        }
        dd {
          margin: 0;
          color: #334155;
        }
        .formats {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
        .download {
          margin-top: 0.5rem;
          width: 100%;
          align-self: center;
        }
        .progress {
          border-radius: 12px;
          border: 1px solid #e2e8f0;
          background: #f1f5f9;
          padding: 1.25rem;
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }
        .progress-bar {
          width: 100%;
          height: 12px;
          border-radius: 999px;
          background: rgba(37, 99, 235, 0.15);
          overflow: hidden;
        }
        .progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #2563eb, #60a5fa);
        }
        .progress-meta {
          margin: 0;
          color: #334155;
        }
        .progress-detail {
          margin: 0;
          color: #dc2626;
          font-weight: 600;
        }
        .progress-format {
          margin: 0;
          color: #1e293b;
          font-weight: 500;
        }
        footer {
          margin-top: auto;
          text-align: right;
          color: #64748b;
        }
      `}</style>
    </main>
  );
}

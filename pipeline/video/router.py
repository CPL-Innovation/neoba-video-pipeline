"""FastAPI router for the video pipeline.

Mounted on the existing app in pipeline/server.py via:

    from pipeline.video.router import router as video_router
    app.include_router(video_router)
"""

from __future__ import annotations

import threading
import time
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from pipeline.video.ingest import (
    VIDEO_RUNS_DIR,
    derive_video_id,
    list_ingested_videos,
    list_source_videos,
    load_ingest_result,
    resolve_source_path,
    run_ingest,
)

router = APIRouter(prefix="/api/video", tags=["video"])

# In-memory job tracking for ingest runs. Mirrors the running_jobs pattern
# in pipeline/server.py but kept separate to avoid namespace collisions
# with the classifier jobs.
ingest_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()


class IngestRequest(BaseModel):
    source_path: str
    video_id: str | None = None
    threshold: float = 27.0


def _set_job(video_id: str, **fields: Any) -> None:
    with _jobs_lock:
        job = ingest_jobs.setdefault(video_id, {})
        job.update(fields)


def _get_job(video_id: str) -> dict[str, Any] | None:
    with _jobs_lock:
        job = ingest_jobs.get(video_id)
        return dict(job) if job else None


@router.get("/source-videos")
async def get_source_videos():
    """List videos available in public/data/source/videos/."""
    return list_source_videos()


@router.get("/videos")
async def list_videos():
    """List all ingested videos (anything under data/runs/video/)."""
    return list_ingested_videos()


@router.post("/ingest")
async def ingest_video(req: IngestRequest):
    """Kick off Stage 1 ingest in a background thread.

    Returns immediately with the assigned video_id and status='started'.
    Poll GET /api/video/ingest/{video_id}/status for progress.
    """
    try:
        src = resolve_source_path(req.source_path)
    except Exception as e:
        raise HTTPException(400, f"Invalid path: {e}")
    if not src.exists():
        raise HTTPException(404, f"Video not found: {src}")

    vid = derive_video_id(src, req.video_id)

    existing = _get_job(vid)
    if existing and existing.get("status") == "running":
        raise HTTPException(409, f"Ingest already running for {vid}")

    _set_job(
        vid,
        status="running",
        phase="queued",
        scenes_done=0,
        scenes_total=0,
        duration=None,
        scene_count=None,
        error=None,
        started_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
    )

    def progress_callback(payload: dict) -> None:
        _set_job(vid, **payload)

    def worker() -> None:
        try:
            result = run_ingest(
                source_path=src,
                video_id=vid,
                threshold=req.threshold,
                progress_callback=progress_callback,
            )
            _set_job(
                vid,
                status="completed",
                phase="completed",
                scene_count=result["scene_count"],
                duration=result["duration"],
                finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
            )
        except Exception as e:
            _set_job(
                vid,
                status="failed",
                phase="failed",
                error=str(e),
                finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
            )

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()

    return {"video_id": vid, "status": "started"}


@router.get("/ingest/{video_id}/status")
async def get_ingest_status(video_id: str):
    job = _get_job(video_id)
    if job is not None:
        return job
    # Fall back to disk: if scenes.json exists this video has been ingested
    # in a previous server session.
    result = load_ingest_result(video_id)
    if result is None:
        raise HTTPException(404, f"No ingest job or output for {video_id}")
    return {
        "status": result.get("status", "completed"),
        "phase": "completed",
        "scene_count": result.get("scene_count"),
        "duration": result.get("duration"),
    }


@router.get("/videos/{video_id}/scenes")
async def get_scenes(video_id: str):
    result = load_ingest_result(video_id)
    if result is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    return result


@router.get("/videos/{video_id}/keyframes/{filename}")
async def get_keyframe(video_id: str, filename: str):
    """Serve a single keyframe JPEG. Path-traversal protected: the resolved
    path must live inside this video's keyframes directory."""
    keyframes_dir = (VIDEO_RUNS_DIR / video_id / "keyframes").resolve()
    if not keyframes_dir.exists():
        raise HTTPException(404, f"No keyframes for {video_id}")

    target = (keyframes_dir / filename).resolve()
    try:
        target.relative_to(keyframes_dir)
    except ValueError:
        raise HTTPException(400, "Invalid filename")

    if not target.is_file():
        raise HTTPException(404, f"Keyframe not found: {filename}")

    return FileResponse(
        target,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=3600"},
    )

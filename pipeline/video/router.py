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
    apply_all_merges,
    apply_merges,
    derive_video_id,
    list_ingested_videos,
    list_source_videos,
    load_ingest_result,
    load_merges,
    delete_keyframe,
    merge_scenes,
    rename_scene,
    resolve_source_path,
    run_ingest,
    unmerge_group,
)
from pipeline.video.transcribe import (
    DEFAULT_MODEL as WHISPER_DEFAULT_MODEL,
    load_transcript,
    run_transcribe,
    transcript_path_for,
)
from pipeline.video.transcript_cleanup import clean_segments

router = APIRouter(prefix="/api/video", tags=["video"])

# In-memory job tracking for ingest runs. Mirrors the running_jobs pattern
# in pipeline/server.py but kept separate to avoid namespace collisions
# with the classifier jobs.
ingest_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()

# Separate job table for Stage 2 transcription so ingest and transcribe
# can run on the same video_id without clobbering each other's state.
transcribe_jobs: dict[str, dict[str, Any]] = {}
_transcribe_lock = threading.Lock()


def _set_transcribe_job(video_id: str, **fields: Any) -> None:
    with _transcribe_lock:
        job = transcribe_jobs.setdefault(video_id, {})
        job.update(fields)


def _get_transcribe_job(video_id: str) -> dict[str, Any] | None:
    with _transcribe_lock:
        job = transcribe_jobs.get(video_id)
        return dict(job) if job else None


class IngestRequest(BaseModel):
    source_path: str
    video_id: str | None = None
    threshold: float = 27.0


class MergeRequest(BaseModel):
    scene_ids: list[str]


class TranscribeRequest(BaseModel):
    video_id: str
    model: str = WHISPER_DEFAULT_MODEL
    word_timestamps: bool = False
    force: bool = False
    cleanup: bool = True


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


def _merged_scenes_response(video_id: str) -> dict:
    """Build the merged-view payload (raw scenes + applied merges)."""
    result = load_ingest_result(video_id)
    if result is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    merges = load_merges(video_id)
    merged_scenes = apply_merges(result["scenes"], merges)
    return {
        **result,
        "scenes": merged_scenes,
        "scene_count": len(merged_scenes),
        "raw_scene_count": result["scene_count"],
        "merge_groups": merges["groups"],
    }


@router.get("/videos/{video_id}/scenes")
async def get_scenes(video_id: str, raw: bool = False):
    """Return scenes for a video.

    By default, any user-created merge groups (from `merges.json`) are
    folded into the scene list — adjacent raw scenes belonging to a group
    collapse into a single merged scene whose `scene_id` is the group ID
    and whose keyframes are the union of the members'. Pass `?raw=true`
    to bypass this and get the untouched PySceneDetect output.
    """
    if raw:
        result = load_ingest_result(video_id)
        if result is None:
            raise HTTPException(404, f"No ingest output for {video_id}")
        return result
    return _merged_scenes_response(video_id)


@router.post("/videos/{video_id}/merges")
async def create_merge(video_id: str, req: MergeRequest):
    """Merge a contiguous run of scenes into a pending group.

    Accepts a mix of raw scene IDs and existing *pending* group IDs. The
    combined set must be contiguous in the raw scene list. Pending groups
    touched by the merge are absorbed into the new larger group. Committed
    groups are frozen — attempting to merge into one returns 400. New
    groups always start with status="pending"; call POST
    /videos/{video_id}/merges/apply to commit them.
    """
    if load_ingest_result(video_id) is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    try:
        merge_scenes(video_id, req.scene_ids)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _merged_scenes_response(video_id)


@router.delete("/videos/{video_id}/merges/{group_id}")
async def delete_merge(video_id: str, group_id: str):
    """Unmerge a pending group. Committed groups cannot be unmerged."""
    if load_ingest_result(video_id) is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    try:
        unmerge_group(video_id, group_id)
    except ValueError as e:
        # "committed and cannot be unmerged" is semantically a conflict,
        # "unknown group_id" is a 404. Cheap sniff on the message.
        if "committed" in str(e):
            raise HTTPException(409, str(e))
        raise HTTPException(404, str(e))
    return _merged_scenes_response(video_id)


@router.post("/videos/{video_id}/merges/apply")
async def apply_merges_endpoint(video_id: str):
    """Bake all merge groups into scenes.json. Irreversible from the UI —
    the only way to undo afterwards is to re-run Stage 1.

    After this call, scenes.json is the canonical scene list. The
    merges.json sidecar is cleared. Downstream stages can read
    scenes.json directly without any merge-folding logic.
    """
    if load_ingest_result(video_id) is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    try:
        apply_all_merges(video_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    # After apply, merges.json groups is empty, so _merged_scenes_response
    # returns scenes.json verbatim — which is now the baked merged view.
    return _merged_scenes_response(video_id)


class RenameRequest(BaseModel):
    old_id: str
    new_id: str


class DeleteKeyframeRequest(BaseModel):
    scene_id: str
    keyframe_path: str


@router.post("/videos/{video_id}/scenes/delete-keyframe")
async def delete_keyframe_endpoint(video_id: str, req: DeleteKeyframeRequest):
    """Remove a keyframe from a scene."""
    if load_ingest_result(video_id) is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    try:
        delete_keyframe(video_id, req.scene_id, req.keyframe_path)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _merged_scenes_response(video_id)


@router.patch("/videos/{video_id}/scenes/rename")
async def rename_scene_endpoint(video_id: str, req: RenameRequest):
    """Rename a scene (raw or merged). Updates scenes.json and merges.json."""
    if load_ingest_result(video_id) is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    try:
        rename_scene(video_id, req.old_id, req.new_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _merged_scenes_response(video_id)


@router.post("/transcribe")
async def transcribe_video(req: TranscribeRequest):
    """Kick off Stage 2 mlx-whisper transcription in a background thread.

    Requires that Stage 1 ingest has already run for this video_id. If
    audio.wav is missing (pre-existing run from before Stage 1 included
    audio extraction), the worker will extract it on-the-fly before
    loading the model.
    """
    run_dir = VIDEO_RUNS_DIR / req.video_id
    if not run_dir.exists():
        raise HTTPException(
            404, f"No ingest run for {req.video_id}. Run Stage 1 first."
        )

    existing = _get_transcribe_job(req.video_id)
    if existing and existing.get("status") == "running":
        raise HTTPException(
            409, f"Transcription already running for {req.video_id}"
        )

    _set_transcribe_job(
        req.video_id,
        status="running",
        phase="queued",
        model=req.model,
        word_timestamps=req.word_timestamps,
        error=None,
        started_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
    )

    def progress_callback(payload: dict) -> None:
        _set_transcribe_job(req.video_id, **payload)

    def worker() -> None:
        try:
            result = run_transcribe(
                video_id=req.video_id,
                model=req.model,
                word_timestamps=req.word_timestamps,
                force=req.force,
                cleanup=req.cleanup,
                progress_callback=progress_callback,
            )
            _set_transcribe_job(
                req.video_id,
                status="completed",
                phase="completed",
                segment_count=len(result.get("segments", [])),
                language=result.get("language"),
                finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
            )
        except Exception as e:
            _set_transcribe_job(
                req.video_id,
                status="failed",
                phase="failed",
                error=str(e),
                finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
            )

    threading.Thread(target=worker, daemon=True).start()
    return {"video_id": req.video_id, "status": "started"}


@router.get("/transcribe/{video_id}/status")
async def get_transcribe_status(video_id: str):
    job = _get_transcribe_job(video_id)
    if job is not None:
        return job
    # Fall back to disk: if transcript.json exists, this video was
    # transcribed in a previous server session.
    result = load_transcript(video_id)
    if result is None:
        raise HTTPException(
            404, f"No transcribe job or output for {video_id}"
        )
    return {
        "status": "completed",
        "phase": "completed",
        "segment_count": len(result.get("segments", [])),
        "language": result.get("language"),
    }


@router.get("/videos/{video_id}/transcript")
async def get_transcript(video_id: str):
    result = load_transcript(video_id)
    if result is None:
        raise HTTPException(404, f"No transcript for {video_id}")
    return result


@router.post("/transcribe/{video_id}/reclean")
async def reclean_transcript(video_id: str):
    """Re-apply the cleanup pass to an existing transcript on disk.

    Pure-Python operation on the stored segment list — no Whisper
    re-run, no audio decode, runs in milliseconds. Source for cleanup
    is `segments_raw` if present, otherwise `segments` (legacy
    transcripts written before the cleanup layer existed). The result
    is written back in place; both `segments` (cleaned) and
    `segments_raw` (untouched) are persisted so the operation stays
    reversible.
    """
    import json

    transcript_path = transcript_path_for(VIDEO_RUNS_DIR / video_id)
    if not transcript_path.exists():
        raise HTTPException(404, f"No transcript for {video_id}")

    with open(transcript_path) as f:
        transcript = json.load(f)

    # Prefer the raw list. For legacy transcripts written before this
    # endpoint existed, fall back to the current segments and treat
    # them as raw going forward.
    source_segments = (
        transcript.get("segments_raw") or transcript.get("segments") or []
    )

    cleaned, stats = clean_segments(source_segments)
    transcript["segments"] = cleaned
    transcript["segments_raw"] = source_segments
    transcript["cleanup"] = {"applied": True, **stats}

    with open(transcript_path, "w") as f:
        json.dump(transcript, f, indent=2)

    return transcript


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

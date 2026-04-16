"""FastAPI router for the video pipeline.

Mounted on the existing app in pipeline/server.py via:

    from pipeline.video.router import router as video_router
    app.include_router(video_router)
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from pipeline.video.segments import (
    assign_item_to_segment,
    build_segments,
    build_segments_from_tags,
    clear_segments,
    create_segment,
    move_to_segment,
    rename_segment,
    update_segment_description,
    update_segment_type,
)
from pipeline.video.ingest import (
    VIDEO_RUNS_DIR,
    apply_all_merges,
    apply_merges,
    derive_video_id,
    list_ingested_videos,
    load_notes,
    get_note,
    set_note,
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
from pipeline.video.vlm import (
    DEFAULT_MODEL as VLM_DEFAULT_MODEL,
    DEFAULT_PROMPT as VLM_DEFAULT_PROMPT,
    analyze_segment as vlm_analyze_segment,
)

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


def _reconcile_segments(
    segments: list[dict],
    merges: dict,
    merged_scenes: list[dict],
) -> list[dict]:
    """Reconcile segment scene_ids with merged scene IDs.

    After merging, raw scene IDs that were absorbed into a merge group no
    longer exist in the merged scene list.  This rewrites each segment's
    scene_ids so they reference the group ID instead, and updates
    start/end accordingly.  Empty segments are preserved (they still
    render in the UI).
    """
    if not merges.get("groups"):
        return segments

    # raw_scene_id → merged group_id
    raw_to_merged: dict[str, str] = {}
    for g in merges["groups"]:
        for sid in g["scene_ids"]:
            raw_to_merged[sid] = g["group_id"]

    merged_scene_ids = {s["scene_id"] for s in merged_scenes}
    scene_by_id = {s["scene_id"]: s for s in merged_scenes}

    reconciled: list[dict] = []
    for seg in segments:
        new_ids: list[str] = []
        seen: set[str] = set()
        for sid in seg["scene_ids"]:
            mapped = raw_to_merged.get(sid, sid)
            if mapped not in seen and mapped in merged_scene_ids:
                seen.add(mapped)
                new_ids.append(mapped)
        seg_copy = {**seg, "scene_ids": new_ids}
        if new_ids:
            members = [scene_by_id[sid] for sid in new_ids if sid in scene_by_id]
            if members:
                seg_copy["start"] = round(min(s["start"] for s in members), 3)
                seg_copy["end"] = round(max(s["end"] for s in members), 3)
        reconciled.append(seg_copy)
    return reconciled


def _merged_scenes_response(video_id: str) -> dict:
    """Build the merged-view payload (raw scenes + applied merges)."""
    result = load_ingest_result(video_id)
    if result is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    merges = load_merges(video_id)
    merged_scenes = apply_merges(result["scenes"], merges)

    # Reconcile segments with merged scene IDs
    segments = result.get("segments")  # type: ignore[assignment]
    if segments:
        segments = _reconcile_segments(segments, merges, merged_scenes)

    response = {
        **result,
        "scenes": merged_scenes,
        "scene_count": len(merged_scenes),
        "raw_scene_count": result["scene_count"],
        "merge_groups": merges["groups"],
    }
    if segments is not None:
        response["segments"] = segments
    if "segment_detector" in result:
        response["segment_detector"] = result["segment_detector"]  # type: ignore[index]
    return response


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

    Accepts a mix of raw scene IDs and existing group IDs. The combined
    set must be contiguous in the raw scene list. Existing groups touched
    by the merge are absorbed into the new larger group. Call POST
    /videos/{video_id}/merges/apply to bake all pending groups into
    scenes.json.
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
    """Unmerge a pending group."""
    if load_ingest_result(video_id) is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    try:
        unmerge_group(video_id, group_id)
    except ValueError as e:
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


class TimeRangeRequest(BaseModel):
    scene_id: str
    start: float
    end: float


@router.patch("/videos/{video_id}/scenes/time-range")
async def update_scene_time_range(video_id: str, req: TimeRangeRequest):
    """Update a scene's start/end times in scenes.json."""
    result = load_ingest_result(video_id)
    if result is None:
        raise HTTPException(404, f"No ingest output for {video_id}")

    scene = next(
        (s for s in result["scenes"] if s["scene_id"] == req.scene_id), None
    )
    if scene is None:
        raise HTTPException(400, f"Unknown scene_id: {req.scene_id}")
    if req.start >= req.end:
        raise HTTPException(400, "start must be less than end")

    scene["start"] = round(req.start, 3)
    scene["end"] = round(req.end, 3)
    scene["duration"] = round(req.end - req.start, 3)

    run_dir = VIDEO_RUNS_DIR / video_id
    import json as _json

    with open(run_dir / "scenes.json", "w") as f:
        _json.dump(result, f, indent=2)

    return _merged_scenes_response(video_id)


class TagsRequest(BaseModel):
    scene_id: str
    tags: list[str]


@router.patch("/videos/{video_id}/scenes/tags")
async def update_scene_tags(video_id: str, req: TagsRequest):
    """Set the tags list for a scene in scenes.json."""
    result = load_ingest_result(video_id)
    if result is None:
        raise HTTPException(404, f"No ingest output for {video_id}")

    scene = next(
        (s for s in result["scenes"] if s["scene_id"] == req.scene_id), None
    )
    if scene is None:
        raise HTTPException(400, f"Unknown scene_id: {req.scene_id}")

    scene["tags"] = req.tags  # type: ignore[typeddict-unknown-key]

    run_dir = VIDEO_RUNS_DIR / video_id
    import json as _json

    with open(run_dir / "scenes.json", "w") as f:
        _json.dump(result, f, indent=2)

    return _merged_scenes_response(video_id)


class SplitRequest(BaseModel):
    scene_id: str
    split_point: float


class TrimRequest(BaseModel):
    scene_id: str
    trim_point: float
    direction: str  # "keep_before" | "keep_after"


@router.post("/videos/{video_id}/scenes/trim")
async def trim_scene(video_id: str, req: TrimRequest):
    """Trim a scene at a given timestamp.

    keep_before: scene keeps [start, trim_point], next scene absorbs the rest.
    keep_after:  scene keeps [trim_point, end], prev scene absorbs the rest.
    """
    import json as _json

    result = load_ingest_result(video_id)
    if result is None:
        raise HTTPException(404, f"No ingest output for {video_id}")

    scenes = result["scenes"]
    idx = next(
        (i for i, s in enumerate(scenes) if s["scene_id"] == req.scene_id),
        None,
    )
    if idx is None:
        raise HTTPException(400, f"Unknown scene_id: {req.scene_id}")

    scene = scenes[idx]
    if req.trim_point <= scene["start"] or req.trim_point >= scene["end"]:
        raise HTTPException(
            400, "trim_point must be strictly between scene start and end"
        )

    tp = round(req.trim_point, 3)

    if req.direction == "keep_before":
        scene["end"] = tp
        scene["duration"] = round(tp - scene["start"], 3)
        if idx + 1 < len(scenes):
            nxt = scenes[idx + 1]
            nxt["start"] = tp
            nxt["duration"] = round(nxt["end"] - tp, 3)
    elif req.direction == "keep_after":
        scene["start"] = tp
        scene["duration"] = round(scene["end"] - tp, 3)
        if idx - 1 >= 0:
            prev = scenes[idx - 1]
            prev["end"] = tp
            prev["duration"] = round(tp - prev["start"], 3)
    else:
        raise HTTPException(400, "direction must be keep_before or keep_after")

    run_dir = VIDEO_RUNS_DIR / video_id
    with open(run_dir / "scenes.json", "w") as f:
        _json.dump(result, f, indent=2)

    return _merged_scenes_response(video_id)


@router.post("/videos/{video_id}/scenes/split")
async def split_scene(video_id: str, req: SplitRequest):
    """Split a scene into two at the given timestamp.

    The original scene keeps [start, split_point] and its original ID.
    A new scene with ID ``{original_id}_1`` is created for
    [split_point, end].  Keyframes are distributed to the sub-scene
    whose time range contains them.  If the scene belongs to a segment,
    both halves remain in that segment.
    """
    import json as _json

    result = load_ingest_result(video_id)
    if result is None:
        raise HTTPException(404, f"No ingest output for {video_id}")

    scenes = result["scenes"]
    idx = next(
        (i for i, s in enumerate(scenes) if s["scene_id"] == req.scene_id),
        None,
    )
    if idx is None:
        raise HTTPException(400, f"Unknown scene_id: {req.scene_id}")

    scene = scenes[idx]
    sp = round(req.split_point, 3)

    if sp <= scene["start"] or sp >= scene["end"]:
        raise HTTPException(
            400, "split_point must be strictly between scene start and end"
        )

    original_id = scene["scene_id"]
    new_id = f"{original_id}_1"

    # Distribute keyframes
    kf_before = [kf for kf in scene.get("keyframes", []) if kf["timestamp"] < sp]
    kf_after = [kf for kf in scene.get("keyframes", []) if kf["timestamp"] >= sp]

    # Update original scene → first half
    original_end = scene["end"]
    scene["end"] = sp
    scene["duration"] = round(sp - scene["start"], 3)
    scene["keyframes"] = kf_before

    # Create second half
    new_scene = {
        "scene_id": new_id,
        "start": sp,
        "end": original_end,
        "duration": round(original_end - sp, 3),
        "keyframes": kf_after,
    }
    # Copy tags if present
    if scene.get("tags"):
        new_scene["tags"] = list(scene["tags"])

    # Insert right after the original
    scenes.insert(idx + 1, new_scene)
    result["scene_count"] = len(scenes)

    # Update segments: if the original scene belongs to a segment,
    # insert the new scene ID right after it in that segment's scene_ids
    segments = result.get("segments", [])
    for seg in segments:
        if original_id in seg["scene_ids"]:
            pos = seg["scene_ids"].index(original_id)
            seg["scene_ids"].insert(pos + 1, new_id)
            # Update segment end time if needed
            seg["end"] = round(
                max(seg["end"], original_end), 3
            )
            break

    run_dir = VIDEO_RUNS_DIR / video_id
    with open(run_dir / "scenes.json", "w") as f:
        _json.dump(result, f, indent=2)

    return _merged_scenes_response(video_id)


_TAGS_FILE = Path(__file__).resolve().parent / "tags.json"


@router.get("/tags")
async def get_valid_tags():
    """Return pipeline config (tags and segment types) from tags.json."""
    import json as _json

    if not _TAGS_FILE.exists():
        return {"tags": [], "segment_types": []}
    with open(_TAGS_FILE) as f:
        data = _json.load(f)
    # Backward compat: if still a plain array, wrap it
    if isinstance(data, list):
        return {"tags": data, "segment_types": []}
    return data


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


class SegmentUpdate(BaseModel):
    id: int
    text: str | None = None
    start: float | None = None
    end: float | None = None


class TranscriptEditRequest(BaseModel):
    updates: list[SegmentUpdate] = []
    deletions: list[int] = []


@router.patch("/videos/{video_id}/transcript/segments")
async def edit_transcript_segments(video_id: str, req: TranscriptEditRequest):
    """Edit transcript segments in place.

    Updates change the text of segments matching by id. Deletions remove
    segments by id. Writes the result back to transcript.json and returns
    the updated segments array.
    """
    import json as _json

    t_path = transcript_path_for(VIDEO_RUNS_DIR / video_id)
    if not t_path.exists():
        raise HTTPException(404, f"No transcript for {video_id}")

    with open(t_path) as f:
        transcript = _json.load(f)

    segments: list[dict] = transcript.get("segments", [])

    # Apply updates
    update_map = {u.id: u for u in req.updates}
    for seg in segments:
        if seg["id"] in update_map:
            u = update_map[seg["id"]]
            if u.text is not None:
                seg["text"] = u.text
            if u.start is not None:
                seg["start"] = u.start
            if u.end is not None:
                seg["end"] = u.end

    # Apply deletions
    delete_set = set(req.deletions)
    if delete_set:
        segments = [s for s in segments if s["id"] not in delete_set]

    transcript["segments"] = segments

    with open(t_path, "w") as f:
        _json.dump(transcript, f, indent=2)

    return {"segments": segments}


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


# ── Segment detection ───────────────────────────────────────────────────


class SegmentDetectRequest(BaseModel):
    luminance_threshold: float = 30
    min_duration: float = 0.5
    auto_merge_black_slugs: bool = True


class SegmentDetectFromTagsRequest(BaseModel):
    auto_merge_black_slugs: bool = True


class SegmentAssignItemRequest(BaseModel):
    item_id: str | None = None


class SegmentRenameRequest(BaseModel):
    name: str


class SegmentDescriptionRequest(BaseModel):
    description: str


class SegmentTypeRequest(BaseModel):
    type: str


class CreateSegmentRequest(BaseModel):
    scene_ids: list[str]
    name: str
    type: str = "content"


class MoveToSegmentRequest(BaseModel):
    scene_ids: list[str]
    target_segment_id: str


@router.post("/videos/{video_id}/segments/detect")
async def detect_segments(video_id: str, req: SegmentDetectRequest):
    """Detect black slugs and group scenes into segments."""
    if load_ingest_result(video_id) is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    try:
        build_segments(
            video_id,
            luminance_threshold=req.luminance_threshold,
            min_duration=req.min_duration,
            auto_merge_black_slugs=req.auto_merge_black_slugs,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _merged_scenes_response(video_id)


@router.post("/videos/{video_id}/segments/detect-from-tags")
async def detect_segments_from_tags(
    video_id: str, req: SegmentDetectFromTagsRequest
):
    """Build segments using existing black_slug tags as dividers."""
    if load_ingest_result(video_id) is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    try:
        build_segments_from_tags(
            video_id,
            auto_merge_black_slugs=req.auto_merge_black_slugs,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _merged_scenes_response(video_id)


@router.patch("/videos/{video_id}/segments/{segment_id}/rename")
async def rename_segment_endpoint(
    video_id: str, segment_id: str, req: SegmentRenameRequest
):
    """Rename a segment."""
    if load_ingest_result(video_id) is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    try:
        rename_segment(video_id, segment_id, req.name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _merged_scenes_response(video_id)


@router.patch("/videos/{video_id}/segments/{segment_id}/description")
async def update_description_endpoint(
    video_id: str, segment_id: str, req: SegmentDescriptionRequest
):
    """Update a segment's description."""
    if load_ingest_result(video_id) is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    try:
        update_segment_description(video_id, segment_id, req.description)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _merged_scenes_response(video_id)


@router.patch("/videos/{video_id}/segments/{segment_id}/type")
async def update_type_endpoint(
    video_id: str, segment_id: str, req: SegmentTypeRequest
):
    """Update a segment's type (validated against tags.json segment_types)."""
    if load_ingest_result(video_id) is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    try:
        update_segment_type(video_id, segment_id, req.type)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _merged_scenes_response(video_id)


@router.patch("/videos/{video_id}/segments/{segment_id}/assign-item")
async def assign_item_endpoint(
    video_id: str, segment_id: str, req: SegmentAssignItemRequest
):
    """Assign a catalog item_id to a segment."""
    if load_ingest_result(video_id) is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    try:
        assign_item_to_segment(video_id, segment_id, req.item_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _merged_scenes_response(video_id)


@router.delete("/videos/{video_id}/segments")
async def clear_segments_endpoint(video_id: str):
    """Remove all segment data."""
    if load_ingest_result(video_id) is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    try:
        clear_segments(video_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _merged_scenes_response(video_id)


@router.post("/videos/{video_id}/segments/create")
async def create_segment_endpoint(video_id: str, req: CreateSegmentRequest):
    """Create a new segment from specific scene IDs.

    Scenes must be unsegmented or belong to boundary segments. If they
    belong to a boundary segment, they are removed from it. The new
    segment is inserted at the correct position and all subsequent
    segment indices are shifted.
    """
    if load_ingest_result(video_id) is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    try:
        create_segment(video_id, req.scene_ids, req.name, req.type)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _merged_scenes_response(video_id)


@router.post("/videos/{video_id}/segments/move")
async def move_to_segment_endpoint(video_id: str, req: MoveToSegmentRequest):
    """Move scenes into an existing segment.

    Scenes are extracted from their current segment (splitting if needed)
    and inserted into the target segment at the correct timestamp position.
    """
    if load_ingest_result(video_id) is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    try:
        move_to_segment(video_id, req.scene_ids, req.target_segment_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _merged_scenes_response(video_id)


# ── VLM analysis ──────────────────────────────────────────────────────────

vlm_jobs: dict[str, dict[str, Any]] = {}
_vlm_lock = threading.Lock()


def _set_vlm_job(job_key: str, **fields: Any) -> None:
    with _vlm_lock:
        job = vlm_jobs.setdefault(job_key, {})
        job.update(fields)


def _get_vlm_job(job_key: str) -> dict[str, Any] | None:
    with _vlm_lock:
        job = vlm_jobs.get(job_key)
        return dict(job) if job else None


class VlmAnalyzeRequest(BaseModel):
    prompt: str = VLM_DEFAULT_PROMPT
    model: str = VLM_DEFAULT_MODEL


@router.post("/videos/{video_id}/segments/{segment_id}/analyze")
async def analyze_segment_endpoint(
    video_id: str, segment_id: str, req: VlmAnalyzeRequest
):
    """Kick off VLM analysis in a background thread.

    Returns immediately with status='started'. Poll
    GET /api/video/videos/{video_id}/segments/{segment_id}/analyze/status
    for progress.
    """
    if load_ingest_result(video_id) is None:
        raise HTTPException(404, f"No ingest output for {video_id}")

    job_key = f"{video_id}/{segment_id}"
    existing = _get_vlm_job(job_key)
    if existing and existing.get("status") == "running":
        raise HTTPException(409, f"VLM analysis already running for {segment_id}")

    _set_vlm_job(
        job_key,
        status="running",
        video_id=video_id,
        segment_id=segment_id,
        error=None,
        started_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
    )

    def worker() -> None:
        try:
            vlm_analyze_segment(
                video_id,
                segment_id,
                prompt=req.prompt,
                model=req.model,
            )
            _set_vlm_job(
                job_key,
                status="completed",
                finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
            )
        except Exception as e:
            _set_vlm_job(
                job_key,
                status="failed",
                error=str(e),
                finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
            )

    threading.Thread(target=worker, daemon=True).start()
    return {"video_id": video_id, "segment_id": segment_id, "status": "started"}


@router.get("/videos/{video_id}/segments/{segment_id}/analyze/status")
async def get_vlm_status(video_id: str, segment_id: str):
    """Poll VLM analysis status."""
    job_key = f"{video_id}/{segment_id}"
    job = _get_vlm_job(job_key)
    if job is not None:
        return job
    # Check if result exists on disk
    result = load_ingest_result(video_id)
    if result is None:
        raise HTTPException(404, f"No ingest output for {video_id}")
    segments = result.get("segments", [])
    seg = next((s for s in segments if s["segment_id"] == segment_id), None)
    if seg and seg.get("vlm_analysis"):
        return {"status": "completed", "video_id": video_id, "segment_id": segment_id}
    raise HTTPException(404, f"No VLM job or result for {segment_id}")


# ── Unified video list ─────────────────────────────────────────────────


@router.get("/video-list")
async def get_video_list():
    """Merged list: all source videos cross-referenced with ingested runs.

    Each entry carries enough info for the frontend to decide which
    action to offer (Ingest / Transcribe / View).
    """
    source_videos = list_source_videos()
    ingested = list_ingested_videos()
    notes = load_notes()

    ingested_map: dict[str, dict] = {v["video_id"]: v for v in ingested}

    # Build a set of video_ids already matched from source files
    matched_ids: set[str] = set()
    out: list[dict] = []

    for sv in source_videos:
        stem = Path(sv["name"]).stem
        vid = derive_video_id(Path(stem))
        matched_ids.add(vid)
        ing = ingested_map.get(vid)
        entry: dict = {
            "name": sv["name"],
            "relative_path": sv["relative_path"],
            "size_bytes": sv["size_bytes"],
            "duration": None,
            "video_id": vid,
            "has_scenes": False,
            "scene_count": None,
            "has_transcript": False,
            "transcript_segment_count": None,
            "note": notes.get(vid, ""),
        }
        if ing:
            entry["has_scenes"] = ing.get("status") == "completed" or (
                ing.get("scene_count") is not None
                and ing["scene_count"] > 0
            )
            entry["scene_count"] = ing.get("scene_count")
            entry["has_transcript"] = ing.get("has_transcript", False)
            entry["transcript_segment_count"] = ing.get(
                "transcript_segment_count"
            )
            entry["duration"] = ing.get("duration")
        out.append(entry)

    # Orphans: ingested videos whose source file no longer exists
    for vid, ing in ingested_map.items():
        if vid not in matched_ids:
            out.append(
                {
                    "name": None,
                    "relative_path": ing.get("source_path"),
                    "size_bytes": None,
                    "video_id": vid,
                    "has_scenes": ing.get("status") == "completed"
                    or (
                        ing.get("scene_count") is not None
                        and ing["scene_count"] > 0
                    ),
                    "scene_count": ing.get("scene_count"),
                    "has_transcript": ing.get("has_transcript", False),
                    "transcript_segment_count": ing.get(
                        "transcript_segment_count"
                    ),
                    "duration": ing.get("duration"),
                    "note": notes.get(vid, ""),
                }
            )

    return out


class VideoNoteRequest(BaseModel):
    note: str = ""


@router.patch("/videos/{video_id}/note")
async def update_video_note(video_id: str, req: VideoNoteRequest):
    """Save or clear a reviewer note for a video. Works for any video_id,
    whether or not it has been ingested yet."""
    saved = set_note(video_id, req.note)
    return {"video_id": video_id, "note": saved}


@router.get("/videos/{video_id}/note")
async def get_video_note(video_id: str):
    return {"video_id": video_id, "note": get_note(video_id)}


# ── Combined ingest pipeline ──────────────────────────────────────────

pipeline_jobs: dict[str, dict[str, Any]] = {}
_pipeline_lock = threading.Lock()


def _set_pipeline_job(video_id: str, **fields: Any) -> None:
    with _pipeline_lock:
        job = pipeline_jobs.setdefault(video_id, {})
        job.update(fields)


def _get_pipeline_job(video_id: str) -> dict[str, Any] | None:
    with _pipeline_lock:
        job = pipeline_jobs.get(video_id)
        return dict(job) if job else None


class PipelineRequest(BaseModel):
    source_path: str
    video_id: str | None = None
    threshold: float = 27.0
    run_scenes: bool = True
    run_transcribe: bool = True


@router.post("/ingest-pipeline")
async def ingest_pipeline(req: PipelineRequest):
    """Combined ingest: scene detection + transcription in one job.

    Runs the selected steps sequentially in a background thread.
    Poll GET /api/video/ingest-pipeline/{video_id}/status for progress.
    """
    try:
        src = resolve_source_path(req.source_path)
    except Exception as e:
        raise HTTPException(400, f"Invalid path: {e}")
    if not src.exists():
        raise HTTPException(404, f"Video not found: {src}")

    vid = derive_video_id(src, req.video_id)

    existing = _get_pipeline_job(vid)
    if existing and existing.get("status") == "running":
        raise HTTPException(409, f"Pipeline already running for {vid}")

    _set_pipeline_job(
        vid,
        status="running",
        phase="queued",
        run_scenes=req.run_scenes,
        run_transcribe=req.run_transcribe,
        scenes_done=0,
        scenes_total=0,
        duration=None,
        scene_count=None,
        error=None,
        started_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
    )

    def progress_callback(payload: dict) -> None:
        _set_pipeline_job(vid, **payload)

    def worker() -> None:
        try:
            if req.run_scenes:
                result = run_ingest(
                    source_path=src,
                    video_id=vid,
                    threshold=req.threshold,
                    progress_callback=progress_callback,
                )
                _set_pipeline_job(
                    vid,
                    scene_count=result["scene_count"],
                    duration=result["duration"],
                )
            else:
                # Scenes already exist — load metadata for duration
                existing_result = load_ingest_result(vid)
                if existing_result:
                    _set_pipeline_job(
                        vid,
                        scene_count=existing_result.get("scene_count"),
                        duration=existing_result.get("duration"),
                    )

            if req.run_transcribe:
                _set_pipeline_job(vid, phase="transcribing")
                t_result = run_transcribe(
                    video_id=vid,
                    progress_callback=progress_callback,
                )
                _set_pipeline_job(
                    vid,
                    phase="cleanup",
                    transcript_segments=len(
                        t_result.get("segments", [])
                    ),
                )

            _set_pipeline_job(
                vid,
                status="completed",
                phase="completed",
                finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
            )
        except Exception as e:
            _set_pipeline_job(
                vid,
                status="failed",
                phase="failed",
                error=str(e),
                finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
            )

    threading.Thread(target=worker, daemon=True).start()
    return {"video_id": vid, "status": "started"}


@router.get("/ingest-pipeline/{video_id}/status")
async def get_pipeline_status(video_id: str):
    """Poll combined ingest pipeline progress."""
    job = _get_pipeline_job(video_id)
    if job is not None:
        return job
    # Fall back: check if this video is fully done on disk
    result = load_ingest_result(video_id)
    transcript = load_transcript(video_id)
    if result is None and transcript is None:
        raise HTTPException(404, f"No pipeline job or output for {video_id}")
    return {
        "status": "completed",
        "phase": "completed",
        "scene_count": result.get("scene_count") if result else None,
        "duration": result.get("duration") if result else None,
    }

"""Stage 1: Ingest & Segment.

Real implementation:
    - Validate the input video path
    - Probe duration                            (ffprobe)
    - Detect scene boundaries                   (PySceneDetect ContentDetector)
    - Pick keyframes per scene at start/mid/end (ffmpeg)
    - Write per-video outputs under data/runs/video/<video_id>/
"""

from __future__ import annotations

import json
import shutil
import subprocess
import time
from pathlib import Path
from typing import Callable, TypedDict

from scenedetect import ContentDetector, SceneManager, open_video

from pipeline.video.audio import audio_path_for, extract_audio

BASE_DIR = Path(__file__).resolve().parent.parent.parent
VIDEO_RUNS_DIR = BASE_DIR / "data" / "runs" / "video"
SOURCE_VIDEOS_DIR = BASE_DIR / "public" / "data" / "source" / "videos"
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm"}

# Scenes shorter than this only get a midpoint keyframe (not start/mid/end)
MIN_SCENE_FOR_THREE_FRAMES = 3.0
# How far inside the scene boundary to grab the start/end frames
EDGE_OFFSET = 0.25


class Keyframe(TypedDict):
    index: int
    timestamp: float
    path: str
    role: str


class Scene(TypedDict, total=False):
    scene_id: str
    start: float
    end: float
    duration: float
    keyframes: list[Keyframe]
    tags: list[str]


class IngestResult(TypedDict):
    video_id: str
    source_path: str
    source_public_path: str | None
    duration: float
    scene_count: int
    scenes: list[Scene]
    status: str
    created_at: str
    detector: dict


# ── Merge groups ─────────────────────────────────────────────────────────
#
# Users can consolidate adjacent scenes into a single "merged" scene from
# the Ingest UI. We persist these as a sidecar (`merges.json`) rather than
# rewriting `scenes.json`, so the raw PySceneDetect output stays
# reproducible.
#
# Two-phase workflow:
#   1. Creating a merge produces a *pending* group — freely reversible
#      per-item via DELETE /merges/{group_id}.
#   2. "Apply all merges" flips every pending group to *committed*.
#      Committed groups are frozen: cannot be unmerged, cannot be
#      absorbed into new merges. The only way to clear them is to re-run
#      Stage 1, which deletes the sidecar entirely.
#
# Sidecar shape (version 2):
#     {
#       "version": 2,
#       "next_group_index": 4,
#       "groups": [
#         { "group_id": "<vid>_group_001",
#           "scene_ids": ["<vid>_scene_003", "<vid>_scene_004", ...],
#           "status": "pending" | "committed",
#           "created_at": "2026-04-11T...",
#           "committed_at": "2026-04-11T..." }
#       ]
#     }
#
# `scene_ids` always references *raw* scene IDs (the ones in scenes.json),
# never other group IDs. When the user merges an existing pending group
# with an adjacent scene, we expand the group, delete it, and create a
# new larger pending group. This keeps the data model flat.
#
# Backward-compat: version 1 sidecars (no `status` field) are loaded with
# status defaulting to "committed" so we don't silently un-freeze groups
# that were created under the old "irreversible by default" rule.


class MergeGroup(TypedDict, total=False):
    group_id: str
    scene_ids: list[str]
    status: str  # "pending" | "committed"
    created_at: str
    committed_at: str


class MergesSidecar(TypedDict):
    version: int
    next_group_index: int
    groups: list[MergeGroup]


def merges_path_for(video_id: str) -> Path:
    return VIDEO_RUNS_DIR / video_id / "merges.json"


def load_merges(video_id: str) -> MergesSidecar:
    p = merges_path_for(video_id)
    if not p.exists():
        return {"version": 2, "next_group_index": 1, "groups": []}
    with open(p) as f:
        data = json.load(f)
    # Defensive defaults for older sidecars
    data.setdefault("version", 1)
    data.setdefault("next_group_index", len(data.get("groups", [])) + 1)
    data.setdefault("groups", [])
    # Migration v1 → v2: groups without a status field were created under
    # the old "irreversible by default" rule, so treat them as committed
    # to avoid silently un-freezing them.
    for g in data["groups"]:
        g.setdefault("status", "committed")
    data["version"] = 2
    return data


def save_merges(video_id: str, merges: MergesSidecar) -> None:
    p = merges_path_for(video_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w") as f:
        json.dump(merges, f, indent=2)


def apply_merges(scenes: list[Scene], merges: MergesSidecar) -> list[Scene]:
    """Fold merge groups into a scene list.

    Each group collapses to a single scene whose start/end span the member
    scenes, with the union of all member keyframes (sorted by timestamp).
    Non-member scenes pass through unchanged. Order is preserved by the
    position of each group's first member in the raw list.
    """
    if not merges.get("groups"):
        return scenes

    # Map raw scene_id → group it belongs to (if any)
    member_to_group: dict[str, MergeGroup] = {}
    for g in merges["groups"]:
        for sid in g["scene_ids"]:
            member_to_group[sid] = g

    out: list[Scene] = []
    seen_groups: set[str] = set()
    scene_by_id = {s["scene_id"]: s for s in scenes}

    for s in scenes:
        g = member_to_group.get(s["scene_id"])
        if g is None:
            out.append(s)
            continue
        if g["group_id"] in seen_groups:
            continue
        seen_groups.add(g["group_id"])

        members = [scene_by_id[sid] for sid in g["scene_ids"] if sid in scene_by_id]
        if not members:
            continue

        start = min(m["start"] for m in members)
        end = max(m["end"] for m in members)
        keyframes: list[Keyframe] = []
        for m in members:
            keyframes.extend(m["keyframes"])
        keyframes.sort(key=lambda k: k["timestamp"])

        merged: Scene = {
            "scene_id": g["group_id"],
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(end - start, 3),
            "keyframes": keyframes,
        }
        # Extra fields for the frontend — TypedDict tolerates these at
        # runtime, and they're written straight to JSON.
        merged["merged_from"] = list(g["scene_ids"])  # type: ignore[typeddict-unknown-key]
        merged["merge_status"] = g.get("status", "committed")  # type: ignore[typeddict-unknown-key]
        out.append(merged)

    return out


def merge_scenes(video_id: str, scene_ids: list[str]) -> MergesSidecar:
    """Create (or expand) a merge group from the given scene IDs.

    Accepts a mix of raw scene IDs and existing group IDs. Validates that
    the resulting set of raw scene IDs forms a contiguous run in the raw
    scene list. Any pre-existing groups touched by this operation are
    absorbed into the new group.
    """
    raw = load_ingest_result(video_id)
    if raw is None:
        raise ValueError(f"No ingest output for {video_id}")
    raw_scenes: list[Scene] = raw["scenes"]
    raw_index = {s["scene_id"]: i for i, s in enumerate(raw_scenes)}

    merges = load_merges(video_id)
    group_by_id = {g["group_id"]: g for g in merges["groups"]}

    # Expand any group IDs to their member raw scene IDs, and remember
    # which existing groups will be absorbed by this merge. Committed
    # groups are frozen — refuse to absorb them so the commit guarantee
    # holds.
    expanded: list[str] = []
    absorbed_group_ids: set[str] = set()
    for sid in scene_ids:
        if sid in group_by_id:
            g = group_by_id[sid]
            if g.get("status") == "committed":
                raise ValueError(
                    f"Cannot merge into committed group {sid}. "
                    "Re-run scene detection to reset."
                )
            absorbed_group_ids.add(sid)
            expanded.extend(g["scene_ids"])
        elif sid in raw_index:
            expanded.append(sid)
        else:
            raise ValueError(f"Unknown scene_id: {sid}")

    # Deduplicate while preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for sid in expanded:
        if sid not in seen:
            seen.add(sid)
            unique.append(sid)

    if len(unique) < 2:
        raise ValueError("Merge requires at least 2 distinct scenes")

    # Sort by raw index and verify contiguity
    sorted_ids = sorted(unique, key=lambda s: raw_index[s])
    indices = [raw_index[s] for s in sorted_ids]
    expected = list(range(indices[0], indices[0] + len(indices)))
    if indices != expected:
        raise ValueError("Selected scenes are not contiguous")

    # Build the new group, dropping any absorbed ones. New groups always
    # start pending — the user has to explicitly Apply all to commit.
    # Name the merged scene after the first (smallest index) constituent
    # scene, so merging _007 + _008 + _009 produces _007 rather than a
    # synthetic group_NNN identifier.
    new_group: MergeGroup = {
        "group_id": sorted_ids[0],
        "scene_ids": sorted_ids,
        "status": "pending",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    merges["groups"] = [
        g for g in merges["groups"] if g["group_id"] not in absorbed_group_ids
    ]
    merges["groups"].append(new_group)

    save_merges(video_id, merges)
    return merges


def unmerge_group(video_id: str, group_id: str) -> MergesSidecar:
    """Remove a pending merge group. Committed groups cannot be unmerged."""
    merges = load_merges(video_id)
    target = next(
        (g for g in merges["groups"] if g["group_id"] == group_id), None
    )
    if target is None:
        raise ValueError(f"Unknown group_id: {group_id}")
    if target.get("status") != "pending":
        raise ValueError(
            f"Group {group_id} is committed and cannot be unmerged. "
            "Re-run scene detection to reset."
        )
    merges["groups"] = [
        g for g in merges["groups"] if g["group_id"] != group_id
    ]
    save_merges(video_id, merges)
    return merges


def delete_keyframe(video_id: str, scene_id: str, keyframe_path: str) -> None:
    """Remove a keyframe from a scene in scenes.json.

    Identifies the keyframe by its path field. Refuses to delete the last
    remaining keyframe in a scene.
    """
    result = load_ingest_result(video_id)
    if result is None:
        raise ValueError(f"No ingest output for {video_id}")

    scene = next((s for s in result["scenes"] if s["scene_id"] == scene_id), None)
    if scene is None:
        raise ValueError(f"Unknown scene_id: {scene_id}")

    before = len(scene["keyframes"])
    scene["keyframes"] = [kf for kf in scene["keyframes"] if kf["path"] != keyframe_path]
    if len(scene["keyframes"]) == before:
        raise ValueError(f"Keyframe not found: {keyframe_path}")
    if len(scene["keyframes"]) == 0:
        raise ValueError("Cannot delete the last keyframe in a scene")

    run_dir = VIDEO_RUNS_DIR / video_id
    with open(run_dir / "scenes.json", "w") as f:
        json.dump(result, f, indent=2)

    # Delete the actual image file from disk
    img_file = run_dir / keyframe_path
    if img_file.exists():
        img_file.unlink()


def rename_scene(video_id: str, old_id: str, new_id: str) -> None:
    """Rename a scene in scenes.json and any matching merge group in merges.json.

    Works for both raw scenes and baked merged scenes. If the scene is
    referenced inside a merge group (as group_id or in scene_ids), those
    references are updated too.
    """
    result = load_ingest_result(video_id)
    if result is None:
        raise ValueError(f"No ingest output for {video_id}")

    # Check new_id doesn't collide with an existing scene
    existing_ids = {s["scene_id"] for s in result["scenes"]}
    if new_id in existing_ids and new_id != old_id:
        raise ValueError(f"Scene ID '{new_id}' already exists")

    # Rename in scenes.json
    found = False
    for s in result["scenes"]:
        if s["scene_id"] == old_id:
            s["scene_id"] = new_id
            found = True
        # Also update merged_from references
        mf = s.get("merged_from")
        if mf:
            s["merged_from"] = [new_id if sid == old_id else sid for sid in mf]  # type: ignore[typeddict-unknown-key]

    if not found:
        raise ValueError(f"Unknown scene_id: {old_id}")

    run_dir = VIDEO_RUNS_DIR / video_id
    with open(run_dir / "scenes.json", "w") as f:
        json.dump(result, f, indent=2)

    # Rename in merges.json sidecar (group_id and scene_ids references)
    merges = load_merges(video_id)
    changed = False
    for g in merges["groups"]:
        if g["group_id"] == old_id:
            g["group_id"] = new_id
            changed = True
        if old_id in g["scene_ids"]:
            g["scene_ids"] = [new_id if sid == old_id else sid for sid in g["scene_ids"]]
            changed = True
    if changed:
        save_merges(video_id, merges)


def apply_all_merges(video_id: str) -> IngestResult:
    """Bake all merge groups into scenes.json and clear the sidecar.

    This is the irreversible commit step:
      1. Fold every merge group (pending AND committed) into the scene
         list, then overwrite scenes.json with the result.
      2. Clear the groups list in merges.json.

    scenes.raw.json (written at ingest time) is never touched — it
    always holds the pristine PySceneDetect output for diffing and
    audit. After this call, scenes.json IS the merged view. Downstream
    stages can read it directly. The only way to undo is to re-run
    Stage 1, which regenerates both scenes.json and scenes.raw.json.
    """
    result = load_ingest_result(video_id)
    if result is None:
        raise ValueError(f"No ingest output for {video_id}")

    merges = load_merges(video_id)
    if not merges["groups"]:
        return result  # nothing to bake

    run_dir = VIDEO_RUNS_DIR / video_id
    scenes_file = run_dir / "scenes.json"

    # Apply all merges and strip merge metadata — once baked, merged
    # scenes are indistinguishable from raw scenes in scenes.json.
    merged_scenes = apply_merges(result["scenes"], merges)
    for s in merged_scenes:
        s.pop("merge_status", None)  # type: ignore[misc]
        s.pop("merged_from", None)  # type: ignore[misc]

    result["scenes"] = merged_scenes
    result["scene_count"] = len(merged_scenes)

    with open(scenes_file, "w") as f:
        json.dump(result, f, indent=2)

    # Clear the sidecar — the groups are now baked into scenes.json.
    merges["groups"] = []
    save_merges(video_id, merges)

    return result


ProgressCallback = Callable[[dict], None]


def _slugify(name: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in name).strip("_")


def derive_video_id(source_path: Path, override: str | None = None) -> str:
    if override:
        return _slugify(override)
    return _slugify(source_path.stem)


def resolve_source_path(source_path: str | Path) -> Path:
    """Resolve a user-supplied path. Relative paths are anchored to the
    project root so the frontend can pass repo-relative paths regardless
    of where the server was launched from."""
    p = Path(source_path).expanduser()
    if not p.is_absolute():
        p = (BASE_DIR / p).resolve()
    else:
        p = p.resolve()
    return p


def public_relative_path(src: Path) -> str | None:
    """If src lives under public/, return its path relative to public/
    (e.g. 'data/source/videos/foo.mp4'). Otherwise None.

    Anything under public/ is served directly by the Vite dev server, so
    the frontend can use this as the URL for an HTML5 <video> element
    without needing a backend streaming route.
    """
    public_root = (BASE_DIR / "public").resolve()
    try:
        return str(src.relative_to(public_root))
    except ValueError:
        return None


# ── Reviewer notes ────────────────────────────────────────────────────
# Notes live in a single JSON file keyed by video_id so we can attach a
# note to any video — whether or not it has been ingested yet. Using a
# single file (instead of per-video sidecars) avoids creating stub run
# dirs for videos that haven't been processed.
NOTES_FILE = VIDEO_RUNS_DIR / "_notes.json"


def load_notes() -> dict[str, str]:
    if not NOTES_FILE.exists():
        return {}
    try:
        with open(NOTES_FILE) as f:
            data = json.load(f)
        if isinstance(data, dict):
            return {k: str(v) for k, v in data.items() if v}
    except Exception:
        return {}
    return {}


def get_note(video_id: str) -> str:
    return load_notes().get(video_id, "")


def set_note(video_id: str, note: str) -> str:
    notes = load_notes()
    note = (note or "").strip()
    if note:
        notes[video_id] = note
    else:
        notes.pop(video_id, None)
    NOTES_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(NOTES_FILE, "w") as f:
        json.dump(notes, f, indent=2)
    return note


def list_source_videos() -> list[dict]:
    """List videos available under public/data/source/videos/."""
    if not SOURCE_VIDEOS_DIR.exists():
        return []
    out: list[dict] = []
    for f in sorted(SOURCE_VIDEOS_DIR.iterdir()):
        if f.is_file() and f.suffix.lower() in VIDEO_EXTS:
            out.append(
                {
                    "name": f.name,
                    "relative_path": str(f.relative_to(BASE_DIR)),
                    "size_bytes": f.stat().st_size,
                }
            )
    return out


def probe_duration(video_path: Path) -> float:
    """Use ffprobe to get the video duration in seconds."""
    if shutil.which("ffprobe") is None:
        raise RuntimeError("ffprobe not found on PATH. Install ffmpeg.")
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(result.stdout.strip())


def detect_scene_boundaries(
    video_path: Path, threshold: float = 27.0
) -> list[tuple[float, float]]:
    """Run PySceneDetect ContentDetector on the video and return
    list of (start_seconds, end_seconds) tuples."""
    video = open_video(str(video_path))
    scene_manager = SceneManager()
    scene_manager.add_detector(ContentDetector(threshold=threshold))
    scene_manager.detect_scenes(video=video, show_progress=False)
    scene_list = scene_manager.get_scene_list()
    return [(s.get_seconds(), e.get_seconds()) for s, e in scene_list]


def extract_keyframe(
    video_path: Path, timestamp: float, out_path: Path
) -> bool:
    """Extract a single JPEG frame at the given timestamp using ffmpeg.

    Uses fast seek (`-ss` before `-i`) which is good enough for keyframes
    chosen at scene midpoints. Returns True on success.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-ss",
            f"{max(0.0, timestamp):.3f}",
            "-i",
            str(video_path),
            "-frames:v",
            "1",
            "-q:v",
            "3",
            str(out_path),
        ],
        capture_output=True,
    )
    return proc.returncode == 0 and out_path.exists()


def _keyframe_timestamps(start: float, end: float) -> list[tuple[str, float]]:
    """Return [(role, timestamp), ...] inside [start, end].

    For scenes >= 3s, returns start/mid/end (with EDGE_OFFSET inset from
    boundaries to avoid black frames at cuts). For shorter scenes, just mid.
    """
    duration = end - start
    if duration <= 0:
        return [("mid", start)]
    if duration < MIN_SCENE_FOR_THREE_FRAMES:
        return [("mid", start + duration / 2)]
    return [
        ("start", start + EDGE_OFFSET),
        ("mid", start + duration / 2),
        ("end", end - EDGE_OFFSET),
    ]


def _emit(progress_callback: ProgressCallback | None, payload: dict) -> None:
    if progress_callback is not None:
        try:
            progress_callback(payload)
        except Exception:
            # Never let a broken callback take down the ingest job
            pass


def run_ingest(
    source_path: str | Path,
    video_id: str | None = None,
    threshold: float = 27.0,
    progress_callback: ProgressCallback | None = None,
) -> IngestResult:
    """Real Stage 1: probe → detect scenes → extract keyframes → write outputs.

    Synchronous and blocking. The router wraps this in a thread for the HTTP
    layer; callers running it directly (CLI, tests) get a plain return value.
    """
    src = resolve_source_path(source_path)
    if not src.exists():
        raise FileNotFoundError(f"Video not found: {src}")

    vid = derive_video_id(src, video_id)
    out_dir = VIDEO_RUNS_DIR / vid
    keyframes_dir = out_dir / "keyframes"
    out_dir.mkdir(parents=True, exist_ok=True)
    keyframes_dir.mkdir(exist_ok=True)

    # Re-running scene detection regenerates raw scene IDs from scratch,
    # so any existing merge groups become meaningless. Clearing the
    # sidecar is the only escape hatch from the "merges are irreversible"
    # UI rule. scenes.raw.json is regenerated below alongside scenes.json.
    merges_file = merges_path_for(vid)
    if merges_file.exists():
        merges_file.unlink()

    created_at = time.strftime("%Y-%m-%dT%H:%M:%S")

    # ── Stage 1a: probe duration ────────────────────────────────────────
    _emit(progress_callback, {"phase": "probing"})
    duration = probe_duration(src)

    # ── Stage 1a.5: extract audio track ─────────────────────────────────
    # Soft-fail: if the video has no audio stream or ffmpeg chokes, we
    # still want scenes + keyframes. Stage 2 (transcribe) will surface the
    # same error loudly if someone actually tries to transcribe this run.
    _emit(progress_callback, {"phase": "extracting_audio"})
    try:
        extract_audio(src, audio_path_for(out_dir))
    except RuntimeError as e:
        _emit(
            progress_callback,
            {"phase": "extracting_audio", "audio_error": str(e)},
        )

    # ── Stage 1b: detect scene boundaries ───────────────────────────────
    _emit(
        progress_callback,
        {"phase": "detecting", "duration": duration},
    )
    boundaries = detect_scene_boundaries(src, threshold=threshold)

    # If PySceneDetect returns nothing (single uncut shot), treat the whole
    # clip as one scene so downstream stages still have something to chew on.
    if not boundaries:
        boundaries = [(0.0, duration)]

    # ── Stage 1c: extract keyframes for each scene ──────────────────────
    scenes: list[Scene] = []
    total = len(boundaries)
    _emit(
        progress_callback,
        {"phase": "extracting", "scenes_done": 0, "scenes_total": total},
    )

    for i, (start, end) in enumerate(boundaries, start=1):
        scene_id = f"{vid}_scene_{i:03d}"
        scene_keyframes: list[Keyframe] = []
        for k_idx, (role, ts) in enumerate(_keyframe_timestamps(start, end)):
            fname = f"scene_{i:03d}_{role}.jpg"
            out_path = keyframes_dir / fname
            ok = extract_keyframe(src, ts, out_path)
            if ok:
                scene_keyframes.append(
                    {
                        "index": k_idx,
                        "timestamp": round(ts, 3),
                        "path": f"keyframes/{fname}",
                        "role": role,
                    }
                )

        scenes.append(
            {
                "scene_id": scene_id,
                "start": round(start, 3),
                "end": round(end, 3),
                "duration": round(end - start, 3),
                "keyframes": scene_keyframes,
                "tags": [],
            }
        )

        _emit(
            progress_callback,
            {
                "phase": "extracting",
                "scenes_done": i,
                "scenes_total": total,
            },
        )

    result: IngestResult = {
        "video_id": vid,
        "source_path": str(src),
        "source_public_path": public_relative_path(src),
        "duration": round(duration, 3),
        "scene_count": len(scenes),
        "scenes": scenes,
        "status": "completed",
        "created_at": created_at,
        "detector": {"name": "ContentDetector", "threshold": threshold},
    }

    with open(out_dir / "scenes.json", "w") as f:
        json.dump(result, f, indent=2)

    # Write an identical copy as scenes.raw.json — the pristine detector
    # output. scenes.json gets rewritten when the user applies merges;
    # scenes.raw.json never changes until the next ingest run.
    with open(out_dir / "scenes.raw.json", "w") as f:
        json.dump(result, f, indent=2)

    with open(out_dir / "metadata.json", "w") as f:
        json.dump(
            {
                "video_id": vid,
                "source_path": str(src),
                "status": result["status"],
                "created_at": created_at,
                "scene_count": result["scene_count"],
                "duration": result["duration"],
                "detector": result["detector"],
            },
            f,
            indent=2,
        )

    _emit(progress_callback, {"phase": "completed", "scene_count": len(scenes)})

    return result


def load_ingest_result(video_id: str) -> IngestResult | None:
    scenes_file = VIDEO_RUNS_DIR / video_id / "scenes.json"
    if not scenes_file.exists():
        return None
    with open(scenes_file) as f:
        result = json.load(f)
    # Backfill: runs created before scenes.raw.json was introduced
    # won't have it. Snapshot the current scenes.json as a best-effort
    # baseline so that future applies have something to diff against.
    raw_file = VIDEO_RUNS_DIR / video_id / "scenes.raw.json"
    if not raw_file.exists():
        import shutil as _shutil
        _shutil.copy2(scenes_file, raw_file)
    # Backfill source_public_path for runs created before this field existed
    if result.get("source_public_path") is None and result.get("source_path"):
        try:
            result["source_public_path"] = public_relative_path(
                Path(result["source_path"])
            )
        except Exception:
            result["source_public_path"] = None
    return result


def list_ingested_videos() -> list[dict]:
    if not VIDEO_RUNS_DIR.exists():
        return []
    out: list[dict] = []
    for d in sorted(VIDEO_RUNS_DIR.iterdir(), reverse=True):
        if not d.is_dir():
            continue
        meta_file = d / "metadata.json"
        if meta_file.exists():
            with open(meta_file) as f:
                entry = json.load(f)
        else:
            entry = {"video_id": d.name, "status": "unknown"}
        # Enrich with transcript status
        transcript_file = d / "transcript.json"
        if transcript_file.exists():
            entry["has_transcript"] = True
            try:
                with open(transcript_file) as f:
                    t = json.load(f)
                entry["transcript_segment_count"] = len(t.get("segments", []))
            except Exception:
                entry["transcript_segment_count"] = None
        else:
            entry["has_transcript"] = False
            entry["transcript_segment_count"] = None
        out.append(entry)
    return out

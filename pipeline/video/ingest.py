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


class Scene(TypedDict):
    scene_id: str
    start: float
    end: float
    duration: float
    keyframes: list[Keyframe]


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
                out.append(json.load(f))
        else:
            out.append({"video_id": d.name, "status": "unknown"})
    return out

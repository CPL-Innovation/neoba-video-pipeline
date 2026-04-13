"""Segment detection via black-slug analysis.

Segments are narrative units made of scenes. Black slugs — scenes whose
keyframes are nearly all-black — serve as segment boundaries. This module
analyzes the already-extracted keyframe JPEGs (no video re-scan needed)
to detect slugs and group scenes into segments.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TypedDict

import cv2
import numpy as np

from pipeline.video.ingest import (
    VIDEO_RUNS_DIR,
    IngestResult,
    load_ingest_result,
    load_merges,
    apply_merges,
)

DEFAULT_LUMINANCE_THRESHOLD = 10  # out of 255
DEFAULT_MIN_DURATION = 0.5  # seconds


class Segment(TypedDict):
    segment_id: str
    type: str  # "content" | "boundary"
    name: str
    scene_ids: list[str]
    start: float
    end: float


def _keyframe_is_black(
    image_path: Path, luminance_threshold: float
) -> bool:
    """Return True if the average luminance of the image is below threshold."""
    img = cv2.imread(str(image_path))
    if img is None:
        # Can't read the file — treat as non-black (don't falsely flag)
        return False
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return float(np.mean(gray)) < luminance_threshold


def detect_black_slugs(
    video_id: str,
    luminance_threshold: float = DEFAULT_LUMINANCE_THRESHOLD,
    min_duration: float = DEFAULT_MIN_DURATION,
) -> list[str]:
    """Return scene_ids of scenes that are black slugs.

    A scene is a black slug when:
      - Its duration >= min_duration
      - ALL of its keyframes have average luminance < luminance_threshold
    """
    result = load_ingest_result(video_id)
    if result is None:
        raise ValueError(f"No ingest output for {video_id}")

    # Work on the merged view so segment detection respects user merges
    merges = load_merges(video_id)
    scenes = apply_merges(result["scenes"], merges)

    run_dir = VIDEO_RUNS_DIR / video_id
    slug_ids: list[str] = []

    for scene in scenes:
        duration = scene.get("duration", scene["end"] - scene["start"])
        if duration < min_duration:
            continue

        keyframes = scene.get("keyframes", [])
        if not keyframes:
            continue

        all_black = all(
            _keyframe_is_black(run_dir / kf["path"], luminance_threshold)
            for kf in keyframes
        )
        if all_black:
            slug_ids.append(scene["scene_id"])

    return slug_ids


def build_segments(
    video_id: str,
    luminance_threshold: float = DEFAULT_LUMINANCE_THRESHOLD,
    min_duration: float = DEFAULT_MIN_DURATION,
) -> IngestResult:
    """Detect black slugs, tag scenes, and group them into segments.

    Writes the updated scenes.json with segments array, segment_detector
    metadata, and scene tags. Returns the updated result.
    """
    result = load_ingest_result(video_id)
    if result is None:
        raise ValueError(f"No ingest output for {video_id}")

    slug_ids = detect_black_slugs(video_id, luminance_threshold, min_duration)
    slug_set = set(slug_ids)

    # Work on the merged view
    merges = load_merges(video_id)
    scenes = apply_merges(result["scenes"], merges)

    # Tag scenes
    for scene in scenes:
        tags: list[str] = scene.get("tags", [])  # type: ignore[assignment]
        # Remove stale black_slug tags, then re-add if applicable
        tags = [t for t in tags if t != "black_slug"]
        if scene["scene_id"] in slug_set:
            tags.append("black_slug")
        scene["tags"] = tags  # type: ignore[typeddict-unknown-key]

    # Build segments by grouping consecutive scenes.
    # segment_index is a monotonic counter for unique IDs across all segments.
    # content_number counts only content segments for sequential naming.
    segments: list[Segment] = []
    segment_index = 0
    content_number = 0
    current_content_scenes: list[dict] = []

    def flush_content() -> None:
        nonlocal segment_index, content_number
        if not current_content_scenes:
            return
        segment_index += 1
        content_number += 1
        first = current_content_scenes[0]
        last = current_content_scenes[-1]
        segments.append({
            "segment_id": f"{video_id}_segment_{segment_index:03d}",
            "type": "content",
            "name": f"Segment {content_number}",
            "scene_ids": [s["scene_id"] for s in current_content_scenes],
            "start": round(first["start"], 3),
            "end": round(last["end"], 3),
        })

    for scene in scenes:
        if scene["scene_id"] in slug_set:
            # Flush any accumulated content scenes as a content segment
            flush_content()
            current_content_scenes = []
            # Create a boundary segment for this slug
            segment_index += 1
            segments.append({
                "segment_id": f"{video_id}_segment_{segment_index:03d}",
                "type": "boundary",
                "name": "Boundary",
                "scene_ids": [scene["scene_id"]],
                "start": round(scene["start"], 3),
                "end": round(scene["end"], 3),
            })
        else:
            current_content_scenes.append(scene)

    # Flush trailing content scenes
    flush_content()

    # Also tag scenes in the raw result (scenes.json stores raw scenes)
    raw_slug_set = slug_set
    for scene in result["scenes"]:
        tags = scene.get("tags", [])  # type: ignore[assignment]
        tags = [t for t in tags if t != "black_slug"]
        if scene["scene_id"] in raw_slug_set:
            tags.append("black_slug")
        scene["tags"] = tags  # type: ignore[typeddict-unknown-key]

    # Store segments and detector config
    result["segments"] = segments  # type: ignore[typeddict-unknown-key]
    result["segment_detector"] = {  # type: ignore[typeddict-unknown-key]
        "luminance_threshold": luminance_threshold,
        "min_duration": min_duration,
    }

    run_dir = VIDEO_RUNS_DIR / video_id
    with open(run_dir / "scenes.json", "w") as f:
        json.dump(result, f, indent=2)

    return result


def rename_segment(video_id: str, segment_id: str, new_name: str) -> IngestResult:
    """Rename a segment in scenes.json."""
    result = load_ingest_result(video_id)
    if result is None:
        raise ValueError(f"No ingest output for {video_id}")

    segments = result.get("segments", [])  # type: ignore[assignment]
    target = next((c for c in segments if c["segment_id"] == segment_id), None)
    if target is None:
        raise ValueError(f"Unknown segment_id: {segment_id}")

    target["name"] = new_name.strip()

    run_dir = VIDEO_RUNS_DIR / video_id
    with open(run_dir / "scenes.json", "w") as f:
        json.dump(result, f, indent=2)

    return result


def assign_item_to_segment(
    video_id: str, segment_id: str, item_id: str | None
) -> IngestResult:
    """Assign (or unassign) a catalog item_id to a segment in scenes.json."""
    result = load_ingest_result(video_id)
    if result is None:
        raise ValueError(f"No ingest output for {video_id}")

    segments = result.get("segments", [])  # type: ignore[assignment]
    target = next((c for c in segments if c["segment_id"] == segment_id), None)
    if target is None:
        raise ValueError(f"Unknown segment_id: {segment_id}")

    if item_id:
        target["item_id"] = item_id
    else:
        target.pop("item_id", None)

    run_dir = VIDEO_RUNS_DIR / video_id
    with open(run_dir / "scenes.json", "w") as f:
        json.dump(result, f, indent=2)

    return result


def clear_segments(video_id: str) -> IngestResult:
    """Remove segment grouping data from scenes.json. Scene tags are preserved."""
    result = load_ingest_result(video_id)
    if result is None:
        raise ValueError(f"No ingest output for {video_id}")

    # Remove segment fields only — keep scene tags intact
    result.pop("segments", None)  # type: ignore[misc]
    result.pop("segment_detector", None)  # type: ignore[misc]

    run_dir = VIDEO_RUNS_DIR / video_id
    with open(run_dir / "scenes.json", "w") as f:
        json.dump(result, f, indent=2)

    return result

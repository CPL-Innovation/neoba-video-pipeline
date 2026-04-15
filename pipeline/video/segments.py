"""Segment detection via black-slug analysis.

Segments are narrative units made of scenes. Black slugs — scenes whose
keyframes are nearly all-black — serve as segment boundaries. This module
analyzes the already-extracted keyframe JPEGs (no video re-scan needed)
to detect slugs and group scenes into segments.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import TypedDict

import cv2
import numpy as np

from pipeline.video.ingest import (
    VIDEO_RUNS_DIR,
    IngestResult,
    MergesSidecar,
    load_ingest_result,
    load_merges,
    save_merges,
    apply_merges,
)

DEFAULT_LUMINANCE_THRESHOLD = 30  # out of 255
DEFAULT_STD_THRESHOLD = 5.0  # max standard deviation for uniform black
DEFAULT_MIN_DURATION = 0.5  # seconds


class Segment(TypedDict):
    segment_id: str
    segment_index: int
    type: str  # "content" | "boundary"
    name: str
    scene_ids: list[str]
    start: float
    end: float


def _keyframe_is_black(
    image_path: Path,
    luminance_threshold: float,
    std_threshold: float = DEFAULT_STD_THRESHOLD,
) -> bool:
    """Return True if the keyframe looks like a black slug.

    Uses two criteria to handle different source encodings:
      1. Mean luminance < luminance_threshold (handles lifted-black tapes)
      2. Std deviation < std_threshold (distinguishes uniform black from
         dark-but-textured content like nighttime footage)
    """
    img = cv2.imread(str(image_path))
    if img is None:
        # Can't read the file — treat as non-black (don't falsely flag)
        return False
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    mean_lum = float(np.mean(gray))
    std_lum = float(np.std(gray))
    return mean_lum < luminance_threshold and std_lum < std_threshold


def detect_black_slugs(
    video_id: str,
    luminance_threshold: float = DEFAULT_LUMINANCE_THRESHOLD,
    min_duration: float = DEFAULT_MIN_DURATION,
    std_threshold: float = DEFAULT_STD_THRESHOLD,
) -> list[str]:
    """Return scene_ids of scenes that are black slugs.

    A scene is a black slug when:
      - Its duration >= min_duration
      - ALL of its keyframes have mean luminance < luminance_threshold
        AND standard deviation < std_threshold (to reject dark content)
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
            _keyframe_is_black(
                run_dir / kf["path"], luminance_threshold, std_threshold
            )
            for kf in keyframes
        )
        if all_black:
            slug_ids.append(scene["scene_id"])

    return slug_ids


def _auto_merge_adjacent_black_slugs(
    video_id: str,
    result: IngestResult,
    merges: MergesSidecar,
) -> None:
    """Merge runs of 2+ adjacent black_slug scenes into a single merged scene.

    Operates after `black_slug` tags are written to raw scenes. For each run,
    keeps only the earliest keyframe (by timestamp) across all member scenes;
    all other keyframe images are deleted from disk and removed from their
    scene entries. The merge group is recorded as *committed* in merges.json.

    Mutates `result["scenes"]` and `merges["groups"]` in place. Callers must
    persist both. No-op when no adjacent slug runs exist.
    """
    raw_by_id: dict[str, dict] = {s["scene_id"]: s for s in result["scenes"]}

    # Walk the merged view and find runs of 2+ consecutive slug scenes.
    # Convention: merged scenes carry the first member's scene_id, and tags
    # live on raw scenes — a merged scene is a "slug" when its owning first
    # raw scene has the black_slug tag.
    merged = apply_merges(result["scenes"], merges)

    def is_slug(ms: dict) -> bool:
        raw = raw_by_id.get(ms["scene_id"])
        return bool(raw and "black_slug" in (raw.get("tags") or []))

    runs: list[list[dict]] = []
    current: list[dict] = []
    for ms in merged:
        if is_slug(ms):
            current.append(ms)
        else:
            if len(current) >= 2:
                runs.append(current)
            current = []
    if len(current) >= 2:
        runs.append(current)

    if not runs:
        return

    run_dir = VIDEO_RUNS_DIR / video_id
    now = time.strftime("%Y-%m-%dT%H:%M:%S")

    for run in runs:
        # Expand each merged-view member back to raw scene IDs
        raw_ids: list[str] = []
        absorbed_group_ids: set[str] = set()
        for ms in run:
            mf = ms.get("merged_from")
            if mf:
                raw_ids.extend(mf)
                absorbed_group_ids.add(ms["scene_id"])
            else:
                raw_ids.append(ms["scene_id"])

        # Collect every keyframe across members with its owning raw scene,
        # pick the earliest by timestamp, delete the rest from disk.
        all_kfs: list[tuple[float, dict, str]] = []
        for rid in raw_ids:
            raw = raw_by_id.get(rid)
            if not raw:
                continue
            for kf in raw.get("keyframes", []):
                all_kfs.append((kf["timestamp"], kf, rid))

        if not all_kfs:
            continue

        all_kfs.sort(key=lambda t: t[0])
        kept_ts, kept_kf, kept_owner = all_kfs[0]

        for _ts, kf, _owner in all_kfs[1:]:
            img_file = run_dir / kf["path"]
            if img_file.exists():
                try:
                    img_file.unlink()
                except OSError:
                    pass

        # Rewrite keyframes on each raw member scene
        for rid in raw_ids:
            raw = raw_by_id.get(rid)
            if not raw:
                continue
            raw["keyframes"] = [kept_kf] if rid == kept_owner else []

        # Drop any existing groups we're absorbing, append the new committed group
        if absorbed_group_ids:
            merges["groups"] = [
                g for g in merges["groups"] if g["group_id"] not in absorbed_group_ids
            ]
        merges["groups"].append({
            "group_id": raw_ids[0],
            "scene_ids": raw_ids,
            "status": "committed",
            "created_at": now,
            "committed_at": now,
        })


def build_segments(
    video_id: str,
    luminance_threshold: float = DEFAULT_LUMINANCE_THRESHOLD,
    min_duration: float = DEFAULT_MIN_DURATION,
    std_threshold: float = DEFAULT_STD_THRESHOLD,
    auto_merge_black_slugs: bool = True,
) -> IngestResult:
    """Detect black slugs, tag scenes, and group them into segments.

    Writes the updated scenes.json with segments array, segment_detector
    metadata, and scene tags. Returns the updated result.
    """
    result = load_ingest_result(video_id)
    if result is None:
        raise ValueError(f"No ingest output for {video_id}")

    slug_ids = detect_black_slugs(
        video_id, luminance_threshold, min_duration, std_threshold
    )
    slug_set = set(slug_ids)

    # Tag raw scenes first (merged-view scene_ids == first raw scene_id of
    # each group, so the tag lands on the first member and propagates
    # correctly to any subsequent merged view).
    for scene in result["scenes"]:
        tags: list[str] = [
            t for t in (scene.get("tags") or []) if t != "black_slug"
        ]
        if scene["scene_id"] in slug_set:
            tags.append("black_slug")
        scene["tags"] = tags  # type: ignore[typeddict-unknown-key]

    merges = load_merges(video_id)

    if auto_merge_black_slugs:
        _auto_merge_adjacent_black_slugs(video_id, result, merges)
        save_merges(video_id, merges)

    # Rebuild the merged view after any auto-merge
    scenes = apply_merges(result["scenes"], merges)

    # Recompute slug_set against the (possibly new) merged view via tags on
    # the first raw member scene.
    raw_by_id = {s["scene_id"]: s for s in result["scenes"]}
    slug_set = {
        ms["scene_id"]
        for ms in scenes
        if "black_slug" in (raw_by_id.get(ms["scene_id"], {}).get("tags") or [])
    }

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
            "segment_index": segment_index,
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
                "segment_index": segment_index,
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

    # Store segments and detector config
    result["segments"] = segments  # type: ignore[typeddict-unknown-key]
    result["segment_detector"] = {  # type: ignore[typeddict-unknown-key]
        "luminance_threshold": luminance_threshold,
        "min_duration": min_duration,
        "auto_merged_black_slugs": bool(auto_merge_black_slugs),
    }

    run_dir = VIDEO_RUNS_DIR / video_id
    with open(run_dir / "scenes.json", "w") as f:
        json.dump(result, f, indent=2)

    return result


def build_segments_from_tags(
    video_id: str,
    auto_merge_black_slugs: bool = True,
) -> IngestResult:
    """Build segments using existing black_slug tags as dividers.

    Unlike build_segments() which runs luminance analysis, this simply
    reads the tags already on each scene and groups accordingly. Useful
    when tags have been manually curated.
    """
    result = load_ingest_result(video_id)
    if result is None:
        raise ValueError(f"No ingest output for {video_id}")

    merges = load_merges(video_id)

    if auto_merge_black_slugs:
        _auto_merge_adjacent_black_slugs(video_id, result, merges)
        save_merges(video_id, merges)

    scenes = apply_merges(result["scenes"], merges)

    # Resolve tags via the first raw member scene so merged groups inherit
    # their members' tags without apply_merges needing to copy them.
    raw_by_id = {s["scene_id"]: s for s in result["scenes"]}
    slug_set = {
        s["scene_id"]
        for s in scenes
        if "black_slug" in (raw_by_id.get(s["scene_id"], {}).get("tags") or [])
    }

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
            "segment_index": segment_index,
            "type": "content",
            "name": f"Segment {content_number}",
            "scene_ids": [s["scene_id"] for s in current_content_scenes],
            "start": round(first["start"], 3),
            "end": round(last["end"], 3),
        })

    for scene in scenes:
        if scene["scene_id"] in slug_set:
            flush_content()
            current_content_scenes = []
            segment_index += 1
            segments.append({
                "segment_id": f"{video_id}_segment_{segment_index:03d}",
                "segment_index": segment_index,
                "type": "boundary",
                "name": "Boundary",
                "scene_ids": [scene["scene_id"]],
                "start": round(scene["start"], 3),
                "end": round(scene["end"], 3),
            })
        else:
            current_content_scenes.append(scene)

    flush_content()

    result["segments"] = segments  # type: ignore[typeddict-unknown-key]
    result["segment_detector"] = {  # type: ignore[typeddict-unknown-key]
        "method": "from_tags",
        "auto_merged_black_slugs": bool(auto_merge_black_slugs),
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


def update_segment_description(
    video_id: str, segment_id: str, description: str
) -> IngestResult:
    """Update the description field of a segment in scenes.json."""
    result = load_ingest_result(video_id)
    if result is None:
        raise ValueError(f"No ingest output for {video_id}")

    segments = result.get("segments", [])  # type: ignore[assignment]
    target = next((c for c in segments if c["segment_id"] == segment_id), None)
    if target is None:
        raise ValueError(f"Unknown segment_id: {segment_id}")

    target["description"] = description

    run_dir = VIDEO_RUNS_DIR / video_id
    with open(run_dir / "scenes.json", "w") as f:
        json.dump(result, f, indent=2)

    return result


def create_segment(
    video_id: str,
    scene_ids: list[str],
    name: str,
    segment_type: str = "content",
) -> IngestResult:
    """Create a new segment from the given scene IDs.

    The new segment is inserted at the correct position (by start time)
    among existing segments.  segment_index values for all subsequent
    segments are shifted up to make room.  Scenes are extracted from
    whatever segment they currently belong to (the source segment is
    kept, possibly empty).  If extracting scenes from the middle of an
    existing content segment, the source is split into up to two
    remainder segments that keep the original name with "(1)" / "(2)"
    suffixes.
    """
    result = load_ingest_result(video_id)
    if result is None:
        raise ValueError(f"No ingest output for {video_id}")

    # Work on merged view to validate scene_ids
    merges = load_merges(video_id)
    scenes = apply_merges(result["scenes"], merges)
    scene_map = {s["scene_id"]: s for s in scenes}

    # Also build a map back to raw IDs for storage
    group_by_id = {g["group_id"]: g for g in merges["groups"]}
    raw_scene_ids: list[str] = []
    for sid in scene_ids:
        if sid in group_by_id:
            raw_scene_ids.extend(group_by_id[sid]["scene_ids"])
        elif sid in scene_map:
            raw_scene_ids.append(sid)
        else:
            raise ValueError(f"Unknown scene_id: {sid}")

    segments: list[Segment] = result.get("segments", [])  # type: ignore[assignment]

    # Remove extracted scenes from their current segments.
    # If we cut scenes from the middle of a segment, split it into two
    # remainder segments so scenes before and after the cut stay grouped.
    extract_set = set(raw_scene_ids)
    new_segments: list[Segment] = []
    for seg in segments:
        remaining = [sid for sid in seg["scene_ids"] if sid not in extract_set]
        if len(remaining) == len(seg["scene_ids"]):
            # Segment untouched
            new_segments.append(seg)
            continue

        if not remaining:
            # All scenes extracted → keep as empty segment
            seg["scene_ids"] = []
            new_segments.append(seg)
            continue

        # Check if the remaining scenes are contiguous in the original
        # segment order.  If not, we need to split into runs.
        original_order = seg["scene_ids"]
        remaining_set = set(remaining)
        runs: list[list[str]] = []
        current_run: list[str] = []
        for sid in original_order:
            if sid in remaining_set:
                current_run.append(sid)
            else:
                if current_run:
                    runs.append(current_run)
                    current_run = []
        if current_run:
            runs.append(current_run)

        if len(runs) == 1:
            # Contiguous remainder — just update the segment
            seg["scene_ids"] = runs[0]
            # Update start/end from raw scene data
            raw_scenes = result["scenes"]
            raw_map = {s["scene_id"]: s for s in raw_scenes}
            members = [raw_map[sid] for sid in runs[0] if sid in raw_map]
            if members:
                seg["start"] = round(min(s["start"] for s in members), 3)
                seg["end"] = round(max(s["end"] for s in members), 3)
            new_segments.append(seg)
        else:
            # Split into multiple remainder segments
            raw_scenes = result["scenes"]
            raw_map = {s["scene_id"]: s for s in raw_scenes}
            for ri, run in enumerate(runs):
                members = [raw_map[sid] for sid in run if sid in raw_map]
                suffix = f" ({ri + 1})" if len(runs) > 1 else ""
                split_seg: Segment = {
                    "segment_id": seg["segment_id"],  # will be reassigned below
                    "segment_index": seg["segment_index"],  # will be reassigned
                    "type": seg["type"],
                    "name": f"{seg['name']}{suffix}",
                    "scene_ids": run,
                    "start": round(min(s["start"] for s in members), 3) if members else seg["start"],
                    "end": round(max(s["end"] for s in members), 3) if members else seg["end"],
                }
                # Preserve optional fields from original
                if seg.get("description"):
                    split_seg["description"] = seg["description"]  # type: ignore[typeddict-unknown-key]
                if seg.get("item_id"):
                    split_seg["item_id"] = seg["item_id"]  # type: ignore[typeddict-unknown-key]
                new_segments.append(split_seg)

    segments = new_segments

    # Determine insertion position by start time of first scene
    member_scenes_merged = [scene_map[sid] for sid in scene_ids if sid in scene_map]
    if not member_scenes_merged:
        raise ValueError("No valid scenes provided")
    new_start = round(min(s["start"] for s in member_scenes_merged), 3)
    new_end = round(max(s["end"] for s in member_scenes_merged), 3)

    # Find the right insertion index (sorted by start time)
    insert_idx = 0
    for i, seg in enumerate(segments):
        if seg["start"] <= new_start:
            insert_idx = i + 1

    new_segment: Segment = {
        "segment_id": "",  # assigned below
        "segment_index": 0,  # assigned below
        "type": segment_type,
        "name": name,
        "scene_ids": raw_scene_ids,
        "start": new_start,
        "end": new_end,
    }

    segments.insert(insert_idx, new_segment)

    # Reassign all segment_index / segment_id values sequentially.
    # This handles splits that created extra segments and ensures
    # monotonic indices with no gaps or duplicates.
    for i, seg in enumerate(segments):
        seg["segment_index"] = i + 1
        seg["segment_id"] = f"{video_id}_segment_{i + 1:03d}"
    result["segments"] = segments  # type: ignore[typeddict-unknown-key]

    run_dir = VIDEO_RUNS_DIR / video_id
    with open(run_dir / "scenes.json", "w") as f:
        json.dump(result, f, indent=2)

    return result


def move_to_segment(
    video_id: str,
    scene_ids: list[str],
    target_segment_id: str,
) -> IngestResult:
    """Move scenes into an existing segment.

    Scenes are extracted from their current segment (splitting it if
    needed) and inserted into the target segment at the correct position
    by timestamp.  The target segment's start/end are updated to
    encompass the new scenes.
    """
    result = load_ingest_result(video_id)
    if result is None:
        raise ValueError(f"No ingest output for {video_id}")

    merges = load_merges(video_id)
    scenes = apply_merges(result["scenes"], merges)
    scene_map = {s["scene_id"]: s for s in scenes}

    # Expand merged group IDs to raw scene IDs
    group_by_id = {g["group_id"]: g for g in merges["groups"]}
    raw_scene_ids: list[str] = []
    for sid in scene_ids:
        if sid in group_by_id:
            raw_scene_ids.extend(group_by_id[sid]["scene_ids"])
        elif sid in scene_map:
            raw_scene_ids.append(sid)
        else:
            raise ValueError(f"Unknown scene_id: {sid}")

    segments: list[Segment] = result.get("segments", [])  # type: ignore[assignment]

    # Find target segment
    target = next(
        (s for s in segments if s["segment_id"] == target_segment_id), None
    )
    if target is None:
        raise ValueError(f"Unknown segment_id: {target_segment_id}")

    # Don't extract from the target itself
    extract_set = set(raw_scene_ids)
    if any(sid in extract_set for sid in target["scene_ids"]):
        # Remove any that are already in target from extract_set
        already_in_target = set(target["scene_ids"]) & extract_set
        extract_set -= already_in_target
        raw_scene_ids = [sid for sid in raw_scene_ids if sid not in already_in_target]

    if not raw_scene_ids:
        # All scenes already in target — nothing to do
        run_dir = VIDEO_RUNS_DIR / video_id
        with open(run_dir / "scenes.json", "w") as f:
            json.dump(result, f, indent=2)
        return result

    # Extract scenes from source segments (same logic as create_segment)
    new_segments: list[Segment] = []
    for seg in segments:
        if seg is target:
            new_segments.append(seg)
            continue
        remaining = [sid for sid in seg["scene_ids"] if sid not in extract_set]
        if len(remaining) == len(seg["scene_ids"]):
            new_segments.append(seg)
            continue

        if not remaining:
            seg["scene_ids"] = []
            new_segments.append(seg)
            continue

        # Check contiguity of remaining scenes
        original_order = seg["scene_ids"]
        remaining_set = set(remaining)
        runs: list[list[str]] = []
        current_run: list[str] = []
        for sid in original_order:
            if sid in remaining_set:
                current_run.append(sid)
            else:
                if current_run:
                    runs.append(current_run)
                    current_run = []
        if current_run:
            runs.append(current_run)

        raw_scenes = result["scenes"]
        raw_map = {s["scene_id"]: s for s in raw_scenes}

        if len(runs) == 1:
            seg["scene_ids"] = runs[0]
            members = [raw_map[sid] for sid in runs[0] if sid in raw_map]
            if members:
                seg["start"] = round(min(s["start"] for s in members), 3)
                seg["end"] = round(max(s["end"] for s in members), 3)
            new_segments.append(seg)
        else:
            for ri, run in enumerate(runs):
                members = [raw_map[sid] for sid in run if sid in raw_map]
                suffix = f" ({ri + 1})" if len(runs) > 1 else ""
                split_seg: Segment = {
                    "segment_id": seg["segment_id"],
                    "segment_index": seg["segment_index"],
                    "type": seg["type"],
                    "name": f"{seg['name']}{suffix}",
                    "scene_ids": run,
                    "start": round(min(s["start"] for s in members), 3) if members else seg["start"],
                    "end": round(max(s["end"] for s in members), 3) if members else seg["end"],
                }
                if seg.get("description"):
                    split_seg["description"] = seg["description"]  # type: ignore[typeddict-unknown-key]
                if seg.get("item_id"):
                    split_seg["item_id"] = seg["item_id"]  # type: ignore[typeddict-unknown-key]
                new_segments.append(split_seg)

    segments = new_segments

    # Insert scenes into target by timestamp order
    raw_scenes = result["scenes"]
    raw_map = {s["scene_id"]: s for s in raw_scenes}
    combined = list(target["scene_ids"]) + raw_scene_ids
    combined.sort(key=lambda sid: raw_map[sid]["start"] if sid in raw_map else 0)
    target["scene_ids"] = combined

    # Update target start/end
    all_members = [raw_map[sid] for sid in combined if sid in raw_map]
    if all_members:
        target["start"] = round(min(s["start"] for s in all_members), 3)
        target["end"] = round(max(s["end"] for s in all_members), 3)

    # Reassign all segment indices sequentially
    result["segments"] = segments  # type: ignore[typeddict-unknown-key]
    for i, seg in enumerate(segments):
        seg["segment_index"] = i + 1
        seg["segment_id"] = f"{video_id}_segment_{i + 1:03d}"

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

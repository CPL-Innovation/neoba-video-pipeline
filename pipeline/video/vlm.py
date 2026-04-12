"""VLM (Vision Language Model) analysis via Ollama.

Modular module for running multimodal LLM analysis on video segments
(and later scenes). Communicates with a local Ollama instance via its
HTTP API, sending keyframe images + transcript + metadata as context.
"""

from __future__ import annotations

import base64
import json
import time
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any

from pipeline.video.ingest import (
    VIDEO_RUNS_DIR,
    load_ingest_result,
    load_merges,
    apply_merges,
)
from pipeline.video.transcribe import load_transcript

OLLAMA_BASE_URL = "http://localhost:11434"
DEFAULT_MODEL = "gemma4:e4b"
MAX_IMAGES = 6  # cap keyframes to avoid overwhelming the model
DEFAULT_PROMPT = (
    "Analyze this archival video segment. Describe: "
    "(1) what is visually happening, "
    "(2) any identifiable people, locations, or text on screen, "
    "(3) the apparent era and production style, "
    "(4) the type of content (interview, b-roll, news report, etc.)."
)


def _ollama_chat(
    model: str,
    messages: list[dict[str, Any]],
    *,
    base_url: str = OLLAMA_BASE_URL,
) -> str:
    """Send a chat completion request to Ollama and return the response text."""
    payload = json.dumps({
        "model": model,
        "messages": messages,
        "stream": False,
    }).encode()

    req = urllib.request.Request(
        f"{base_url}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            body = json.loads(resp.read())
    except urllib.error.URLError as e:
        raise ConnectionError(
            f"Cannot reach Ollama at {base_url}. Is it running? ({e})"
        ) from e

    return body.get("message", {}).get("content", "")


def _encode_image(path: Path) -> str:
    """Read an image file and return its base64 encoding."""
    return base64.b64encode(path.read_bytes()).decode()


def _build_context(
    video_id: str,
    segment: dict,
    scenes: list[dict],
) -> str:
    """Build a text context block with metadata and transcript."""
    seg_duration = round(segment["end"] - segment["start"], 1)
    lines = [
        f"Segment: {segment['name']}",
        f"Type: {segment['type']}",
        f"Time range: {segment['start']:.1f}s - {segment['end']:.1f}s ({seg_duration}s)",
        f"Number of scenes: {len(segment['scene_ids'])}",
    ]

    # Add transcript if available
    transcript = load_transcript(video_id)
    if transcript:
        segs = transcript.get("segments", [])
        overlapping = [
            s for s in segs
            if s["end"] > segment["start"] and s["start"] < segment["end"]
        ]
        if overlapping:
            text = " ".join(s["text"].strip() for s in overlapping)
            lines.append(f"\nTranscript:\n{text}")

    return "\n".join(lines)


def _collect_keyframe_paths(
    video_id: str,
    segment: dict,
    scenes: list[dict],
) -> list[Path]:
    """Collect keyframe file paths for all scenes in a segment."""
    run_dir = VIDEO_RUNS_DIR / video_id
    scene_map = {s["scene_id"]: s for s in scenes}
    paths: list[Path] = []

    for sid in segment["scene_ids"]:
        scene = scene_map.get(sid)
        if not scene:
            continue
        for kf in scene.get("keyframes", []):
            p = run_dir / kf["path"]
            if p.exists():
                paths.append(p)

    return paths


def _make_summary(full_text: str, max_chars: int = 120) -> str:
    """Extract a short summary from the full analysis text."""
    # Take the first sentence or first N chars
    first_line = full_text.split("\n")[0].strip()
    # Try to end at a sentence boundary
    for end in (".", "!", "?"):
        idx = first_line.find(end)
        if 0 < idx < max_chars:
            return first_line[: idx + 1]
    if len(first_line) <= max_chars:
        return first_line
    return first_line[:max_chars].rsplit(" ", 1)[0] + "..."


def analyze_segment(
    video_id: str,
    segment_id: str,
    prompt: str = DEFAULT_PROMPT,
    model: str = DEFAULT_MODEL,
) -> dict[str, Any]:
    """Run VLM analysis on a segment and persist the result.

    Returns the vlm_analysis dict that was stored on the segment.
    """
    result = load_ingest_result(video_id)
    if result is None:
        raise ValueError(f"No ingest output for {video_id}")

    segments = result.get("segments", [])
    segment = next((s for s in segments if s["segment_id"] == segment_id), None)
    if segment is None:
        raise ValueError(f"Unknown segment_id: {segment_id}")

    # Work on merged view for consistent scene data
    merges = load_merges(video_id)
    scenes = apply_merges(result["scenes"], merges)

    # Collect keyframe images (capped to avoid overwhelming the model)
    kf_paths = _collect_keyframe_paths(video_id, segment, scenes)
    if not kf_paths:
        raise ValueError(f"No keyframes found for segment {segment_id}")

    # Evenly sample if too many keyframes
    if len(kf_paths) > MAX_IMAGES:
        step = len(kf_paths) / MAX_IMAGES
        kf_paths = [kf_paths[int(i * step)] for i in range(MAX_IMAGES)]

    # Build context and messages
    context = _build_context(video_id, segment, scenes)
    images = [_encode_image(p) for p in kf_paths]

    messages = [
        {
            "role": "system",
            "content": (
                "You are analyzing keyframes from an archival video segment. "
                "You will be given metadata, transcript (if available), and "
                "keyframe images from the segment. Provide your analysis based "
                "on the user's prompt.\n\n"
                f"--- Segment Context ---\n{context}"
            ),
        },
        {
            "role": "user",
            "content": prompt,
            "images": images,
        },
    ]

    # Call Ollama
    full_analysis = _ollama_chat(model, messages)

    # Build result
    analysis = {
        "summary": _make_summary(full_analysis),
        "full_analysis": full_analysis,
        "model": model,
        "prompt": prompt,
        "analyzed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }

    # Persist to scenes.json
    segment["vlm_analysis"] = analysis
    run_dir = VIDEO_RUNS_DIR / video_id
    with open(run_dir / "scenes.json", "w") as f:
        json.dump(result, f, indent=2)

    return analysis

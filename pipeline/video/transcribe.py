"""Stage 2: Audio → text via mlx-whisper (large-v3-turbo).

Consumes audio.wav from the ingest stage (or extracts it on the fly as a
fallback for pre-existing runs), runs mlx-whisper, and writes
transcript.json alongside scenes.json.

mlx-whisper is Apple Silicon only. It is imported lazily inside
run_transcribe() so the rest of the pipeline keeps working on non-Apple
machines — you only pay the import (and the ~1.5 GB model download on
first use) when you actually ask for a transcript.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Callable

from pipeline.video.audio import AUDIO_FILENAME, audio_path_for, extract_audio
from pipeline.video.ingest import (
    VIDEO_RUNS_DIR,
    load_ingest_result,
    resolve_source_path,
)
from pipeline.video.transcript_cleanup import clean_segments

DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"
TRANSCRIPT_FILENAME = "transcript.json"

ProgressCallback = Callable[[dict], None]


def _emit(cb: ProgressCallback | None, payload: dict) -> None:
    if cb is None:
        return
    try:
        cb(payload)
    except Exception:
        # Never let a broken callback take down the transcribe job
        pass


def transcript_path_for(run_dir: Path) -> Path:
    return run_dir / TRANSCRIPT_FILENAME


def load_transcript(video_id: str) -> dict[str, Any] | None:
    path = transcript_path_for(VIDEO_RUNS_DIR / video_id)
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def ensure_audio(
    video_id: str,
    run_dir: Path,
    progress_callback: ProgressCallback | None = None,
) -> Path:
    """Return the path to audio.wav for this video, extracting it if missing.

    Looks up the original source video via the ingest result so callers
    don't need to re-specify it.
    """
    audio_out = audio_path_for(run_dir)
    if audio_out.exists():
        return audio_out

    ingest = load_ingest_result(video_id)
    if ingest is None:
        raise FileNotFoundError(
            f"No ingest result for {video_id} — run Stage 1 ingest first."
        )

    src = resolve_source_path(ingest["source_path"])
    if not src.exists():
        raise FileNotFoundError(f"Source video missing: {src}")

    _emit(progress_callback, {"phase": "extracting_audio"})
    return extract_audio(src, audio_out)


def run_transcribe(
    video_id: str,
    model: str = DEFAULT_MODEL,
    word_timestamps: bool = False,
    force: bool = False,
    cleanup: bool = True,
    progress_callback: ProgressCallback | None = None,
) -> dict[str, Any]:
    """Run mlx-whisper on a video's audio track.

    Idempotent: if transcript.json already exists and force=False, returns
    the cached result without re-running the model.

    When cleanup=True (default), the post-processing pass in
    transcript_cleanup.clean_segments is applied to drop hallucination
    phrases, collapse adjacent duplicates, and collapse intra-segment
    word runs. The raw segments are always persisted alongside the
    cleaned ones so the cleanup is reversible without re-running Whisper
    (see the /transcribe/{id}/reclean endpoint).
    """
    run_dir = VIDEO_RUNS_DIR / video_id
    if not run_dir.exists():
        raise FileNotFoundError(f"No run directory for {video_id}")

    out_path = transcript_path_for(run_dir)
    if out_path.exists() and not force:
        with open(out_path) as f:
            cached: dict[str, Any] = json.load(f)
        _emit(progress_callback, {"phase": "completed", "cached": True})
        return cached

    # 1. Ensure audio track is on disk (extracts it if this run predates
    # Stage 1's audio phase).
    audio_file = ensure_audio(video_id, run_dir, progress_callback=progress_callback)

    # 2. Lazy import — only pay the mlx_whisper import cost (and the
    # ~1.5 GB model download on first use) when we actually transcribe.
    _emit(progress_callback, {"phase": "loading_model", "model": model})
    try:
        import mlx_whisper  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "mlx-whisper is not installed. Install with: "
            "pip install mlx-whisper (Apple Silicon only)."
        ) from e

    # 3. Run transcription. One blocking call — mlx-whisper doesn't expose
    # a per-segment callback, so progress is coarse (phase transitions
    # only, no percentage during this step).
    #
    # Hallucination mitigations for noisy archival audio with long silent
    # stretches (the NEOBA broadcast failure mode):
    #   - condition_on_previous_text=False breaks the autoregressive loop
    #     where one bogus "Thank you." segment feeds the next, which is
    #     where Whisper's classic silent-region hallucinations come from.
    #   - no_speech_threshold=0.4 (down from default 0.6) makes Whisper
    #     more aggressive about marking low-energy windows as non-speech
    #     and emitting empty segments instead of confabulating.
    # Trade-off: very slightly worse coherence on long uninterrupted
    # speech, in exchange for far fewer phantom segments.
    _emit(progress_callback, {"phase": "transcribing"})
    started = time.time()
    result = mlx_whisper.transcribe(
        str(audio_file),
        path_or_hf_repo=model,
        word_timestamps=word_timestamps,
        condition_on_previous_text=False,
        no_speech_threshold=0.4,
    )
    elapsed = time.time() - started

    # 4. Normalize into our on-disk shape.
    raw_segments: list[dict[str, Any]] = []
    for i, seg in enumerate(result.get("segments", [])):
        seg_out: dict[str, Any] = {
            "id": i,
            "start": round(float(seg.get("start", 0.0)), 3),
            "end": round(float(seg.get("end", 0.0)), 3),
            "text": (seg.get("text") or "").strip(),
        }
        if word_timestamps and seg.get("words"):
            seg_out["words"] = [
                {
                    "word": w.get("word", ""),
                    "start": round(float(w.get("start", 0.0)), 3),
                    "end": round(float(w.get("end", 0.0)), 3),
                    "probability": round(float(w.get("probability", 0.0)), 3),
                }
                for w in seg["words"]
            ]
        raw_segments.append(seg_out)

    # 5. Apply cleanup pass (default on). Both lists are persisted so
    # the frontend can toggle and the /reclean endpoint can re-run rules
    # against segments_raw without re-invoking Whisper.
    if cleanup:
        cleaned_segments, cleanup_stats = clean_segments(raw_segments)
    else:
        cleaned_segments = raw_segments
        cleanup_stats = {
            "removed_count": 0,
            "modified_count": 0,
            "kept_count": len(raw_segments),
            "removed_hallucination": 0,
            "removed_adjacent_duplicate": 0,
            "modified_word_run_collapse": 0,
            "rules": [],
        }

    transcript = {
        "video_id": video_id,
        "model": model,
        "language": result.get("language", "en"),
        # Duration always reflects raw audio coverage, not the post-cleanup view.
        "duration": round(raw_segments[-1]["end"] if raw_segments else 0.0, 3),
        "text": (result.get("text") or "").strip(),
        "segments": cleaned_segments,
        "segments_raw": raw_segments,
        "cleanup": {"applied": cleanup, **cleanup_stats},
        "audio_path": AUDIO_FILENAME,
        "word_timestamps": word_timestamps,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "status": "completed",
        "elapsed_seconds": round(elapsed, 2),
    }

    _emit(progress_callback, {"phase": "writing"})
    with open(out_path, "w") as f:
        json.dump(transcript, f, indent=2)

    _emit(
        progress_callback,
        {
            "phase": "completed",
            "segment_count": len(cleaned_segments),
            "raw_segment_count": len(raw_segments),
            "removed_by_cleanup": cleanup_stats["removed_count"],
            "elapsed_seconds": round(elapsed, 2),
            "language": transcript["language"],
        },
    )
    return transcript

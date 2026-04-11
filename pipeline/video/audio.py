"""Audio extraction helper for the video pipeline.

Used by Stage 1 (ingest) to write audio.wav alongside keyframes, and by
Stage 2 (transcribe) as a fallback when running on a video that was
ingested before audio extraction was added to Stage 1.

Format: 16 kHz mono PCM WAV — what Whisper expects natively (no resampling
at inference time) and human-playable for debugging.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

AUDIO_FILENAME = "audio.wav"
AUDIO_SAMPLE_RATE = 16000
AUDIO_CHANNELS = 1


def audio_path_for(run_dir: Path) -> Path:
    """Canonical audio path for a given video run directory."""
    return run_dir / AUDIO_FILENAME


def extract_audio(video_path: Path, out_path: Path, force: bool = False) -> Path:
    """Extract the audio track from `video_path` to `out_path` as 16 kHz mono WAV.

    Idempotent: if `out_path` already exists and `force` is False, returns
    immediately without re-decoding. Raises RuntimeError if ffmpeg is missing
    or the extraction fails.
    """
    if out_path.exists() and not force:
        return out_path

    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found on PATH. Install ffmpeg.")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(video_path),
            "-vn",                     # drop video stream
            "-acodec",
            "pcm_s16le",               # 16-bit little-endian PCM
            "-ar",
            str(AUDIO_SAMPLE_RATE),    # 16 kHz — whisper-native
            "-ac",
            str(AUDIO_CHANNELS),       # mono
            str(out_path),
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0 or not out_path.exists():
        raise RuntimeError(
            f"ffmpeg audio extraction failed (rc={proc.returncode}): "
            f"{proc.stderr.strip()}"
        )
    return out_path

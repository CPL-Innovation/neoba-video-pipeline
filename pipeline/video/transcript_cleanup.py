"""Post-processing cleanup pass for mlx-whisper transcripts.

Even with `condition_on_previous_text=False` and a tightened
`no_speech_threshold`, Whisper still hallucinates on silent / noisy
stretches in NEOBA broadcast audio. Typical failure modes we see:

  - "Thank you." emitted at every silent gap (low-content phrase)
  - Adjacent identical segments ("Thank you." × 5 in a row)
  - Intra-segment word runs ("the the the the the the")
  - Subtitle / training-data leaks ("Subscribe...", "♪ ♪ ♪", "[Music]")

This module is a pure-python pass applied to a list of segments after
Whisper returns. It is **non-destructive**: callers store both the raw
and cleaned segments, so cleanup rules can be re-tuned and re-applied
without re-running the (expensive) transcription step.

Rules are intentionally conservative — when in doubt, keep the segment.
The frontend "show raw" toggle is the safety valve when a real line
gets dropped.
"""

from __future__ import annotations

import re
from typing import Any

# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

_PUNCT_RE = re.compile(r"[^\w\s]")
_SPACE_RE = re.compile(r"\s+")


def _normalize(text: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace.

    Used for hallucination-phrase matching and adjacent-duplicate
    detection. Two segments that differ only in punctuation/whitespace
    are treated as identical.
    """
    t = text.lower()
    t = _PUNCT_RE.sub(" ", t)
    t = _SPACE_RE.sub(" ", t).strip()
    return t


# ---------------------------------------------------------------------------
# Hallucination phrase set
# ---------------------------------------------------------------------------
#
# These are the post-normalization strings (lowercased, no punctuation,
# collapsed whitespace) that we treat as Whisper hallucinations and drop
# outright. Sourced from observed NEOBA failures + community-known
# Whisper "training data leak" phrases (subscribe / thanks-for-watching
# come from YouTube captions in the training set).
#
# Single-word entries are aggressive but justified: they only match when
# the *entire* segment normalizes to that one word, which is almost never
# legitimate signal in a 30-min news broadcast.
HALLUCINATION_PHRASES: set[str] = {
    # Empty / whitespace-only / punctuation-only
    "",
    # Standalone "you" — extremely common Whisper hallucination on silence
    "you",
    # Thank-you family
    "thank you",
    "thanks",
    "thank you very much",
    "thanks very much",
    "thanks for watching",
    "thank you for watching",
    "thanks for watching the video",
    "thanks for watching this video",
    "thank you so much",
    # Subscribe / YouTube training-data leaks
    "subscribe",
    "please subscribe",
    "like and subscribe",
    "don t forget to subscribe",
    "thanks for subscribing",
    # Sound-effect markers ([Music] → "music", (Applause) → "applause")
    "music",
    "music playing",
    "applause",
    "laughter",
    "silence",
    # Sign-off filler
    "bye",
    "bye bye",
    "goodbye",
    "okay",
    "ok",
}


def _is_hallucination(normalized: str) -> bool:
    return normalized in HALLUCINATION_PHRASES


# ---------------------------------------------------------------------------
# Intra-segment word-run collapse
# ---------------------------------------------------------------------------


def _collapse_word_runs(
    text: str, threshold: int = 3
) -> tuple[str, int]:
    """Collapse runs of `threshold`+ identical adjacent words to one.

    Case-insensitive comparison, but the kept word preserves its
    original casing (the first occurrence in the run).

    Returns (cleaned_text, run_count) where run_count is the number of
    runs that were collapsed (not the number of words removed).

    Threshold of 3 deliberately preserves emphasis like "go go" or
    "no no" while killing "the the the the the".
    """
    words = text.split()
    if len(words) < threshold:
        return text, 0

    out: list[str] = []
    i = 0
    runs_collapsed = 0
    while i < len(words):
        j = i + 1
        while j < len(words) and words[j].lower() == words[i].lower():
            j += 1
        run_len = j - i
        if run_len >= threshold:
            out.append(words[i])
            runs_collapsed += 1
        else:
            out.extend(words[i:j])
        i = j
    return " ".join(out), runs_collapsed


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


def clean_segments(
    segments: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Apply all cleanup rules to a list of transcript segments.

    Returns ``(cleaned_segments, stats)``.

    Rules, in order, per segment:
      1. Collapse intra-segment word runs (3+ identical adjacent words → 1).
      2. Drop if normalized text is in HALLUCINATION_PHRASES.
      3. Drop if normalized text equals the previous kept segment
         (adjacent duplicate collapse).

    Stats fields:
      - removed_hallucination: count dropped by rule 2
      - removed_adjacent_duplicate: count dropped by rule 3
      - modified_word_run_collapse: count of segments where rule 1 fired
      - removed_count: total dropped
      - modified_count: total kept-but-modified
      - kept_count: total kept
      - rules: list of rule names applied
    """
    cleaned: list[dict[str, Any]] = []
    stats: dict[str, Any] = {
        "removed_hallucination": 0,
        "removed_adjacent_duplicate": 0,
        "modified_word_run_collapse": 0,
        "removed_count": 0,
        "modified_count": 0,
        "kept_count": 0,
        "rules": [
            "word_run_collapse",
            "hallucination_phrase",
            "adjacent_duplicate",
        ],
    }

    last_normalized: str | None = None

    for seg in segments:
        text = (seg.get("text") or "").strip()

        # Rule 1: collapse intra-segment word runs (modifies text in place)
        new_text, runs_collapsed = _collapse_word_runs(text)
        modified = runs_collapsed > 0
        if modified:
            stats["modified_word_run_collapse"] += 1
            text = new_text

        normalized = _normalize(text)

        # Rule 2: drop hallucination phrases
        if _is_hallucination(normalized):
            stats["removed_hallucination"] += 1
            stats["removed_count"] += 1
            continue

        # Rule 3: drop adjacent duplicates of the previous kept segment
        if normalized == last_normalized:
            stats["removed_adjacent_duplicate"] += 1
            stats["removed_count"] += 1
            continue

        new_seg = dict(seg)
        new_seg["text"] = text
        cleaned.append(new_seg)
        last_normalized = normalized
        if modified:
            stats["modified_count"] += 1

    stats["kept_count"] = len(cleaned)
    return cleaned, stats

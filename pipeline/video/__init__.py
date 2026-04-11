"""Video pipeline sub-package.

Stages:
    1. ingest    — ffmpeg + PySceneDetect: extract audio, detect scenes, pick keyframes
    2. extract   — VLM caption, Whisper transcript, Apple Vision OCR, InsightFace embeddings
    3. cluster   — face embedding clustering, scene/transcript alignment
    4. synthesize — local LLM synthesis into Dublin-Core-compatible JSON
    5. (review handled by the React frontend)
"""

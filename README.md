# NEOBA Archive Pipeline

Archival video processing and classification tool for the [NEOBA (Northeast Ohio Broadcast Archives)](https://cpl.org) collection at Cleveland Public Library. Takes unannotated broadcast news footage and produces structured, Dublin-Core-compatible metadata — scene breakdowns, transcripts, visual analysis, thematic tags — entirely on local hardware.

## Architecture

The system is a full-stack application with two processing tracks that share the same server, frontend shell, and dev tooling.

```
┌─────────────────────────────────────────────────────┐
│  React + TypeScript + Vite (port 5173)              │
│  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │ Catalog       │  │ Video Pipeline               │ │
│  │ Classifier    │  │ Ingest → Extract → Cluster → │ │
│  │ (Tier 1-3)   │  │ Synthesize → Review          │ │
│  └──────────────┘  └──────────────────────────────┘ │
│                       /api proxy                     │
├─────────────────────────────────────────────────────┤
│  FastAPI + Python (port 8000)                        │
│  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │ pipeline/     │  │ pipeline/video/              │ │
│  │ classify.py   │  │ ingest.py, transcribe.py,    │ │
│  │ (Claude API)  │  │ segments.py, vlm.py,         │ │
│  │               │  │ router.py                    │ │
│  └──────────────┘  └──────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
         │                       │
    data/runs/catalog/     data/runs/video/<id>/
    (classifications)      (scenes, keyframes, transcripts)
```

### Catalog Classifier

LLM-powered classification of 14,000+ archival news items. Claude classifies items into thematic threads, extracts entities (people, places, organizations), and semantic clustering (TF-IDF + UMAP + HDBSCAN) groups similar items. Results are browsable, searchable, and exportable through the review UI. Entity merging supports deduplication across surface forms.

### Video Pipeline

A 5-stage, all-local pipeline for video content. Every stage writes non-destructive JSON sidecars alongside the source files — no original data is modified.

| Stage | What it does | Tools |
|-------|-------------|-------|
| **1. Ingest & Segment** | Detect scene boundaries, extract keyframes, extract audio, detect narrative segments via black-slug analysis | ffmpeg, PySceneDetect, keyframe luminance analysis |
| **2. Extract** | Run specialist models on audio + keyframes | mlx-whisper (large-v3-turbo), Gemma 4 E4B / Qwen2.5-VL via Ollama, Apple Vision OCR, InsightFace |
| **3. Cluster** | Cluster face embeddings, align transcripts to scenes, assemble per-scene fact bundles | DBSCAN (cosine similarity) |
| **4. Synthesize** | Read fact bundles, emit Dublin-Core-compatible structured JSON | Gemma 4 26B A4B / Qwen2.5-14B via Ollama |
| **5. Store & Review** | Persist outputs, expose for human-in-the-loop review, flag low-confidence fields | SQLite index + JSON sidecars |

Stage 1 and portions of Stage 2 (transcription, VLM analysis) are fully implemented. Stages 3-5 have frontend route stubs and planned backend modules.

### Data layout

```
public/data/source/
  videos/               # Drop source videos here
  items.json            # Catalog source records

data/runs/
  video/<video_id>/
    metadata.json       # Duration, source path
    scenes.json         # Scene boundaries (may include merges)
    scenes.raw.json     # Pristine PySceneDetect output (never modified)
    merges.json         # Pending merge groups sidecar
    transcript.json     # Whisper output (raw + cleaned)
    audio.wav           # 16kHz mono PCM
    keyframes/          # scene_NNN_{start,mid,end}.jpg
  catalog/<run>/
    classifications.json
    edits.json          # Entity merge overlay
```

### Key design decisions

- **All-local inference.** The NEOBA collection is rights-sensitive. No video data leaves CPL hardware — all models run on-device via Ollama, MLX, and Apple frameworks.
- **Decomposed specialists over monolithic multimodal.** Whisper beats generalist models on 1970s broadcast audio. Apple Vision is better at chyron OCR. Auditable seams matter for archival work — when a field is wrong, you can trace which component produced it.
- **Non-destructive sidecars.** Pipeline outputs sit alongside source files as JSON. The raw PySceneDetect output (`scenes.raw.json`) is never modified after creation. Merges are tracked in a reversible sidecar until explicitly baked.
- **Human-in-the-loop.** Stage 4 output flags low-confidence fields (named people, Cleveland landmarks) for subject-matter-expert review before anything becomes public.

## Setup

### Prerequisites

- Node.js 18+
- Python 3.11+
- ffmpeg and ffprobe on PATH
- [Ollama](https://ollama.com/) (for VLM analysis)

### Frontend

```bash
npm install
npm run dev          # http://localhost:5173
```

### Backend

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r pipeline/requirements.txt

# Required for catalog classification (not needed for video pipeline)
echo "ANTHROPIC_API_KEY=sk-..." > .env

.venv/bin/python3 -m uvicorn pipeline.server:app --host 0.0.0.0 --port 8000
```

### Ollama (for VLM analysis)

```bash
brew install ollama
ollama pull gemma4:e4b       # ~9 GB, multimodal
ollama serve                 # http://localhost:11434
```

The Vite dev server proxies all `/api` requests to the FastAPI backend automatically.

## API overview

All video pipeline endpoints are mounted at `/api/video`. Key groups:

| Group | Examples |
|-------|---------|
| **Ingest** | `POST /ingest`, `GET /ingest/{id}/status`, `POST /ingest-pipeline` |
| **Scenes** | `GET /videos/{id}/scenes`, `POST /merges`, `POST /scenes/split`, `POST /scenes/trim` |
| **Segments** | `POST /segments/detect`, `POST /segments/create`, `POST /segments/move`, `PATCH /segments/{id}/description` |
| **Transcripts** | `PATCH /videos/{id}/transcript/segments` |
| **VLM** | `POST /segments/{id}/analyze`, `GET /segments/{id}/analyze/status` |
| **Settings** | `GET /api/settings`, `PATCH /api/settings` |

See [router.py](pipeline/video/router.py) for the full endpoint list.

## Limitations

- **Stages 3-5 are not yet implemented.** Face clustering, LLM synthesis, and the review/store layer exist only as frontend stubs and planned module outlines.
- **Single-video scope.** Cross-video reasoning (e.g., recognizing the same person across tapes) is explicitly out of scope for the MVP.
- **Apple Silicon assumed.** mlx-whisper and MLX-based model loading target Apple Silicon Macs. The pipeline has not been tested on Linux or Intel hardware.
- **No authentication.** The FastAPI server has no auth layer — it is designed to run on a local workstation or trusted LAN, not exposed to the public internet.
- **Named entity recognition is weak.** Historic Cleveland figures and local landmarks are frequently missed or hallucinated by current models. Mitigation is planned via a NEOBA-specific gazetteer injected into VLM/synthesis prompts.
- **Transcript quality varies.** 1970s broadcast audio with background noise, overlapping speech, or degraded tape produces noisy Whisper output. The cleanup pass catches common hallucination patterns but manual review is still needed.
- **No batch/queue processing.** Videos are processed one at a time through the UI. There is no job queue for bulk ingest of an entire tape collection.

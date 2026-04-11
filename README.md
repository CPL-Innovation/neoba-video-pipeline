# NEOBA Archive Classifier

LLM-powered classification and entity extraction tool for the NEOBA (Northeast Ohio Broadcast Archives) collection. Processes 14,000+ archival news items through a three-tier pipeline: LLM classification, entity extraction, and semantic clustering.

## Architecture

- **Frontend**: React + TypeScript + Vite + Tailwind CSS + TanStack Table
- **Backend**: FastAPI (Python) with Claude API for classification
- **Pipeline**: Batch classification with stop/resume support

### Frontend Views

| View | Description |
|------|-------------|
| Run Classification | Execute Tier 1+2 (LLM) and Tier 3 (clustering) with real-time progress tracking and status polling |
| Review Table | Browse, search, and filter classified items with inline detail panels |
| Proposed Threads | Review LLM-suggested threads with accept, reject, merge, and remap actions |
| Entity Browser | Explore extracted entities with merge support, suggested merges, and single-name resolution |
| Cluster Explorer | Interactive scatter plot with zoom/pan, dot hover/click for item details, cluster selection with highlighting and detail panel |
| Cryptic Queue | Items flagged as cryptic for manual review, with duplicate filtering |
| Export | Export classifications in various formats |

### Pipeline (Tier 1+2+3)

1. **Tier 1+2** (LLM): Claude classifies items into threads and extracts entities (people, places, organizations, event types) in batches
2. **Tier 3** (Clustering): TF-IDF + UMAP + HDBSCAN for semantic grouping with background job tracking and status polling

## Video Pipeline

A second processing track for archival video content, structured as a 5-stage local-LLM pipeline. Lives alongside the text classifier as a sub-package (`pipeline/video/`) and shares the same FastAPI app, dev server, and frontend shell.

### Goal

Take an unannotated archival news video and progressively enrich it: cut it into scenes, describe each scene with a vision-language model, cluster scenes into recurring topics/places/people, synthesize cluster-level summaries, then surface the result for human review and correction. The end product is a structured, searchable scene index that mirrors the per-item structure the text classifier produces — but for video.

### Stages

| # | Stage | Purpose | Tools |
|---|-------|---------|-------|
| 1 | **Ingest & Segment** | Probe duration, detect scene boundaries, extract start/mid/end keyframes per scene | `ffprobe`, PySceneDetect (`ContentDetector`), `ffmpeg` |
| 2 | **Extract** | Per-scene vision-language captioning + entity/object extraction from keyframes | Local VLM (planned: Qwen2-VL / LLaVA via Ollama) |
| 3 | **Cluster** | Group semantically similar scenes across the corpus into recurring topics, locations, people | Embedding model + UMAP + HDBSCAN (mirrors text Tier 3) |
| 4 | **Synthesize** | LLM-generated cluster summaries, suggested labels, candidate threads | Local LLM (planned: Llama 3 / Qwen via Ollama) |
| 5 | **Review** | Human-in-the-loop UI for accepting/rejecting/merging clusters and correcting captions | Frontend only |

### Stage 1 — Ingest & Segment (implemented)

Real, working end-to-end. Drop a video into `public/data/source/videos/`, pick it from the dropdown, and click **Run Ingest**.

**Backend** (`pipeline/video/ingest.py`)
- `probe_duration()` — `ffprobe` to get clip length
- `detect_scene_boundaries()` — PySceneDetect `ContentDetector` (default threshold 27.0)
- `extract_keyframe()` — `ffmpeg` fast-seek single-frame JPEG extraction
- `_keyframe_timestamps()` — start/mid/end (with 0.25s edge inset) for scenes ≥3s, midpoint only for shorter scenes
- Writes `data/runs/video/<video_id>/scenes.json` + `metadata.json` and `keyframes/scene_NNN_{start,mid,end}.jpg`
- `source_public_path` field is persisted so the frontend can serve the original video directly through Vite for clip preview

**Backend HTTP** (`pipeline/video/router.py`, mounted at `/api/video`)
- `GET /source-videos` — list videos in `public/data/source/videos/`
- `GET /videos` — list ingested runs
- `POST /ingest` — kick off Stage 1 in a background thread, returns `video_id`
- `GET /ingest/{video_id}/status` — poll phase / progress (`probing` → `detecting` → `extracting` → `completed`)
- `GET /videos/{video_id}/scenes` — full `scenes.json` payload
- `GET /videos/{video_id}/keyframes/{filename}` — path-traversal-protected JPEG serving

**Frontend** (`src/views/VideoPipeline/Ingest/index.tsx`)
- Source video dropdown driven by `/api/video/source-videos`
- Optional video ID override (auto-derived from filename otherwise)
- Live progress: phase label, spinner, and a keyframe progress bar during extraction (1s polling)
- Ingested-videos list with click-to-load
- Per-scene expandable rows showing:
  - Inline HTML5 `<video>` clip preview using a Media Fragment URI (`#t=start,end`) — playback is constrained to the scene range, no actual cutting required
  - Thumbnail strip of the start / mid / end keyframes

### Stages 2–5 (planned)

Sidebar entries and route stubs exist for **Extract**, **Cluster**, **Synthesize**, and **Review** under `src/views/VideoPipeline/`. Each currently renders a "not built yet" placeholder. Backend modules will be added under `pipeline/video/` as siblings to `ingest.py` (e.g. `extract.py`, `cluster.py`, `synthesize.py`) and mounted on the same router.

### Current dev status

| Area | Status |
|---|---|
| Sidebar restructure (collapsible Classifier + Video Pipeline groups, Model Compare leaf) | Done |
| Backend sub-package layout (`pipeline/video/`) wired into existing FastAPI app | Done |
| Stage 1 ingest — ffprobe / PySceneDetect / ffmpeg | Done |
| Stage 1 frontend — run, poll, preview keyframes, preview scene clips | Done |
| Stage 2 Extract (VLM captioning) | Stub view, not implemented |
| Stage 3 Cluster (embeddings + UMAP + HDBSCAN) | Stub view, not implemented |
| Stage 4 Synthesize (LLM cluster summaries) | Stub view, not implemented |
| Stage 5 Review (human-in-the-loop UI) | Stub view, not implemented |
| Model Compare sibling view | Stub, not implemented |

## Setup

### Frontend

```bash
npm install
npm run dev        # starts on http://localhost:5173
```

### Backend

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r pipeline/requirements.txt

# Set your Anthropic API key
echo "ANTHROPIC_API_KEY=sk-..." > .env

.venv/bin/python3 -m uvicorn pipeline.server:app --host 0.0.0.0 --port 8000
```

The video pipeline (Stage 1) also requires `ffmpeg` and `ffprobe` on `PATH`:

```bash
brew install ffmpeg          # macOS
# or: sudo apt install ffmpeg
```

The Vite dev server proxies `/api` requests to the backend.

### Entity Merging

The LLM extracts entities per-item independently, so the same entity often appears with different surface forms (e.g., "RTA" vs "Regional Transit Authority"). The Entity Browser supports:

- **Multi-merge**: Select 2+ entities, set a canonical name, and merge. All `item_ids` combine under the canonical entry.
- **Suggested merges**: Auto-detected candidates via substring, abbreviation, prefix, and normalization matching. One-click accept or dismiss.
- **Single-name resolution**: A queue of people entities with single names (e.g., "Nader") that can be resolved to full names (e.g., "Ralph Nader").

Merges are stored as overlay edits in `data/runs/<run>/edits.json` and never modify the original LLM output (`classifications.json`). They are applied when rebuilding the entity index and during export.

## Data

Source items are in `public/data/source/items.json`. Classification outputs are saved to `data/runs/<run-name>/`.

Note: The source file contains 14,242 rows but 161 are duplicates (same container-item ID), yielding 14,081 unique items.

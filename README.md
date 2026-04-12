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

A second processing track for archival video content, structured as a 5-stage **all-local** pipeline. Lives alongside the text classifier as a sub-package (`pipeline/video/`) and shares the same FastAPI app, dev server, and frontend shell.

### Goal

Take an unannotated archival news video and produce Dublin-Core-compatible structured metadata — scene breakdown, transcripts, detected people/locations, thematic tags, timestamps — entirely on-device. The target output mirrors a March 25 Gemini cloud prototype, but every byte of NEOBA footage stays on CPL-owned hardware because the collection is rights-sensitive: no cloud inference, no API calls, no remote storage.

The architecture is a **mostly-decomposed specialist pipeline** with Gemma 4 as the visual and synthesis brain. Decomposition is preserved (rather than collapsing everything into a single multimodal call) because Whisper large-v3 still beats any generalist on 1970s broadcast audio, Apple Vision is rock-solid at chyron/signage OCR, and auditable seams matter for archival use — when a field is wrong you want to know *which* component was wrong. Cross-video reasoning is explicitly **not** in the MVP. See [`docs/local-llm-pipeline-mvp-2026-04-11.md`](docs/local-llm-pipeline-mvp-2026-04-11.md) for the full scoping doc — rationale, model trade-offs, prompts, effort estimate, and open decisions.

### Stages

| # | Stage | Purpose | Tools |
|---|-------|---------|-------|
| 1 | **Ingest & Segment** | Extract audio track, detect scene boundaries, pick 1–3 keyframes per scene | `ffmpeg`, `ffprobe`, PySceneDetect (`ContentDetector`) |
| 2 | **Per-modality extraction** | Run specialist models in parallel on audio + keyframes | mlx-whisper (large-v3-turbo) for transcripts; **Gemma 4 E4B** via MLX as primary VLM with **Qwen2.5-VL-7B** as A/B backend; Apple Vision for OCR; InsightFace (`buffalo_l`) for face embeddings |
| 3 | **Cluster & aggregate** | Cluster face embeddings within a video, attach transcript segments to scenes by timestamp, build per-scene fact bundles (the "evidence packet" for Stage 4) | DBSCAN (cosine) on face embeddings, timestamp intersection |
| 4 | **LLM synthesis** | Read per-scene fact bundles and emit Dublin-Core-compatible JSON via schema-constrained output | **Gemma 4 26B A4B** (MoE, Q4_K_M) via Ollama as primary; **Qwen2.5-14B-Instruct** (Q4_K_M) as 16 GB / tooling-instability fallback |
| 5 | **Store & review** | Persist outputs non-destructively and expose for human-in-the-loop review, flagging low-confidence fields (locations, named people) for SME validation | SQLite index + per-video JSON sidecars, review UI reusing the classifier frontend shell |

#### Ambitious variant: collapsed Stage 2+4

Because Gemma 4 26B A4B natively accepts video and audio, a second track worth prototyping *after* the decomposed path works is feeding Gemma 4 the raw video directly and asking it to emit the structured JSON in one call — collapsing Stages 2 and 4. Whisper still runs in parallel (better transcriber) and its output gets passed into Gemma 4's text context alongside the video. Head-to-head comparison against the decomposed path, not a replacement.

### Stage 1 — Ingest & Segment (implemented)

Real, working end-to-end. Drop a video into `public/data/source/videos/`, pick it from the dropdown, and click **Run Ingest**.

**Backend** (`pipeline/video/ingest.py`)
- `probe_duration()` — `ffprobe` to get clip length
- `detect_scene_boundaries()` — PySceneDetect `ContentDetector` (default threshold 27.0)
- `extract_keyframe()` — `ffmpeg` fast-seek single-frame JPEG extraction
- `_keyframe_timestamps()` — start/mid/end (with 0.25s edge inset) for scenes ≥3s, midpoint only for shorter scenes
- `extract_audio()` — `ffmpeg` 16 kHz mono PCM WAV extraction for downstream transcription
- Writes `data/runs/video/<video_id>/scenes.json` + `scenes.raw.json` + `metadata.json` + `audio.wav` and `keyframes/scene_NNN_{start,mid,end}.jpg`
- `scenes.raw.json` is the pristine PySceneDetect output, written at ingest time. `scenes.json` may later be modified by merge-apply; `.raw.json` never changes after creation.
- `source_public_path` field is persisted so the frontend can serve the original video directly through Vite for clip preview

**Scene merging** (`pipeline/video/ingest.py` merge subsystem)

Users can consolidate adjacent scenes from the UI. The system uses a two-phase commit model with a `merges.json` sidecar:

1. **Pending merges** — freely reversible per-group via `DELETE /merges/{group_id}`
2. **Apply all merges** — bakes the merged view into `scenes.json`, clears the sidecar. Irreversible from the UI (re-run Stage 1 to reset). `scenes.raw.json` stays untouched as the pristine baseline.

Key design points:
- `merges.json` sidecar tracks groups, their member scene IDs, and status (`pending` | `committed`)
- Merged scenes inherit the first constituent scene's ID (e.g., merging `_scene_007` + `_scene_008` + `_scene_009` → `_scene_007`), not a synthetic `_group_NNN` name
- After apply, merged scenes are indistinguishable from raw scenes — `merged_from` and `merge_status` metadata is stripped
- Group absorption: merging a pending group with adjacent scenes creates a larger group
- Committed groups are frozen — cannot be absorbed or unmerged
- Contiguity validation: only adjacent scenes in the raw scene list can be merged
- v1→v2 migration: old sidecars without status fields default to "committed"

**Scene editing** (`pipeline/video/ingest.py`)

- **Inline rename**: Double-click a scene name in the UI to rename it. Updates `scenes.json` and `merges.json` references.
- **Keyframe deletion**: Remove unwanted keyframes from scenes (useful after merging). Deletes both the JSON entry and the image file on disk. The last keyframe in a scene cannot be deleted.

**Backend HTTP** (`pipeline/video/router.py`, mounted at `/api/video`)
- `GET /source-videos` — list videos in `public/data/source/videos/`
- `GET /videos` — list ingested runs
- `POST /ingest` — kick off Stage 1 in a background thread, returns `video_id`
- `GET /ingest/{video_id}/status` — poll phase / progress (`probing` → `detecting` → `extracting` → `completed`)
- `GET /videos/{video_id}/scenes` — merged scene view (applies `merges.json` groups); pass `?raw=true` for untouched PySceneDetect output
- `POST /videos/{video_id}/merges` — create a pending merge group from contiguous scene IDs
- `DELETE /videos/{video_id}/merges/{group_id}` — unmerge a pending group (409 for committed)
- `POST /videos/{video_id}/merges/apply` — bake all merges into `scenes.json` (irreversible)
- `PATCH /videos/{video_id}/scenes/rename` — rename a scene (updates `scenes.json` + `merges.json`)
- `POST /videos/{video_id}/scenes/delete-keyframe` — remove a keyframe from a scene (JSON entry + image file)
- `GET /videos/{video_id}/keyframes/{filename}` — path-traversal-protected JPEG serving

**Frontend** (`src/views/VideoPipeline/Ingest/index.tsx`)

Two-level master-detail navigation:

- **Level 1 — Video list**: Run Ingest form + Ingested Videos list. Click a video to drill in.
- **Level 2 — Scene browser**: Side-by-side layout with back navigation.
  - **Left panel (55%)**: Compact scene list with thumbnail, checkbox for merge selection, scene ID (double-click to rename), merge status badge, time range, duration, and ✕ unmerge button. Duration filter (min/max seconds) for isolating short segments. Merge action bar at bottom.
  - **Right panel (45%)**: Scene-scoped video player (custom controls with seek bar, play/pause, and time display mapped to the scene's time range — not the full video duration), scene metadata, and 3-column keyframe grid with hover ✕ buttons for deleting unwanted keyframes.
  - Single-click a row → preview; checkbox click → multi-select for merge; shift-click → range select (file-browser semantics)
  - Merge status badges: maize `PENDING ×N` vs teal `MERGED ×N`
  - "Apply All Merges" button appears when pending merges exist

### Stages 2–5 (planned)

Sidebar entries and route stubs exist for **Extract**, **Cluster**, **Synthesize**, and **Review** under `src/views/VideoPipeline/`. Each currently renders a "not built yet" placeholder. Backend modules will be added under `pipeline/video/` as siblings to `ingest.py` and mounted on the same router:

- `extract.py` — Stage 2 orchestrator that dispatches a scene's audio + keyframes to the specialist backends (mlx-whisper, the VLM backend, Apple Vision OCR, InsightFace) behind a common interface. The VLM backend is deliberately swappable so Gemma 4 E4B and Qwen2.5-VL-7B can be A/B tested on the same clips for caption quality, OCR pickup, temporal coherence, and throughput.
- `aggregate.py` — Stage 3 face DBSCAN + transcript-to-scene time alignment + per-scene fact-bundle assembly.
- `synthesize.py` — Stage 4 Ollama client (Gemma 4 26B A4B primary, Qwen2.5-14B fallback) with JSON-schema-constrained output. Emits the Dublin-Core-compatible metadata document.
- `store.py` — Stage 5 SQLite index + JSON sidecar writer. Sidecars stay next to the source video, non-destructively, per Ben's "indexes not transforms" philosophy.

Human-in-the-loop is an explicit design seam: Stage 4 output flags low-confidence fields (especially named people and Cleveland landmarks) for SME review before anything becomes public. Known weak points vs. the Gemini prototype are named-entity recognition on historic Cleveland figures and landmark geolocation — mitigated by building a gazetteer of NEOBA-relevant names/places from the April 7 text-classifier entity run and injecting it as context into the VLM and synthesis prompts.

### Current dev status

| Area | Status |
|---|---|
| Sidebar restructure (collapsible Classifier + Video Pipeline groups, Model Compare leaf) | Done |
| Backend sub-package layout (`pipeline/video/`) wired into existing FastAPI app | Done |
| Stage 1 ingest — ffprobe / PySceneDetect / ffmpeg / audio extraction | Done |
| Stage 1 ingest — `scenes.raw.json` pristine baseline written at ingest time | Done |
| Stage 1 scene merging — two-phase merge model (pending → committed), `merges.json` sidecar, group absorption, contiguity validation, apply-all bakes into `scenes.json`, merged scenes named after first constituent | Done |
| Stage 1 scene editing — inline rename (double-click), keyframe deletion (hover ✕, removes JSON entry + image file) | Done |
| Stage 1 frontend — two-level master-detail UI (video list → side-by-side scene browser with merge selection, shift-click range select, scene-scoped video player, keyframe grid, duration filter, inline rename) | Done |
| Stage 2 Extract — mlx-whisper transcripts (`whisper-large-v3-turbo`, segment-level timestamps, background job + polling, click-to-seek transcript viewer) | Done |
| Stage 2 Extract — transcript cleanup pass (hallucination-phrase drop, adjacent-duplicate dedup, intra-segment word-run collapse; raw + cleaned both persisted; raw/cleaned toggle and `/transcribe/{id}/reclean` endpoint for re-running rules without re-invoking Whisper) | Done |
| Stage 2 Extract — VLM backend interface (Gemma 4 E4B primary, Qwen2.5-VL-7B A/B) | Stub view, not implemented |
| Stage 2 Extract — Apple Vision OCR on keyframes | Stub view, not implemented |
| Stage 2 Extract — InsightFace face detection + embeddings | Stub view, not implemented |
| Stage 3 Aggregate — face DBSCAN + transcript/scene time alignment + fact bundles | Stub view, not implemented |
| Stage 4 Synthesize — Gemma 4 26B A4B via Ollama, schema-constrained JSON | Stub view, not implemented |
| Stage 5 Store & Review — SQLite index + JSON sidecars + review UI | Stub view, not implemented |
| Collapsed Stage 2+4 variant (Gemma 4 native-video path) | Not started (prototype after decomposed path works) |
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

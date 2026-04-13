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
| Review Table | Browse, search, and filter classified items with inline detail panels. Duplicates filter for items sharing container-item IDs |
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

**Scene editing** (`pipeline/video/ingest.py`, `pipeline/video/router.py`)

- **Inline rename**: Double-click a scene name in the UI to rename it. Updates `scenes.json` and `merges.json` references.
- **Keyframe deletion**: Remove unwanted keyframes from scenes (useful after merging). Deletes both the JSON entry and the image file on disk. The last keyframe in a scene cannot be deleted.
- **Time range editing**: Double-click a scene's time range in the scene list to edit start/end times inline. Changes persist immediately to `scenes.json`.
- **Scene tagging**: Assign tags to scenes from a configurable valid-tags list (`pipeline/video/tags.json`). Tags appear as badges in the scene list and as a dropdown selector in the preview panel. Tags persist to `scenes.json`.
- **Scene trimming**: Pause the video at any point inside a scene, then use "Trim to here" (keep beginning) or "Trim from here" (keep end). The adjacent scene automatically absorbs the trimmed portion to maintain continuity — no gaps between scenes.

**Segment detection** (`pipeline/video/segments.py`)

Segments are narrative units made of scenes, detected via black-slug analysis. Black slugs — scenes whose keyframes are nearly all-black — serve as segment boundaries.

- `detect_black_slugs()` — analyzes already-extracted keyframe JPEGs using a dual criterion: mean luminance < 30/255 AND standard deviation < 5.0 (to distinguish uniform black from dark-but-textured content like nighttime footage). Min duration 0.5s. No video re-scan needed. Handles "lifted black" tape encodings (e.g. JCU tapes with luminance 14–27).
- `build_segments()` — detects slugs, tags scenes with `black_slug`, groups consecutive non-slug scenes into `content` segments and slug scenes into `boundary` segments. Auto-numbers content segments sequentially ("Segment 1", "Segment 2", ...) with a `segment_index` field (1, 2, 3, ...) and names boundary segments "Boundary".
- `build_segments_from_tags()` — alternative detection method that uses existing `black_slug` tags as dividers instead of running luminance analysis. Useful when tags have been manually curated.
- `rename_segment()` — rename a segment's display name.
- `update_segment_description()` — update a segment's description field. Persists to `scenes.json`.
- `assign_item_to_segment()` — link a catalog item to a segment (1:1). Stores `item_id` on the segment object in `scenes.json`.
- `clear_segments()` — removes segment grouping data from `scenes.json`. Scene tags (including `black_slug`) are preserved. Requires user confirmation via modal.
- On-demand, not automatic — user triggers detection from a modal offering two methods: scene analysis (luminance) or by existing slug tags.
- Segments stored directly in `scenes.json` as a top-level `segments` array with `segment_id`, `segment_index`, `type` (`content`/`boundary`), `name`, `description` (editable, auto-populated from VLM), `item_id` (optional catalog link), `scene_ids`, `start`, `end`, `vlm_analysis` (optional). Scene `tags` array is per-scene metadata.

**Transcript editing** (`pipeline/video/router.py`)

- **Inline transcript editor**: Toggle a "Transcript" panel in the scene/segment preview to view and edit transcript segments overlapping the current time range. Click segment text to edit inline, press Enter to save. Delete segments with ✕. Changes persist immediately to `transcript.json`.
- **Subtitle overlay**: When `transcript.json` exists, subtitles display automatically on the video player during playback, synced to scene/segment time bounds. Subtitles update in real-time after transcript edits.
- **Click-to-seek**: Click a transcript segment's timestamp to jump the video to that position.
- **Timestamp editing**: Double-click a transcript segment's start or end timestamp to edit it inline. Accepts `mm:ss` or `mm:ss.d` format. Persists to `transcript.json`.

**VLM segment analysis** (`pipeline/video/vlm.py`)

On-demand visual understanding of segments via Ollama multimodal models. A modular module designed for reuse at scene or segment level.

- `analyze_segment()` — collects keyframes (capped at 6, evenly sampled), transcript text overlapping the segment's time range, and metadata (name, type, duration, scene count). Sends as a multimodal prompt to Ollama and persists the result.
- `_ollama_chat()` — wraps the Ollama `/api/chat` endpoint with base64 image support. Uses stdlib `urllib` (no extra dependencies).
- Default model: **Gemma 4 E4B** via Ollama (multimodal, ~9 GB). Configurable per-request.
- **Configurable system prompt**: Sets the VLM's role and context framing (default: 1970s–1980s Northeast Ohio broadcast archival). Editable in the VLM settings modal alongside the default user prompt. Both have "Save as default" (persists to `pipeline/video/settings.json`) and "Reset to default" buttons. The backend reads the system prompt from settings at analysis time — not passed per-request.
- Default user prompt is an archival analysis template (visual content, people/locations, era, content type). Fully editable from the UI before each run, with a global default (persisted to `pipeline/video/settings.json`) and per-segment overrides.
- **Catalog context injection**: When a segment has a linked catalog item, date, description, and additional notes from the item are appended to the VLM prompt automatically. This is controlled by an "Include catalog context" checkbox (checked by default) next to the Run VLM button. A "Preview full prompt" toggle shows the final concatenated prompt before sending.
- **VLM-generated titles**: `_make_summary()` now makes a follow-up Ollama call to generate a concise 3-7 word title-case segment title (e.g., "Beach Day at Edgewater Park") instead of truncating the first sentence. Falls back to sentence truncation if Ollama fails.
- **Auto-populates `description`**: When VLM analysis completes, the full analysis text is written to `segment.description`. This field is editable from the UI and persisted independently of the VLM analysis.
- Results stored directly on the segment object in `scenes.json` as `vlm_analysis: { summary, full_analysis, model, prompt, analyzed_at }` plus `description` (editable copy).
- Runs in a background thread (same pattern as ingest/transcribe) with status polling, since inference takes ~1 min per image on Apple Silicon.

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
- `PATCH /videos/{video_id}/scenes/time-range` — update a scene's start/end times
- `PATCH /videos/{video_id}/scenes/tags` — set scene tags from valid tags list
- `POST /videos/{video_id}/scenes/trim` — trim a scene at a timestamp, adjacent scene absorbs the trimmed portion
- `POST /videos/{video_id}/segments/detect` — detect black slugs via luminance analysis and group scenes into segments
- `POST /videos/{video_id}/segments/detect-from-tags` — detect segments using existing `black_slug` tags as dividers
- `PATCH /videos/{video_id}/segments/{segment_id}/rename` — rename a segment
- `PATCH /videos/{video_id}/segments/{segment_id}/description` — update a segment's description
- `PATCH /videos/{video_id}/segments/{segment_id}/assign-item` — assign a catalog item_id to a segment (or `null` to unassign)
- `DELETE /videos/{video_id}/segments` — clear all segment grouping data (preserves scene tags)
- `POST /videos/{video_id}/segments/{segment_id}/analyze` — kick off VLM analysis in background thread, returns `{ status: "started" }`
- `GET /videos/{video_id}/segments/{segment_id}/analyze/status` — poll VLM job status (`running` → `completed` / `failed`)
- `GET /video-list` — merged list of all source videos cross-referenced with ingested runs (scene/transcript status per video)
- `POST /ingest-pipeline` — combined scene detection + transcription in one background thread, with checkboxes to control which steps run
- `GET /ingest-pipeline/{video_id}/status` — unified progress polling for the combined pipeline
- `GET /tags` — list valid scene tags from `pipeline/video/tags.json`
- `PATCH /videos/{video_id}/transcript/segments` — edit or delete transcript segments
- `GET /videos/{video_id}/keyframes/{filename}` — path-traversal-protected JPEG serving

**Settings API** (mounted at `/api`, in `pipeline/server.py`)
- `GET /settings` — read persistent user settings from `data/settings.json`
- `PATCH /settings` — update settings (merge-patch semantics). Currently stores `vlm_default_prompt`.

**Frontend** (`src/views/VideoPipeline/Ingest/index.tsx`)

Two-level master-detail navigation:

- **Level 1 — Unified video list**: Single table showing all source videos cross-referenced with ingested runs. Each row shows filename, size, scene count, transcript segment count, and an action button (View if fully ingested, Ingest with checkboxes for scene detection/transcription, or Transcribe if only scenes exist). Inline progress bar during ingest showing phase labels (probing → detecting → extracting → transcribing → completed).
- **Level 2 — Scene browser**: Three-column layout with back navigation.
  - **Catalog column (20%, toggleable)**: Lists catalog items from `items.json` matching the current video by filename. Each item shows ID, segment assignment badge, description, duration, and classification thread badges. Filter toggle (All/Assigned/Unassigned) for tracking catalog-to-segment linking progress.
  - **Center column (38–55%)**: Compact scene list with thumbnail, checkbox for merge selection, scene ID (double-click to rename), merge status badge, time range (double-click to edit), duration, `black_slug` tag badge, and ✕ unmerge button. Duration filter (min/max seconds) and segment type filter (All/Content/Boundary with counts) for isolating segments. Segment headers as collapsible dividers with name (double-click to rename), ID suffix, type badge, catalog item assignment button, scene count, and time range. Merge action bar at bottom. Toggleable **transcript view** replaces the scene list with full scrollable transcript (cleaned/raw toggle, re-clean, click-to-seek), with Scene/Full Video mode switch.
  - **Right panel (42–45%)**: Scene-scoped video player with subtitle overlay (from `transcript.json`), custom controls (seek bar, play/pause, time display), scene metadata, editable tags (dropdown from `tags.json`), segment info, trim buttons (appear when paused mid-scene), toggleable transcript editor with click-to-seek timestamps, and 3-column keyframe grid with hover ✕ buttons. Segment preview mode shows the full segment range with all member keyframes and contiguity check. In Full Video transcript mode, shows unclamped video player with live transcript captions overlaid.
  - Single-click a row → preview; checkbox click → multi-select for merge; shift-click → range select (file-browser semantics)
  - Click segment header → collapse/expand + segment preview; "Detect Segments" opens a modal with two methods (luminance analysis or by existing slug tags); "Clear Segments" requires confirmation modal warning about data loss; ✦ VLM analyze button on content segments opens inline prompt editor; catalog item assign button on content segments opens dropdown picker. Segment headers display "S{index}" prefix (e.g. "S1 Segment 1").
  - **VLM Analysis panel**: Toggle in segment detail view. Shows full analysis text, model/timestamp metadata, prompt used (collapsible), and re-analyze button. Purple dot indicator on segment bar when analysis exists. "Include catalog context" checkbox controls whether linked catalog item metadata is appended to the prompt. "Preview full prompt" toggle shows the final prompt including any catalog context. VLM prompt settings gear icon opens a modal to edit the global default prompt, with "Save as Default" (persists to disk) and "Apply to All" (also resets per-segment overrides).
  - **Catalog item assignment**: 1:1 link between content segments and catalog items. Assign via dropdown on segment header; assigned item shows as maize badge. Catalog column shows reverse reference (segment name on assigned items). Already-assigned items greyed out in picker.
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
| Sidebar restructure (collapsible with Lucide icons, Catalog Classifier + Video Pipeline + Utility groups) | Done |
| Backend sub-package layout (`pipeline/video/`) wired into existing FastAPI app | Done |
| Stage 1 ingest — ffprobe / PySceneDetect / ffmpeg / audio extraction | Done |
| Stage 1 ingest — `scenes.raw.json` pristine baseline written at ingest time | Done |
| Stage 1 scene merging — two-phase merge model (pending → committed), `merges.json` sidecar, group absorption, contiguity validation, apply-all bakes into `scenes.json`, merged scenes named after first constituent | Done |
| Stage 1 scene editing — inline rename, keyframe deletion, time range editing, scene tagging, scene trimming with adjacent-scene absorption | Done |
| Stage 1 segment detection — black-slug-based segment grouping (dual criterion: luminance + std deviation), detection modal (by scene analysis or by existing tags), segment index numbering, segment rename, catalog item assignment (1:1 link), clear segments with confirmation modal, segment type filter with counts | Done |
| Stage 1 transcript integration — subtitle overlay on video player, toggleable inline transcript editor with edit/delete, click-to-seek timestamps | Done |
| Stage 1 catalog cross-reference — toggleable catalog column showing items matching video by filename, segment assignment badges, assigned/unassigned filter | Done |
| Stage 1 transcript view — full transcript in scene browser (cleaned/raw toggle, re-clean, click-to-seek), Scene/Full Video mode with live subtitle overlay on unclamped video player | Done |
| Stage 1 frontend — three-column master-detail UI (catalog + scene list + preview, with transcript view toggle; merge selection, shift-click range select, scene-scoped video player with subtitles, segment headers, keyframe grid, duration + segment filters, inline rename, tag assignment, trim buttons) | Done |
| Stage 2 Extract — mlx-whisper transcripts (`whisper-large-v3-turbo`, segment-level timestamps, background job + polling, click-to-seek transcript viewer) | Done |
| Stage 2 Extract — transcript cleanup pass (hallucination-phrase drop, adjacent-duplicate dedup, intra-segment word-run collapse; raw + cleaned both persisted; raw/cleaned toggle and `/transcribe/{id}/reclean` endpoint for re-running rules without re-invoking Whisper) | Done |
| VLM segment analysis — on-demand Gemma 4 E4B via Ollama, multimodal (keyframes + transcript + metadata), editable prompt with global default (persisted to `data/settings.json`) and per-segment overrides, optional catalog context injection with preview, async background job with polling, results in segment bar + detail panel | Done |
| Unified ingest pipeline — combined scene detection + transcription in one job with phase progress, unified video list with status indicators | Done |
| Persistent settings — `data/settings.json` via `GET/PATCH /api/settings`, currently stores VLM default prompt | Done |
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

VLM segment analysis requires [Ollama](https://ollama.com/) with a vision-capable model:

```bash
brew install ollama          # macOS
ollama pull gemma4:e4b       # ~9 GB, multimodal (text + image)
ollama serve                 # starts on http://localhost:11434
```

The Vite dev server proxies `/api` requests to the backend.

### Entity Merging

The LLM extracts entities per-item independently, so the same entity often appears with different surface forms (e.g., "RTA" vs "Regional Transit Authority"). The Entity Browser supports:

- **Multi-merge**: Select 2+ entities, set a canonical name, and merge. All `item_ids` combine under the canonical entry.
- **Suggested merges**: Auto-detected candidates via substring, abbreviation, prefix, and normalization matching. One-click accept or dismiss.
- **Single-name resolution**: A queue of people entities with single names (e.g., "Nader") that can be resolved to full names (e.g., "Ralph Nader").

Merges are stored as overlay edits in `data/runs/catalog/<run>/edits.json` and never modify the original LLM output (`classifications.json`). They are applied when rebuilding the entity index and during export.

## Data

Source items are in `public/data/source/items.json`. Classification outputs are saved to `data/runs/catalog/<run-name>/`.

Note: The source file contains 14,242 rows but 161 are duplicates (same container-item ID), yielding 14,081 unique items.

# NEOBA Archive Classifier

LLM-powered classification and entity extraction tool for the NEOBA (Northeast Ohio Broadcast Archives) collection. Processes 14,000+ archival news items through a three-tier pipeline: LLM classification, entity extraction, and semantic clustering.

## Architecture

- **Frontend**: React + TypeScript + Vite + Tailwind CSS + TanStack Table
- **Backend**: FastAPI (Python) with Claude API for classification
- **Pipeline**: Batch classification with stop/resume support

### Frontend Views

| View | Description |
|------|-------------|
| Run Classification | Execute Tier 1+2 (LLM) and Tier 3 (clustering) with progress tracking |
| Review Table | Browse, search, and filter classified items with inline detail panels |
| Proposed Threads | Review LLM-suggested threads with accept, reject, merge, and remap actions |
| Entity Browser | Explore extracted entities with merge support, suggested merges, and single-name resolution |
| Cluster Explorer | Visualize semantic clusters (UMAP + HDBSCAN) |
| Cryptic Queue | Items flagged as cryptic for manual review |
| Export | Export classifications in various formats |

### Pipeline (Tier 1+2+3)

1. **Tier 1+2** (LLM): Claude classifies items into threads and extracts entities (people, places, organizations, event types) in batches
2. **Tier 3** (Clustering): TF-IDF + UMAP + HDBSCAN for semantic grouping

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

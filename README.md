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
| Entity Browser | Explore extracted people, places, and organizations |
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

## Data

Source items are in `public/data/source/items.json`. Classification outputs are saved to `data/runs/<run-name>/`.

Note: The source file contains 14,242 rows but 161 are duplicates (same container-item ID), yielding 14,081 unique items.

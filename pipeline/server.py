"""FastAPI server for the NEOBA Archive Classifier."""

import json
import os
import sys
import threading
import time
from pathlib import Path

# Make `pipeline.*` importable when this file is launched directly
# (`python pipeline/server.py`) from any cwd.
BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

load_dotenv(BASE_DIR / ".env", override=True)
DATA_DIR = BASE_DIR / "data"

app = FastAPI(title="NEOBA Archive Classifier API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Video pipeline routes (Stage 1+ live under pipeline/video/)
from pipeline.video.router import router as video_router  # noqa: E402
app.include_router(video_router)

# Track running jobs
running_jobs: dict[str, dict] = {}


# --- Models ---

class ClassifyRequest(BaseModel):
    model: str = "claude-haiku-4-5-20251001"
    batch_size: int = 50
    include_notes: bool = True
    run_name: str | None = None


class EditRequest(BaseModel):
    item_id: str | None = None
    type: str | None = None
    field: str | None = None
    old_value: object = None
    new_value: object = None
    name: str | None = None
    action: str | None = None
    merge_into: str | None = None
    timestamp: str | None = None
    # Entity merge fields
    source_entities: list[str] | None = None
    target_entity: str | None = None
    entity_type: str | None = None


# --- Helpers ---

def get_latest_run() -> str | None:
    runs_dir = DATA_DIR / "runs" / "catalog"
    if not runs_dir.exists():
        return None
    runs = sorted([d.name for d in runs_dir.iterdir() if d.is_dir()], reverse=True)
    return runs[0] if runs else None


def get_run_dir(run_id: str) -> Path:
    if run_id == "latest":
        latest = get_latest_run()
        if not latest:
            raise HTTPException(404, "No runs found")
        run_id = latest
    run_dir = DATA_DIR / "runs" / "catalog" / run_id
    if not run_dir.exists():
        raise HTTPException(404, f"Run not found: {run_id}")
    return run_dir


# --- Source Data ---

@app.get("/api/source/items")
async def get_source_items():
    source_file = BASE_DIR / "public" / "data" / "source" / "items.json"
    if not source_file.exists():
        raise HTTPException(404, "Source items.json not found")
    with open(source_file) as f:
        return json.load(f)


# --- Runs ---

@app.get("/api/runs")
async def list_runs():
    runs_dir = DATA_DIR / "runs" / "catalog"
    if not runs_dir.exists():
        return []
    result = []
    for d in sorted(runs_dir.iterdir(), reverse=True):
        if d.is_dir():
            meta_file = d / "metadata.json"
            if meta_file.exists():
                with open(meta_file) as f:
                    result.append(json.load(f))
            else:
                result.append({"run_name": d.name, "status": "unknown"})
    return result


@app.post("/api/run/classify")
async def start_classification(req: ClassifyRequest):
    from pipeline.classify import run_classification

    run_name = req.run_name or time.strftime("%Y-%m-%d")

    if run_name in running_jobs and running_jobs[run_name].get("status") == "running":
        raise HTTPException(409, "Classification already running for this run")

    running_jobs[run_name] = {
        "status": "running",
        "batches_completed": 0,
        "batches_total": 0,
        "errors": 0,
        "error_messages": [],
    }

    def run_in_background():
        def progress_callback(completed, total, errors, error_details=None):
            running_jobs[run_name].update({
                "batches_completed": completed,
                "batches_total": total,
                "errors": errors,
                "error_messages": error_details or [],
            })

        try:
            result = run_classification(
                run_name=run_name,
                model=req.model,
                batch_size=req.batch_size,
                include_notes=req.include_notes,
                progress_callback=progress_callback,
            )
            running_jobs[run_name]["status"] = result.get("status", "completed")

            # Run postprocessing if we have results
            if result.get("classified_items", 0) > 0:
                from pipeline.postprocess import build_entity_index
                build_entity_index(run_name)
        except Exception as e:
            running_jobs[run_name]["status"] = "failed"
            running_jobs[run_name]["error"] = str(e)

    thread = threading.Thread(target=run_in_background, daemon=True)
    thread.start()

    return {"run_id": run_name, "status": "started"}


@app.post("/api/run/{run_id}/stop")
async def stop_classification(run_id: str):
    from pipeline.classify import request_stop

    if run_id == "latest":
        run_id = get_latest_run() or ""
    if not run_id:
        raise HTTPException(404, "No runs found")

    if run_id in running_jobs and running_jobs[run_id].get("status") == "running":
        request_stop(run_id)
        running_jobs[run_id]["status"] = "stopping"
        return {"status": "stopping", "run_id": run_id}

    raise HTTPException(400, "No running classification to stop")


@app.post("/api/run/{run_id}/retry-unclassified")
async def retry_unclassified(run_id: str, req: ClassifyRequest):
    from pipeline.classify import run_classification_subset

    if run_id == "latest":
        run_id = get_latest_run() or ""
    if not run_id:
        raise HTTPException(404, "No runs found")

    if run_id in running_jobs and running_jobs[run_id].get("status") == "running":
        raise HTTPException(409, "Classification already running for this run")

    # Find unclassified item IDs
    run_dir = get_run_dir(run_id)
    cls_file = run_dir / "classifications.json"
    classified_ids = set()
    if cls_file.exists():
        with open(cls_file) as f:
            for item in json.load(f):
                classified_ids.add(item.get("item_id"))

    from pipeline.classify import load_source_items
    all_items = load_source_items()
    unclassified = [it for it in all_items if f"{it.get('container')}-{it.get('item')}" not in classified_ids]

    if not unclassified:
        return {"run_id": run_id, "status": "nothing_to_retry", "unclassified": 0}

    running_jobs[run_id] = {
        "status": "running",
        "batches_completed": 0,
        "batches_total": 0,
        "errors": 0,
        "error_messages": [],
    }

    def run_in_background():
        def progress_callback(completed, total, errors, error_details=None):
            running_jobs[run_id].update({
                "batches_completed": completed,
                "batches_total": total,
                "errors": errors,
                "error_messages": error_details or [],
            })

        try:
            result = run_classification_subset(
                run_name=run_id,
                items=unclassified,
                model=req.model,
                batch_size=req.batch_size,
                include_notes=req.include_notes,
                progress_callback=progress_callback,
            )
            running_jobs[run_id]["status"] = result.get("status", "completed")

            if result.get("classified_items", 0) > 0:
                from pipeline.postprocess import build_entity_index
                build_entity_index(run_id)
        except Exception as e:
            running_jobs[run_id]["status"] = "failed"
            running_jobs[run_id]["error"] = str(e)

    thread = threading.Thread(target=run_in_background, daemon=True)
    thread.start()

    return {"run_id": run_id, "status": "started", "unclassified": len(unclassified)}


@app.get("/api/run/{run_id}/status")
async def get_run_status(run_id: str):
    if run_id in running_jobs and running_jobs[run_id].get("status") in ("running", "stopping"):
        return running_jobs[run_id]

    # Clean up stale in-memory entries
    if run_id in running_jobs:
        del running_jobs[run_id]

    run_dir = get_run_dir(run_id)
    meta_file = run_dir / "metadata.json"
    if meta_file.exists():
        with open(meta_file) as f:
            meta = json.load(f)
        return {
            "status": meta.get("status", "completed"),
            "batches_completed": meta.get("total_batches", 0),
            "batches_total": meta.get("total_batches", 0),
            "errors": len(meta.get("errors", [])),
            "error_messages": meta.get("errors", []),
            "classified_items": meta.get("classified_items", 0),
            "total_items": meta.get("total_items", 0),
            "unclassified": max(0, meta.get("total_items", 0) - meta.get("classified_items", 0)),
        }
    raise HTTPException(404, "Run status not found")


@app.post("/api/run/{run_id}/cluster")
async def start_clustering(run_id: str):
    from pipeline.cluster import run_clustering

    if run_id == "latest":
        run_id = get_latest_run() or ""
    if not run_id:
        raise HTTPException(404, "No runs found")

    cluster_key = f"{run_id}:cluster"
    if cluster_key in running_jobs and running_jobs[cluster_key].get("status") == "running":
        raise HTTPException(409, "Clustering already running for this run")

    running_jobs[cluster_key] = {"status": "running"}

    def run_in_background():
        try:
            run_clustering(run_id)
            running_jobs[cluster_key]["status"] = "completed"
        except Exception as e:
            running_jobs[cluster_key]["status"] = "failed"
            running_jobs[cluster_key]["error"] = str(e)
            print(f"Clustering error: {e}")

    thread = threading.Thread(target=run_in_background, daemon=True)
    thread.start()

    return {"status": "started", "run_id": run_id}


# --- Classifications ---

@app.get("/api/run/{run_id}/classifications")
async def get_classifications(run_id: str):
    run_dir = get_run_dir(run_id)
    cls_file = run_dir / "classifications.json"
    if not cls_file.exists():
        return []
    with open(cls_file) as f:
        return json.load(f)


# --- Entities ---

@app.get("/api/run/{run_id}/entities")
async def get_entities(run_id: str):
    run_dir = get_run_dir(run_id)
    entity_file = run_dir / "entity_index.json"
    if not entity_file.exists():
        # Try building it
        from pipeline.postprocess import build_entity_index
        actual_run = run_id if run_id != "latest" else (get_latest_run() or "")
        return build_entity_index(actual_run)
    with open(entity_file) as f:
        return json.load(f)


# --- Clusters ---

@app.get("/api/run/{run_id}/clusters")
async def get_clusters(run_id: str):
    run_dir = get_run_dir(run_id)
    cluster_file = run_dir / "clusters.json"
    if not cluster_file.exists():
        raise HTTPException(404, "Cluster data not found. Run clustering first.")
    with open(cluster_file) as f:
        return json.load(f)


@app.get("/api/run/{run_id}/cluster/status")
async def get_cluster_status(run_id: str):
    if run_id == "latest":
        run_id = get_latest_run() or ""
    if not run_id:
        raise HTTPException(404, "No runs found")
    cluster_key = f"{run_id}:cluster"
    if cluster_key in running_jobs:
        return running_jobs[cluster_key]
    run_dir = get_run_dir(run_id)
    if (run_dir / "clusters.json").exists():
        return {"status": "completed"}
    return {"status": "idle"}


# --- Proposed Threads ---

@app.get("/api/run/{run_id}/threads")
async def get_threads(run_id: str):
    """Return all active thread names: the 11 defined + any accepted proposed threads."""
    DEFINED_THREADS = [
        'Crime & Safety', 'Sports', 'Weather', 'Politics & Government',
        'Economy & Labor', 'Schools & Education', 'Health & Medicine',
        'Culture & Arts', 'Community & Neighborhoods',
        'Daily Life & Human Interest', 'Media & Broadcasting',
    ]
    run_dir = get_run_dir(run_id)
    cls_file = run_dir / "classifications.json"
    extra = set()
    if cls_file.exists():
        with open(cls_file) as f:
            classifications = json.load(f)
        for cls in classifications:
            for t in cls.get("threads", []):
                name = t.get("name", "")
                if name and name not in DEFINED_THREADS:
                    extra.add(name)
    return DEFINED_THREADS + sorted(extra)


@app.get("/api/run/{run_id}/proposed-threads")
async def get_proposed_threads(run_id: str):
    from pipeline.postprocess import aggregate_proposed_threads
    actual_run = run_id if run_id != "latest" else (get_latest_run() or "")
    if not actual_run:
        return []
    return aggregate_proposed_threads(actual_run)


# --- Cryptic Queue ---

@app.get("/api/run/{run_id}/cryptic")
async def get_cryptic_items(run_id: str):
    from pipeline.postprocess import get_cryptic_items
    actual_run = run_id if run_id != "latest" else (get_latest_run() or "")
    if not actual_run:
        return []
    return get_cryptic_items(actual_run)


# --- Edits ---

@app.post("/api/run/{run_id}/edits")
async def save_edit(run_id: str, edit: EditRequest):
    run_dir = get_run_dir(run_id)
    edits_file = run_dir / "edits.json"

    edits = []
    if edits_file.exists():
        with open(edits_file) as f:
            edits = json.load(f)

    edit_data = edit.model_dump()
    edit_data["timestamp"] = edit_data.get("timestamp") or time.strftime("%Y-%m-%dT%H:%M:%S")
    edits.append(edit_data)

    with open(edits_file, "w") as f:
        json.dump(edits, f, indent=2)

    # For merge/remap actions, update classifications
    DEFINED_THREADS = [
        'Crime & Safety', 'Sports', 'Weather', 'Politics & Government',
        'Economy & Labor', 'Schools & Education', 'Health & Medicine',
        'Culture & Arts', 'Community & Neighborhoods',
        'Daily Life & Human Interest', 'Media & Broadcasting',
    ]
    # For accept: clear proposed_thread and add the thread name to threads array
    if edit.type == "proposed_thread" and edit.action == "accept" and edit.name:
        cls_file = run_dir / "classifications.json"
        if cls_file.exists():
            with open(cls_file) as f:
                classifications = json.load(f)
            updated = False
            for cls in classifications:
                if cls.get("proposed_thread") == edit.name:
                    cls["proposed_thread"] = None
                    existing_names = [t["name"] for t in cls.get("threads", [])]
                    if edit.name not in existing_names:
                        cls.setdefault("threads", []).append({
                            "name": edit.name,
                            "confidence": "high",
                        })
                    updated = True
            if updated:
                with open(cls_file, "w") as f:
                    json.dump(classifications, f, indent=2)

    # For reject: clear proposed_thread on matching items (they become unclassified)
    if edit.type == "proposed_thread" and edit.action == "reject" and edit.name:
        cls_file = run_dir / "classifications.json"
        if cls_file.exists():
            with open(cls_file) as f:
                classifications = json.load(f)
            updated = False
            for cls in classifications:
                if cls.get("proposed_thread") == edit.name:
                    cls["proposed_thread"] = None
                    updated = True
            if updated:
                with open(cls_file, "w") as f:
                    json.dump(classifications, f, indent=2)

    if edit.type == "proposed_thread" and edit.action in ("merge", "remap") and edit.merge_into and edit.name:
        cls_file = run_dir / "classifications.json"
        if cls_file.exists():
            with open(cls_file) as f:
                classifications = json.load(f)
            is_defined = edit.merge_into in DEFINED_THREADS
            updated = False
            for cls in classifications:
                if cls.get("proposed_thread") == edit.name:
                    if is_defined:
                        # Remapping to a defined thread: clear proposed_thread,
                        # add the thread to the threads array
                        cls["proposed_thread"] = None
                        existing_names = [t["name"] for t in cls.get("threads", [])]
                        if edit.merge_into not in existing_names:
                            cls.setdefault("threads", []).append({
                                "name": edit.merge_into,
                                "confidence": "high",
                            })
                    else:
                        # Merging into another proposed thread
                        cls["proposed_thread"] = edit.merge_into
                    updated = True
            if updated:
                with open(cls_file, "w") as f:
                    json.dump(classifications, f, indent=2)

    # For entity_merge: rebuild entity index to reflect the merge
    if edit.type == "entity_merge" and edit.source_entities and edit.target_entity:
        from pipeline.postprocess import build_entity_index
        actual_run = run_id if run_id != "latest" else (get_latest_run() or "")
        if actual_run:
            build_entity_index(actual_run)

    return {"status": "saved", "total_edits": len(edits)}


# --- Entity Merge Suggestions ---

@app.get("/api/run/{run_id}/entity-merge-suggestions")
async def get_entity_merge_suggestions(run_id: str):
    from pipeline.postprocess import suggest_entity_merges
    actual_run = run_id if run_id != "latest" else (get_latest_run() or "")
    if not actual_run:
        return []
    return suggest_entity_merges(actual_run)


@app.get("/api/run/{run_id}/entity-single-names")
async def get_entity_single_names(run_id: str):
    from pipeline.postprocess import get_single_name_entities
    actual_run = run_id if run_id != "latest" else (get_latest_run() or "")
    if not actual_run:
        return []
    return get_single_name_entities(actual_run)


# --- Export ---

@app.get("/api/run/{run_id}/export-summary")
async def get_export_summary(run_id: str):
    run_dir = get_run_dir(run_id)
    cls_file = run_dir / "classifications.json"

    if not cls_file.exists():
        raise HTTPException(404, "No classifications found")

    with open(cls_file) as f:
        classifications = json.load(f)

    with open(BASE_DIR / "public" / "data" / "source" / "items.json") as f:
        source_items = json.load(f)

    # Build summary
    thread_counts: dict[str, int] = {}
    entities_people = set()
    entities_places = set()
    entities_orgs = set()

    for cls in classifications:
        if cls.get("threads"):
            for t in cls["threads"]:
                thread_counts[t["name"]] = thread_counts.get(t["name"], 0) + 1
        for p in cls.get("entities", {}).get("people", []):
            entities_people.add(p)
        for p in cls.get("entities", {}).get("places", []):
            entities_places.add(p)
        for o in cls.get("entities", {}).get("organizations", []):
            entities_orgs.add(o)

    classified = sum(1 for c in classifications if c.get("threads"))
    edits_file = run_dir / "edits.json"
    edit_count = 0
    if edits_file.exists():
        with open(edits_file) as f:
            edit_count = len(json.load(f))

    cluster_file = run_dir / "clusters.json"
    cluster_count = 0
    if cluster_file.exists():
        with open(cluster_file) as f:
            cluster_count = len(json.load(f).get("clusters", []))

    return {
        "total_items": len(source_items),
        "classified_items": classified,
        "unclassified_items": len(source_items) - classified,
        "thread_counts": thread_counts,
        "entity_counts": {
            "people": len(entities_people),
            "places": len(entities_places),
            "organizations": len(entities_orgs),
        },
        "cluster_count": cluster_count,
        "human_overrides": edit_count,
        "keyword_baseline_agreement": 0,  # Computed on demand
    }


@app.post("/api/run/{run_id}/export")
async def run_export(run_id: str):
    from pipeline.export import export_enriched_data
    actual_run = run_id if run_id != "latest" else (get_latest_run() or "")
    if not actual_run:
        raise HTTPException(404, "No runs found")
    result = export_enriched_data(actual_run)
    return result


# --- Settings ---

SETTINGS_FILE = BASE_DIR / "pipeline" / "video" / "settings.json"


def _load_settings() -> dict:
    if SETTINGS_FILE.exists():
        return json.loads(SETTINGS_FILE.read_text())
    return {}


def _save_settings(settings: dict) -> None:
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(settings, indent=2))


@app.get("/api/settings")
async def get_settings():
    return _load_settings()


@app.patch("/api/settings")
async def update_settings(body: dict):
    settings = _load_settings()
    settings.update(body)
    _save_settings(settings)
    return settings


# --- Main ---

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

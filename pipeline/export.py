"""Export enriched data for the NEOBA Archive Explorer dashboard."""

import csv
import json
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"


def merge_edits(classifications: list[dict], edits: list[dict]) -> list[dict]:
    """Apply human edits on top of LLM classifications."""
    edit_map: dict[str, list[dict]] = {}
    for edit in edits:
        iid = edit.get("item_id", "")
        if iid not in edit_map:
            edit_map[iid] = []
        edit_map[iid].append(edit)

    merged = []
    for cls in classifications:
        item = dict(cls)
        for edit in edit_map.get(item["item_id"], []):
            field = edit.get("field", "")
            if field == "threads":
                item["threads"] = edit["new_value"]
            elif field == "genre":
                item["genre"] = edit["new_value"]
            elif field == "decode_note":
                item["decode_note"] = edit["new_value"]
        merged.append(item)

    return merged


def export_enriched_data(run_name: str) -> dict:
    """Generate all export files for the dashboard."""
    run_dir = DATA_DIR / "runs" / run_name
    export_dir = DATA_DIR / "exports"
    export_dir.mkdir(parents=True, exist_ok=True)

    # Load source items
    with open(BASE_DIR / "public" / "data" / "source" / "items.json") as f:
        source_items = json.load(f)
    source_map = {f"{s['container']}-{s['item']}": s for s in source_items}

    # Load classifications
    cls_file = run_dir / "classifications.json"
    if not cls_file.exists():
        raise FileNotFoundError(f"No classifications found for run: {run_name}")

    with open(cls_file) as f:
        classifications = json.load(f)

    # Load edits
    edits_file = run_dir / "edits.json"
    edits = []
    if edits_file.exists():
        with open(edits_file) as f:
            edits = json.load(f)

    # Merge
    merged = merge_edits(classifications, edits)
    cls_map = {c["item_id"]: c for c in merged}

    # Build items-enriched.json
    items_enriched = []
    for source in source_items:
        item_id = f"{source['container']}-{source['item']}"
        cls = cls_map.get(item_id)

        enriched = dict(source)
        enriched["thread_keyword_baseline"] = source.get("thread", "Unclassified")

        if cls:
            # Primary thread (backward compatible single label)
            if cls["threads"]:
                enriched["thread"] = cls["threads"][0]["name"]
            else:
                enriched["thread"] = "Unclassified"

            # Full thread array
            enriched["threads"] = cls["threads"]
            enriched["proposed_thread"] = cls.get("proposed_thread")
            enriched["entities"] = cls.get("entities", {})
            enriched["genre"] = cls.get("genre", "unknown")
            enriched["is_cryptic"] = cls.get("is_cryptic", False)
            enriched["decode_note"] = cls.get("decode_note")
        else:
            enriched["threads"] = []
            enriched["entities"] = {"people": [], "places": [], "organizations": [], "event_type": None}
            enriched["genre"] = "unknown"
            enriched["is_cryptic"] = False

        items_enriched.append(enriched)

    # Write items-enriched.json
    with open(export_dir / "items-enriched.json", "w") as f:
        json.dump(items_enriched, f)

    # Write archive-data-enriched.json (summary format for dashboard)
    thread_counts: dict[str, int] = {}
    for item in items_enriched:
        t = item.get("thread", "Unclassified")
        thread_counts[t] = thread_counts.get(t, 0) + 1

    archive_data = {
        "total_items": len(items_enriched),
        "thread_counts": thread_counts,
        "items": items_enriched,
    }
    with open(export_dir / "archive-data-enriched.json", "w") as f:
        json.dump(archive_data, f)

    # Copy entity index
    entity_file = run_dir / "entity_index.json"
    if entity_file.exists():
        with open(entity_file) as f:
            entity_data = json.load(f)
        with open(export_dir / "entity_index.json", "w") as f:
            json.dump(entity_data, f)

    # Copy clusters
    cluster_file = run_dir / "clusters.json"
    if cluster_file.exists():
        with open(cluster_file) as f:
            cluster_data = json.load(f)
        with open(export_dir / "clusters.json", "w") as f:
            json.dump(cluster_data, f)

    # Export cryptic terms CSV
    cryptic = [item for item in items_enriched if item.get("is_cryptic")]
    with open(export_dir / "cryptic_terms.csv", "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["item_id", "description", "decode_note", "date", "container"])
        for item in cryptic:
            writer.writerow([
                f"{item['container']}-{item['item']}",
                item["description"],
                item.get("decode_note", ""),
                item.get("date", ""),
                item.get("container", ""),
            ])

    return {
        "total_items": len(items_enriched),
        "classified_items": sum(1 for i in items_enriched if i.get("thread") != "Unclassified"),
        "unclassified_items": sum(1 for i in items_enriched if i.get("thread") == "Unclassified"),
        "thread_counts": thread_counts,
        "entity_counts": {
            "people": len(set(
                name
                for item in items_enriched
                for name in item.get("entities", {}).get("people", [])
            )),
            "places": len(set(
                name
                for item in items_enriched
                for name in item.get("entities", {}).get("places", [])
            )),
            "organizations": len(set(
                name
                for item in items_enriched
                for name in item.get("entities", {}).get("organizations", [])
            )),
        },
        "cluster_count": len(json.load(open(cluster_file))) if cluster_file.exists() else 0,
        "human_overrides": len(edits),
    }


if __name__ == "__main__":
    import sys
    import time

    run_name = sys.argv[1] if len(sys.argv) > 1 else time.strftime("%Y-%m-%d")
    result = export_enriched_data(run_name)
    print(f"Exported: {result['classified_items']} classified, {result['unclassified_items']} unclassified")

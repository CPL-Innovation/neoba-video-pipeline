"""Post-processing: Entity index, proposed thread aggregation, cryptic queue."""

import json
from collections import Counter, defaultdict
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"


def build_entity_index(run_name: str) -> list[dict]:
    """Build deduplicated entity index from classifications."""
    run_dir = DATA_DIR / "runs" / run_name
    cls_file = run_dir / "classifications.json"

    if not cls_file.exists():
        return []

    with open(cls_file) as f:
        classifications = json.load(f)

    entities: dict[str, dict] = {}

    for cls in classifications:
        item_id = cls["item_id"]
        for entity_type in ["people", "places", "organizations"]:
            for name in cls.get("entities", {}).get(entity_type, []):
                name_lower = name.lower().strip()
                if name_lower not in entities:
                    entities[name_lower] = {
                        "name": name,  # Keep original casing from first occurrence
                        "type": entity_type,
                        "count": 0,
                        "item_ids": [],
                    }
                entities[name_lower]["count"] += 1
                entities[name_lower]["item_ids"].append(item_id)

    result = sorted(entities.values(), key=lambda e: -e["count"])

    with open(run_dir / "entity_index.json", "w") as f:
        json.dump(result, f, indent=2)

    return result


def aggregate_proposed_threads(run_name: str) -> list[dict]:
    """Aggregate proposed threads from classifications."""
    run_dir = DATA_DIR / "runs" / run_name
    cls_file = run_dir / "classifications.json"

    if not cls_file.exists():
        return []

    with open(cls_file) as f:
        classifications = json.load(f)

    # Load source items for descriptions
    with open(BASE_DIR / "public" / "data" / "source" / "items.json") as f:
        source_items = json.load(f)
    desc_map = {f"{s['container']}-{s['item']}": s["description"] for s in source_items}

    proposals: dict[str, list[str]] = defaultdict(list)
    for cls in classifications:
        if cls.get("proposed_thread"):
            proposals[cls["proposed_thread"]].append(cls["item_id"])

    # Group similar proposals (basic: lowercase match)
    normalized: dict[str, list[str]] = defaultdict(list)
    for name in proposals:
        normalized[name.lower().strip()].append(name)

    result = []
    for norm_name, variants in normalized.items():
        primary = max(variants, key=lambda v: len(proposals[v]))
        all_item_ids = []
        for v in variants:
            all_item_ids.extend(proposals[v])

        samples = [desc_map.get(iid, "") for iid in all_item_ids]
        similar = [v for v in variants if v != primary]

        # Load edits to check status
        edits_file = run_dir / "edits.json"
        edits = []
        if edits_file.exists():
            with open(edits_file) as f:
                edits = json.load(f)

        status = "pending"
        merged_into = None
        for edit in edits:
            if edit.get("type") == "proposed_thread" and edit.get("name") == primary:
                action = edit.get("action", "pending")
                # accept is no longer a terminal state — classifications are
                # updated on merge/remap, so the canonical thread stays pending
                # and can be further merged or remapped
                if action == "accept":
                    continue
                status = action
                merged_into = edit.get("merge_into")

        result.append({
            "name": primary,
            "count": len(all_item_ids),
            "sample_descriptions": samples,
            "similar_proposals": similar,
            "status": status,
            "merged_into": merged_into,
        })

    # Consolidate merged threads into their targets
    merged = [r for r in result if r["status"] == "merge" and r["merged_into"]]
    for m in merged:
        target = next((r for r in result if r["name"] == m["merged_into"]), None)
        if target:
            target["count"] += m["count"]
            target["sample_descriptions"] = target["sample_descriptions"] + m["sample_descriptions"]
        else:
            # Target is a new canonical name — create an entry for it
            result.append({
                "name": m["merged_into"],
                "count": m["count"],
                "sample_descriptions": list(m["sample_descriptions"]),
                "similar_proposals": [m["name"]],
                "status": "pending",
                "merged_into": None,
            })

    # Remove merged and remapped threads from result
    result = [r for r in result if r["status"] not in ("merge", "remap")]

    result.sort(key=lambda x: -x["count"])
    return result


def get_cryptic_items(run_name: str) -> list[dict]:
    """Get all cryptic items with source metadata."""
    run_dir = DATA_DIR / "runs" / run_name
    cls_file = run_dir / "classifications.json"

    if not cls_file.exists():
        return []

    with open(cls_file) as f:
        classifications = json.load(f)

    with open(BASE_DIR / "public" / "data" / "source" / "items.json") as f:
        source_items = json.load(f)
    source_map = {f"{s['container']}-{s['item']}": s for s in source_items}

    cryptic = []
    for cls in classifications:
        if cls.get("is_cryptic"):
            source = source_map.get(cls["item_id"], {})
            cryptic.append({
                **cls,
                "description": source.get("description", ""),
                "date": source.get("date"),
                "container": source.get("container"),
            })

    return cryptic


if __name__ == "__main__":
    import sys
    import time

    run_name = sys.argv[1] if len(sys.argv) > 1 else time.strftime("%Y-%m-%d")
    entities = build_entity_index(run_name)
    proposals = aggregate_proposed_threads(run_name)
    cryptic = get_cryptic_items(run_name)
    print(f"Entities: {len(entities)}, Proposed threads: {len(proposals)}, Cryptic items: {len(cryptic)}")

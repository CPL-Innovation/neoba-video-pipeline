"""Post-processing: Entity index, proposed thread aggregation, cryptic queue."""

import json
import re
from collections import Counter, defaultdict
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"


def _load_entity_merges(run_dir: Path) -> list[dict]:
    """Load entity_merge edits from edits.json, in chronological order."""
    edits_file = run_dir / "edits.json"
    if not edits_file.exists():
        return []
    with open(edits_file) as f:
        edits = json.load(f)
    return [e for e in edits if e.get("type") == "entity_merge"]


def _apply_entity_merges(entities: dict[str, dict], merges: list[dict]) -> dict[str, dict]:
    """Apply entity merge edits to the entity dict (keyed by lowercase name).

    Processes merges in chronological order so transitive chains resolve correctly.
    """
    for merge in merges:
        source_names = merge.get("source_entities", [])
        target_name = merge.get("target_entity", "")
        if not target_name or not source_names:
            continue

        target_lower = target_name.lower().strip()

        # Ensure target entry exists
        if target_lower not in entities:
            entities[target_lower] = {
                "name": target_name,
                "type": merge.get("entity_type", "people"),
                "count": 0,
                "item_ids": [],
            }
        else:
            # Update display name to the canonical form
            entities[target_lower]["name"] = target_name

        # Move item_ids from each source into target
        for src in source_names:
            src_lower = src.lower().strip()
            if src_lower in entities and src_lower != target_lower:
                entities[target_lower]["item_ids"].extend(entities[src_lower]["item_ids"])
                del entities[src_lower]

        # Deduplicate item_ids and recompute count
        entities[target_lower]["item_ids"] = list(dict.fromkeys(entities[target_lower]["item_ids"]))
        entities[target_lower]["count"] = len(entities[target_lower]["item_ids"])

    return entities


def build_entity_index(run_name: str) -> list[dict]:
    """Build deduplicated entity index from classifications, with merge overlay."""
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

    # Apply entity merges from edits.json
    merges = _load_entity_merges(run_dir)
    if merges:
        entities = _apply_entity_merges(entities, merges)

    result = sorted(entities.values(), key=lambda e: -e["count"])

    with open(run_dir / "entity_index.json", "w") as f:
        json.dump(result, f, indent=2)

    return result


def suggest_entity_merges(run_name: str) -> list[dict]:
    """Detect likely merge candidates using substring, abbreviation, and prefix matching."""
    run_dir = DATA_DIR / "runs" / run_name
    entity_file = run_dir / "entity_index.json"

    if not entity_file.exists():
        return []

    with open(entity_file) as f:
        all_entities = json.load(f)

    suggestions = []
    seen_groups: set[str] = set()  # Track already-grouped entities

    for entity_type in ["people", "places", "organizations"]:
        type_entities = [e for e in all_entities if e["type"] == entity_type]

        for i, a in enumerate(type_entities):
            if a["name"] in seen_groups:
                continue
            group = [a["name"]]

            for j, b in enumerate(type_entities):
                if i == j or b["name"] in seen_groups:
                    continue

                a_lower = a["name"].lower().strip()
                b_lower = b["name"].lower().strip()
                a_norm = re.sub(r"[^a-z0-9 ]", "", a_lower).strip()
                b_norm = re.sub(r"[^a-z0-9 ]", "", b_lower).strip()

                match_type = None

                # 1. Normalized match (same after stripping punctuation/case)
                if a_norm == b_norm and a_lower != b_lower:
                    match_type = "normalized"

                # 2. Substring match (shorter is substring of longer, min 3 chars)
                elif len(a_norm) >= 3 and len(b_norm) >= 3:
                    shorter, longer = (a_norm, b_norm) if len(a_norm) < len(b_norm) else (b_norm, a_norm)
                    if shorter != longer and shorter in longer:
                        # For people, only match if shorter is a single word (last name)
                        # to avoid matching "Art" in "Art Modell"
                        if entity_type == "people" and " " not in shorter and len(shorter) < 5:
                            pass  # Skip short first-name-like substrings
                        else:
                            match_type = "substring"

                # 3. Abbreviation match (all-caps vs spelled out)
                if not match_type and a_norm.replace(" ", "").isalpha():
                    abbrev, full = (a, b) if a_norm == a_norm.upper() and len(a_norm) <= 6 else (b, a)
                    abbrev_str = abbrev["name"].strip()
                    full_str = full["name"].strip()
                    if abbrev_str == abbrev_str.upper() and len(abbrev_str) >= 2 and " " in full_str:
                        initials = "".join(w[0] for w in full_str.split() if w).upper()
                        if abbrev_str.upper() == initials:
                            match_type = "abbreviation"

                # 4. Prefix/suffix match
                if not match_type:
                    a_words = a_norm.split()
                    b_words = b_norm.split()
                    if len(a_words) > 0 and len(b_words) > 0 and len(a_words) != len(b_words):
                        shorter_w, longer_w = (a_words, b_words) if len(a_words) < len(b_words) else (b_words, a_words)
                        # Check if shorter is a prefix or suffix of longer
                        if longer_w[:len(shorter_w)] == shorter_w or longer_w[-len(shorter_w):] == shorter_w:
                            if len(shorter_w) >= 2 or (len(shorter_w) == 1 and len(shorter_w[0]) >= 5):
                                match_type = "prefix"

                if match_type and b["name"] not in group:
                    group.append(b["name"])

            if len(group) >= 2:
                for name in group:
                    seen_groups.add(name)
                # Suggest the longest name or highest-count as canonical
                group_entries = [e for e in type_entities if e["name"] in group]
                canonical = max(group_entries, key=lambda e: (len(e["name"]), e["count"]))
                suggestions.append({
                    "entities": [e["name"] for e in sorted(group_entries, key=lambda e: -e["count"])],
                    "counts": {e["name"]: e["count"] for e in group_entries},
                    "suggested_canonical": canonical["name"],
                    "match_type": match_type or "mixed",
                    "total_count": sum(e["count"] for e in group_entries),
                    "entity_type": entity_type,
                })

    suggestions.sort(key=lambda s: -s["total_count"])
    return suggestions


def get_single_name_entities(run_name: str) -> list[dict]:
    """Get people entities that are a single name (no space) with count >= 3."""
    run_dir = DATA_DIR / "runs" / run_name
    entity_file = run_dir / "entity_index.json"

    if not entity_file.exists():
        return []

    with open(entity_file) as f:
        all_entities = json.load(f)

    # Load source items for sample descriptions
    source_file = BASE_DIR / "public" / "data" / "source" / "items.json"
    desc_map: dict[str, str] = {}
    if source_file.exists():
        with open(source_file) as f:
            source_items = json.load(f)
        desc_map = {f"{s['container']}-{s['item']}": s["description"] for s in source_items}

    result = []
    for entity in all_entities:
        if entity["type"] != "people":
            continue
        if " " in entity["name"].strip():
            continue
        if entity["count"] < 3:
            continue

        # Get sample descriptions (up to 5) for context
        samples = [desc_map.get(iid, "") for iid in entity["item_ids"][:5]]
        samples = [s for s in samples if s]

        result.append({
            "name": entity["name"],
            "count": entity["count"],
            "type": entity["type"],
            "item_ids": entity["item_ids"],
            "sample_descriptions": samples,
        })

    result.sort(key=lambda e: -e["count"])
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

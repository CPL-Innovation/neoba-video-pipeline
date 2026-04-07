"""Tier 1+2: LLM Classification + Entity Extraction using Claude API."""

import json
import os
import time
from pathlib import Path
from typing import Any

import anthropic
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env", override=True)

DATA_DIR = BASE_DIR / "data"
SOURCE_FILE = BASE_DIR / "public" / "data" / "source" / "items.json"

# Shared stop flag — set by the server to signal a running classification to halt
_stop_flags: dict[str, bool] = {}


def request_stop(run_name: str):
    _stop_flags[run_name] = True


def clear_stop(run_name: str):
    _stop_flags.pop(run_name, None)


def is_stopped(run_name: str) -> bool:
    return _stop_flags.get(run_name, False)


def load_thread_config() -> dict:
    config_path = Path(__file__).parent / "thread_config.json"
    with open(config_path) as f:
        return json.load(f)

def build_system_prompt(config: dict) -> str:
    thread_list = "\n".join(
        f"- {t['name']}: {t['description']}" for t in config["threads"]
    )
    genre_list = ", ".join(config["genres"])
    event_list = ", ".join(config["event_types"])

    return f"""You are classifying items from the NEOBA broadcast archive — a collection of "Save Tapes" from WEWS (ABC affiliate, Cleveland, Ohio), spanning 1977–1982. These tapes preserve local TV news segments that WEWS producers selected for archival. Each item is a clip or package from a U-matic Save Tape.

You will receive a batch of items, each with a ContentDescription (from the original tape label) and optional metadata (date, duration, notes). For each item, provide:

1. THREAD CLASSIFICATION: Assign up to 3 narrative threads from the list below, with confidence (high/medium/low). If no thread fits, leave threads empty and suggest a proposed_thread (2-4 words).

Threads:
{thread_list}

2. ENTITY EXTRACTION: Extract named people, places, organizations, and classify the event type from: {event_list}

3. GENRE ESTIMATE: Guess the content genre from the description alone: {genre_list}

4. CRYPTIC FLAG: Mark truly opaque descriptions (station jargon, single unexplainable words). If you can partially decode, explain in decode_note.

IMPORTANT CONTEXT:
- Descriptions are from 1970s-80s tape labels, often in ALL CAPS with newsroom shorthand
- "FOLO" = follow-up story. "P.C." = press conference. "pkg" = package. "lites"/"hi lites" = highlights
- "closer" = light story at end of newscast. "live" = field report.
- Dorothy = Dorothy Fuldheim (legendary WEWS anchor/commentator). Ted/Castele = Dr. Ted Castele (WEWS health commentator).
- "RTA" = Regional Transit Authority. "CSU" = Cleveland State University. "Tribe" = Cleveland Indians nickname.
- Cleveland context: Dennis Kucinich was mayor 1977-79. George Voinovich succeeded him. George Forbes was city council president. The city defaulted on debt in 1978. Steel industry was collapsing.

Respond with a JSON array. One object per item, matching the item_id order provided. Each object must have: item_id, threads (array of {{name, confidence}}), proposed_thread (string or null), entities ({{people, places, organizations, event_type}}), genre, is_cryptic, decode_note."""

FEW_SHOT_EXAMPLES = [
    {
        "input": {"item_id": "60-16", "description": "ROBERT VANCE RAISED WITH CORY MOORE SPEAKS AND ASKS HIM TO COME OUT", "notes": "Warrensville Heights hostage negotiations", "date": "1977-03"},
        "output": {
            "item_id": "60-16",
            "threads": [{"name": "Crime & Safety", "confidence": "high"}],
            "proposed_thread": None,
            "entities": {"people": ["Robert Vance", "Cory Moore"], "places": ["Warrensville Heights"], "organizations": [], "event_type": "hostage_negotiation"},
            "genre": "reporter_package",
            "is_cryptic": False,
            "decode_note": None
        }
    },
    {
        "input": {"item_id": "999-5", "description": "FOLO ON EUCLID AVE BLAZE", "notes": "", "date": "1981-06"},
        "output": {
            "item_id": "999-5",
            "threads": [{"name": "Crime & Safety", "confidence": "high"}],
            "proposed_thread": None,
            "entities": {"people": [], "places": ["Euclid Avenue"], "organizations": [], "event_type": "disaster"},
            "genre": "reporter_package",
            "is_cryptic": False,
            "decode_note": "FOLO = follow-up story. This is a follow-up report on a fire on Euclid Avenue."
        }
    },
    {
        "input": {"item_id": "500-12", "description": "TIRE strike- UNIROYAL LOCAL #553", "notes": "", "date": "1982-03"},
        "output": {
            "item_id": "500-12",
            "threads": [{"name": "Economy & Labor", "confidence": "high"}],
            "proposed_thread": None,
            "entities": {"people": [], "places": [], "organizations": ["Uniroyal", "Local #553"], "event_type": "protest"},
            "genre": "reporter_package",
            "is_cryptic": False,
            "decode_note": None
        }
    },
    {
        "input": {"item_id": "300-8", "description": "closer", "notes": "", "date": "1981-11"},
        "output": {
            "item_id": "300-8",
            "threads": [{"name": "Media & Broadcasting", "confidence": "high"}],
            "proposed_thread": None,
            "entities": {"people": [], "places": [], "organizations": [], "event_type": None},
            "genre": "closer",
            "is_cryptic": False,
            "decode_note": "Closer = the light or human-interest segment that ends a newscast."
        }
    },
    {
        "input": {"item_id": "700-22", "description": "MUSSELMAN", "notes": "", "date": "1982-01"},
        "output": {
            "item_id": "700-22",
            "threads": [{"name": "Sports", "confidence": "medium"}],
            "proposed_thread": None,
            "entities": {"people": ["Bill Musselman"], "places": [], "organizations": ["Cleveland Cavaliers"], "event_type": "sports_event"},
            "genre": "unknown",
            "is_cryptic": True,
            "decode_note": "Likely Bill Musselman, Cavaliers head coach 1980-82. Single-name reference suggests he was a known figure in the WEWS newsroom during this period."
        }
    },
    {
        "input": {"item_id": "450-3", "description": "Draft Gaul", "notes": "", "date": "1979-04"},
        "output": {
            "item_id": "450-3",
            "threads": [],
            "proposed_thread": None,
            "entities": {"people": [], "places": [], "organizations": [], "event_type": None},
            "genre": "unknown",
            "is_cryptic": True,
            "decode_note": "Uncertain. Could be a draft-related story involving someone named Gaul, possibly an NFL draft reference. Cannot decode with confidence."
        }
    }
]


def load_source_items() -> list[dict]:
    with open(SOURCE_FILE) as f:
        items = json.load(f)
    seen = {}
    for item in items:
        item["item_id"] = f"{item['container']}-{item['item']}"
        seen[item["item_id"]] = item  # dedup by item_id
    return list(seen.values())


def prepare_batch(items: list[dict], include_notes: bool = True) -> list[dict]:
    batch = []
    for item in items:
        entry: dict[str, Any] = {
            "item_id": item["item_id"],
            "description": item["description"],
        }
        if include_notes and item.get("notes"):
            entry["notes"] = item["notes"]
        if item.get("date"):
            entry["date"] = item["date"]
        batch.append(entry)
    return batch


def classify_batch(
    client: anthropic.Anthropic,
    batch_items: list[dict],
    system_prompt: str,
    model: str = "claude-haiku-4-5-20251001",
    max_retries: int = 3,
) -> list[dict]:
    few_shot_text = "Here are examples of expected output:\n\n" + json.dumps(
        [ex["output"] for ex in FEW_SHOT_EXAMPLES], indent=2
    )

    user_message = json.dumps({"items": batch_items}, indent=2)

    last_error = None
    for attempt in range(max_retries):
        try:
            response = client.messages.create(
                model=model,
                max_tokens=8192,
                temperature=0,
                system=system_prompt + "\n\n" + few_shot_text,
                messages=[{"role": "user", "content": user_message}],
            )

            text = response.content[0].text
            # Parse JSON from response
            try:
                results = json.loads(text)
            except json.JSONDecodeError:
                # Try to extract JSON array from text (handles markdown fences)
                start = text.find("[")
                end = text.rfind("]") + 1
                if start >= 0 and end > start:
                    results = json.loads(text[start:end])
                else:
                    raise ValueError(f"Could not parse JSON from response: {text[:200]}")

            return results

        except Exception as e:
            last_error = e
            if attempt < max_retries - 1:
                wait = (attempt + 1) * 2  # 2s, 4s backoff
                time.sleep(wait)

    raise last_error  # type: ignore


def run_classification(
    run_name: str,
    model: str = "claude-haiku-4-5-20251001",
    batch_size: int = 50,
    include_notes: bool = True,
    progress_callback=None,
) -> dict:
    """Run full Tier 1+2 classification pipeline. Supports stop/resume."""
    clear_stop(run_name)

    run_dir = DATA_DIR / "runs" / run_name
    raw_dir = run_dir / "raw_responses"
    raw_dir.mkdir(parents=True, exist_ok=True)

    config = load_thread_config()
    system_prompt = build_system_prompt(config)
    items = load_source_items()

    client = anthropic.Anthropic()

    total_batches = (len(items) + batch_size - 1) // batch_size
    all_results = []
    errors = []

    # Check if batch size changed — if so, clear stale raw files to avoid misalignment
    meta_file = run_dir / "metadata.json"
    if meta_file.exists():
        with open(meta_file) as f:
            prev_meta = json.load(f)
        if prev_meta.get("batch_size") != batch_size:
            for f in raw_dir.glob("batch_*.json"):
                f.unlink()

    # Check for existing progress (resume support)
    existing_batches = set()
    if raw_dir.exists():
        for f in raw_dir.glob("batch_*.json"):
            try:
                batch_num = int(f.stem.split("_")[1])
                existing_batches.add(batch_num)
            except (ValueError, IndexError):
                pass

    stopped = False
    for i in range(0, len(items), batch_size):
        batch_num = i // batch_size

        # Check stop flag
        if is_stopped(run_name):
            stopped = True
            break

        batch_file = raw_dir / f"batch_{batch_num}.json"

        # Skip already completed batches (resume)
        if batch_num in existing_batches:
            with open(batch_file) as f:
                batch_results = json.load(f)
            all_results.extend(batch_results)
            if progress_callback:
                progress_callback(batch_num + 1, total_batches, len(errors), errors)
            continue

        batch = prepare_batch(items[i : i + batch_size], include_notes)

        try:
            results = classify_batch(client, batch, system_prompt, model)
            with open(batch_file, "w") as f:
                json.dump(results, f, indent=2)
            all_results.extend(results)
        except Exception as e:
            errors.append({"batch": batch_num, "error": str(e)})

        if progress_callback:
            progress_callback(batch_num + 1, total_batches, len(errors), errors)

        # Rate limiting
        time.sleep(0.5)

    # Deduplicate by item_id (keep last occurrence in case of re-runs)
    seen = {}
    for r in all_results:
        seen[r.get("item_id")] = r
    all_results = list(seen.values())

    # Save merged classifications (even partial)
    with open(run_dir / "classifications.json", "w") as f:
        json.dump(all_results, f, indent=2)

    # Save run metadata
    if stopped:
        final_status = "stopped"
    elif errors:
        final_status = "completed_with_errors"
    else:
        final_status = "completed"

    metadata = {
        "run_name": run_name,
        "model": model,
        "batch_size": batch_size,
        "include_notes": include_notes,
        "total_items": len(items),
        "classified_items": len(all_results),
        "total_batches": total_batches,
        "batches_completed": len(existing_batches | {i // batch_size for i in range(0, len(all_results) * batch_size, batch_size)}),
        "errors": errors,
        "status": final_status,
    }
    with open(run_dir / "metadata.json", "w") as f:
        json.dump(metadata, f, indent=2)

    clear_stop(run_name)
    return metadata


def run_classification_subset(
    run_name: str,
    items: list,
    model: str = "claude-haiku-4-5-20251001",
    batch_size: int = 50,
    include_notes: bool = True,
    progress_callback=None,
) -> dict:
    """Classify a specific subset of items and merge into existing run results."""
    clear_stop(run_name)

    run_dir = DATA_DIR / "runs" / run_name
    run_dir.mkdir(parents=True, exist_ok=True)

    config = load_thread_config()
    system_prompt = build_system_prompt(config)

    client = anthropic.Anthropic()

    total_batches = (len(items) + batch_size - 1) // batch_size
    new_results = []
    errors = []

    for i in range(0, len(items), batch_size):
        batch_num = i // batch_size

        if is_stopped(run_name):
            break

        batch = prepare_batch(items[i : i + batch_size], include_notes)

        try:
            results = classify_batch(client, batch, system_prompt, model)
            new_results.extend(results)
        except Exception as e:
            errors.append({"batch": batch_num, "error": str(e)})

        if progress_callback:
            progress_callback(batch_num + 1, total_batches, len(errors), errors)

        time.sleep(0.5)

    # Load existing classifications and merge
    cls_file = run_dir / "classifications.json"
    existing = []
    if cls_file.exists():
        with open(cls_file) as f:
            existing = json.load(f)

    # Merge: new results override existing by item_id
    seen = {}
    for r in existing:
        seen[r.get("item_id")] = r
    for r in new_results:
        seen[r.get("item_id")] = r
    all_results = list(seen.values())

    with open(cls_file, "w") as f:
        json.dump(all_results, f, indent=2)

    final_status = "completed_with_errors" if errors else "completed"

    # Load source items count for metadata
    all_items = load_source_items()

    metadata = {
        "run_name": run_name,
        "model": model,
        "batch_size": batch_size,
        "include_notes": include_notes,
        "total_items": len(all_items),
        "classified_items": len(all_results),
        "total_batches": total_batches,
        "batches_completed": total_batches - len(errors),
        "errors": errors,
        "status": final_status,
    }
    with open(run_dir / "metadata.json", "w") as f:
        json.dump(metadata, f, indent=2)

    clear_stop(run_name)
    return metadata


if __name__ == "__main__":
    import sys

    run_name = sys.argv[1] if len(sys.argv) > 1 else time.strftime("%Y-%m-%d")
    model = sys.argv[2] if len(sys.argv) > 2 else "claude-haiku-4-5-20251001"

    def progress(completed, total, errors, error_details=None):
        print(f"\rBatch {completed}/{total} ({errors} errors)", end="", flush=True)

    result = run_classification(run_name, model, progress_callback=progress)
    print(f"\nDone: {result['classified_items']} items classified")

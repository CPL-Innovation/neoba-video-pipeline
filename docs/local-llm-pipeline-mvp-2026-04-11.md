# Local-LLM Video Pipeline — MVP Tech Stack

**Date:** April 11, 2026 (revised same day after Gemma 4 investigation)
**Author:** Jungu + Claude (scoping session)
**Status:** Draft — MVP proposal, not yet implemented
**Purpose:** Define a feasible all-local tech stack that replicates the quality/structure of the March 25 Gemini prototype while keeping every byte of NEOBA footage on CPL-owned infrastructure.

**Revision note (April 11, afternoon):** Initial draft recommended Qwen2-VL-7B as the primary visual model and Qwen2.5-14B as the synthesis LLM. After learning that Google released **Gemma 4 on April 2, 2026** (9 days before this doc) with native video AND audio input, configurable per-frame visual token budget, 128K–256K context, MoE efficiency, and Apache 2.0 licensing, the stack has been revised to use Gemma 4 as the primary VLM (E4B size) and primary synthesis model (26B A4B on 32 GB). Qwen2.5-VL is retained as the A/B comparison backend because Gemma 4 is 9 days old and there's real risk its tooling hasn't settled.

---

## Constraints (what's driving the design)

| Constraint | Implication |
|---|---|
| All NEOBA is rights-sensitive | No cloud inference, no API calls, no remote storage. Everything runs on-device. |
| Hardware: M-series Mac, 16–32 GB unified memory | Can't run a single frontier multimodal model. Must decompose the pipeline into specialized models per task. |
| Production-minded, not just demo | Stack needs to be extensible — swap models as better ones land, add stages without rewriting. |
| Output parity with Gemini prototype | Target JSON: summary, scene breakdown, transcript, people, locations, thematic tags, timestamps. |
| Representative batch (a few hours of footage) | Throughput matters but not at scale of full archive. Can run overnight jobs. |

---

## The core architectural shift

The Gemini prototype worked because **one model did everything**. On pre-April-2026 open models at this hardware tier, that wasn't available — which forced a decomposition into specialized models per task.

**Gemma 4 partially closes that gap.** It natively ingests video and audio, handles 128K–256K context, and the 26B A4B MoE variant runs on 32 GB unified memory with throughput comparable to a 4B dense model. For the first time, a single open model can plausibly do what Gemini did for NEOBA-style footage, on-device.

But "plausibly can" isn't the same as "should." The MVP still keeps decomposition as its backbone for three reasons:
1. **Whisper large-v3 is still the best transcriber for 1970s broadcast audio** — a specialist beats a 9-day-old generalist on hard audio.
2. **Apple Vision is rock-solid at OCR** — signage, chyrons, lower-thirds are handled better than any VLM currently does it.
3. **Auditable seams matter for archival use.** When a field is wrong you want to know *which component* was wrong.

So the revised architecture is: **mostly-decomposed pipeline, with Gemma 4 as the visual and synthesis brain, and specialists in Whisper + Apple Vision + InsightFace handling the parts where specialists win.** This still aligns with Ben's "modular, non-destructive, indexing-not-transforming" philosophy — it just now happens to use a more capable model in the VLM/synthesis slots.

```
Video in
   │
   ▼
┌─────────────────────────────────────────────┐
│ Stage 1: Ingest & Segment                   │  ffmpeg + PySceneDetect
│   - Extract audio track                     │
│   - Detect scene boundaries                 │
│   - Pick 1–3 keyframes per scene            │
└─────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────┐
│ Stage 2: Per-modality extraction (parallel)      │
│                                                  │
│   Audio ──► mlx-whisper (large-v3-turbo)         │
│                                                  │
│   Keyframes ──► Gemma 4 E4B (primary, MLX)       │
│              ─► [A/B] Qwen2.5-VL-7B              │
│              ─► Apple Vision (OCR)               │
│              ─► InsightFace (face embed)         │
└──────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────┐
│ Stage 3: Cluster & aggregate                │
│   - Cluster face embeddings (DBSCAN)        │
│   - Attach transcript to scenes by time     │
│   - Build per-scene fact bundle             │
└─────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────┐
│ Stage 4: LLM synthesis                           │
│   Gemma 4 26B A4B (MoE, Q4, via Ollama/MLX)      │
│   - Reads per-scene fact bundles                 │
│   - Emits Dublin-Core-compatible JSON            │
│   - Uses JSON-schema-constrained output          │
│   - Fallback: Qwen2.5-14B-Instruct if 16 GB only │
└──────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────┐
│ Stage 5: Store & review                     │
│   SQLite index + JSON sidecars              │
│   Static review UI (feeds classifier app)   │
└─────────────────────────────────────────────┘
```

### Ambitious variant: the collapsed Stage 2+4

Because Gemma 4 26B A4B natively takes video and audio as input, there's a simpler variant worth prototyping as a second track: **feed Gemma 4 the video directly and have it emit the structured JSON in a single call.** That collapses Stages 2 and 4 into one model invocation. The per-scene fact bundles, the separate VLM captioning, and the synthesis prompt all become unnecessary. Whisper still runs in parallel because it's a better transcriber, and its output is passed into Gemma 4's text context alongside the video.

Pros: dramatically simpler pipeline, fewer failure modes, potentially better cross-modal reasoning because the model sees everything at once.
Cons: black-box, harder to validate per-field, bets everything on a 9-day-old model.

**Recommendation:** build the decomposed path first (Stages 1–5 above), then once it works, spike the collapsed variant as a direct comparison. This gives you a real head-to-head, not speculation.

---

## Stage-by-stage tech choices

### Stage 1 — Ingest & segmentation

| Tool | Role | Why |
|---|---|---|
| **ffmpeg** | Extract audio, decode frames, normalize formats | Universal. Already on every Mac. Zero friction. |
| **PySceneDetect** | Detect cuts and generate scene list | Classical CV, not ML. Fast, deterministic, CPU-only. No model drift. |
| Simple keyframe picker | 1–3 frames per scene (start/mid/end) | Downstream vision models are the expensive stage — sampling keeps cost linear in scenes, not frames. |

**Output of this stage:** `scenes.json` with `{scene_id, start_ts, end_ts, keyframes: [...]}`.

### Stage 2 — Per-modality extraction

#### Speech → text
- **Model:** `whisper-large-v3-turbo` via **mlx-whisper**
- **Why MLX:** Apple's native ML framework, uses unified memory efficiently, Metal-accelerated. On an M3 Pro, turbo runs ~8–12x realtime. This is the mature, near-cloud-quality part of the stack.
- **Output:** word-level timestamps, speaker turn detection (pyannote or the new whisper-diarize), language ID.

#### Visual understanding (per keyframe, or per scene for motion-rich clips)
- **Primary model:** **Gemma 4 E4B** via MLX (`mlx-vlm`)
  - ~5.5 GB at Q4, fits very comfortably in 16 GB
  - **Native video input** — so you can pass a short scene (not just one keyframe) when motion matters, at a low per-frame token budget (70–280 tokens/frame)
  - Configurable visual token budget per frame: 70 / 140 / 280 / 560 / 1120. Use the low end for "many frames, coarse detail," the high end for "few frames, fine detail."
  - 128K context window — plenty of headroom for multi-frame scenes
  - Native audio input (E4B only) — means you can optionally pass the raw audio alongside the frames for the same call, though we keep Whisper as the transcript source of record
- **A/B comparison model:** **Qwen2.5-VL-7B** via MLX
  - Similar footprint, similar native-video capability, longer track record (few months vs. 9 days)
  - Build the pipeline with a swappable VLM backend so both can be tested on the same clips
  - Decision criteria: compare on 3–5 representative NEOBA clips for caption quality, OCR pickup, temporal coherence, and throughput
- **Why not the bigger Gemma 4 for visual:** the 26B A4B is reserved for Stage 4 synthesis where its reasoning capacity matters more. E4B is plenty for per-scene description.

**Prompt per scene:** "You are analyzing a frame (or sequence of frames) from a 1970s–80s Cleveland broadcast news archive. Describe what is visible in detail. List visible people (without attempting to name them), objects, any on-screen text (chyrons, signs, credits), and setting. If this appears to be a specific Cleveland location, note visual evidence for that inference. Be concrete and literal; avoid interpretation."

#### OCR (text in frames)
- **Apple Vision framework** via `pyobjc` / `vision` Python bindings
- **Why:** It's already on the machine, it's free, it's faster than PaddleOCR on Apple Silicon, and it handles lower-thirds / chyrons / signage well out of the box
- Runs on the same keyframes as the VLM — cheap second pass

#### Face detection + embedding
- **InsightFace** (`buffalo_l` model) — detection + 512-d embeddings
- **Runs on CPU comfortably** — not the bottleneck
- **No identification, just grouping**: "Person A appears in 14 scenes" — SME can later label them

### Stage 3 — Clustering & aggregation

- **Face clustering:** DBSCAN on embeddings with cosine distance. Tune `eps` once, reuse.
- **Time alignment:** Attach transcript segments to scenes by timestamp intersection.
- **Fact bundle per scene:** A JSON object that collects everything the extractors found — transcript snippet, VLM caption, OCR text, face cluster IDs, timestamps. This is the "evidence packet" handed to the LLM.

### Stage 4 — LLM synthesis (the local-LLM step)

This is the stage that most resembles what Gemini was doing in the prototype — turning raw observations into structured, interpreted metadata.

| Choice | Rationale |
|---|---|
| **Primary model (32 GB):** Gemma 4 26B A4B (MoE), Q4_K_M | ~15–18 GB at Q4. MoE means only ~4 B params active per token, so throughput is closer to a 4B dense model while reasoning capacity is closer to a 26B dense model. Apache 2.0. Benchmarked strong on Apple Silicon via mlx-vlm. |
| **Fallback model (16 GB or Gemma 4 tooling unstable):** Qwen2.5-14B-Instruct, Q4_K_M | ~9 GB RAM footprint. Mature, well-tested, top-tier for its size. Safe choice if Gemma 4's 9-day-old tooling causes issues. |
| **Runtime:** Ollama | Native Gemma 4 support at launch, JSON-schema-constrained output, trivial to swap models. Serves an HTTP API the rest of the pipeline calls. |
| **Alt runtime:** `mlx-vlm` directly | Faster on Apple Silicon than llama.cpp GGUF path per early benchmarks, but the MLX story for Gemma 4 is still stabilizing — verify on your specific chip before committing. |
| **Aspirational:** Gemma 4 31B Dense | If 26B A4B isn't enough quality, 31B Dense ranks #3 on Arena. Tight on 32 GB; probably requires 48 GB+. Worth re-evaluating after first MVP pass. |

**Why Gemma 4 in particular for synthesis:** the synthesis stage wants three things — (a) strong reasoning to interpret ambiguous fact bundles into Dublin Core fields, (b) reliable JSON-schema-constrained output, and (c) enough context window to hold the full per-scene fact bundles for a multi-minute clip. Gemma 4 26B A4B hits all three, and its MoE architecture means you're not paying dense-model throughput costs for the parameter count. The 256K context window on the larger Gemma 4 variants means you can also experiment with feeding longer fact bundles without chunking.

**What this stage outputs** (matching the Gemini prototype schema):

```json
{
  "video_id": "neoba_1978_03_14_news",
  "summary": "...",
  "scenes": [
    {
      "start": "00:00:12",
      "end": "00:01:45",
      "description": "...",
      "transcript": "...",
      "people": ["person_cluster_3"],
      "locations": ["inferred: Downtown Cleveland — street signs visible"],
      "tags": ["labor", "strike", "manufacturing"],
      "confidence": {"locations": 0.6, "people": 0.9}
    }
  ],
  "entities": { "...": "..." },
  "dublin_core": { "...": "..." }
}
```

**Prompt pattern:** system prompt that defines the output schema + role ("you are an archivist"), then feed the per-scene fact bundles and ask for the JSON object. Use Ollama's `format: "json"` or a JSON schema to constrain.

### Stage 5 — Storage & review

- **SQLite** for a queryable index (scenes, entities, tags) — no server, single-file, reliable
- **JSON sidecars** per video, non-destructively stored next to source — matches Ben's "indexes not transforms" philosophy
- **Review UI:** extend the existing `neoba-archive-classifier` app to handle video metadata too, so you have one tool for both text descriptions and video outputs
- **Human-in-the-loop markers:** flag low-confidence fields (especially locations, named people) for SME review before anything becomes public

---

## Honest limitations vs. the Gemini prototype

| What Gemini did well | Local MVP status |
|---|---|
| Named-entity recognition on historic Cleveland figures | ⚠️  Weaker — even Gemma 4 26B A4B doesn't have deep Cleveland priors the way Gemini does. Mitigation: build a gazetteer of NEOBA-relevant names/places, inject as context. The strong entity-extraction results from the April 7 classifier run on ContentDescriptions can seed the gazetteer. |
| Cleveland landmark geolocation from visuals alone | ⚠️  Weaker — local VLMs see "a downtown street" but won't confidently name Terminal Tower. Mitigation: OCR-first (read the signs), gazetteer match, SME validation. |
| Cross-clip reasoning ("this is the same event from the March 14 footage") | ❌ Not in MVP. Add in a later pass via embedding search over synthesized summaries. |
| One-shot quality on first run | ⚠️  Local needs more prompt engineering and evaluation loops. Budget for iteration. Gemma 4 narrows this gap vs. the earlier-generation local models but doesn't eliminate it. |

The response to these isn't "cloud is better, give up" — it's **human-in-the-loop on the right seams**. The MVP should be explicit about which fields are "model-confident enough to publish" vs. "SME-review required." This is actually better archival practice than the Gemini one-shot, which masked uncertainty.

---

## What "MVP done" looks like

One command:
```bash
python pipeline.py ingest samples/neoba_1978_clip_01.mp4
```

Produces, in under the clip's own runtime × 2:
- `samples/neoba_1978_clip_01.json` (Dublin-Core-compatible metadata)
- `samples/neoba_1978_clip_01.transcript.txt`
- `samples/neoba_1978_clip_01.scenes/` (keyframes, per-scene fact bundles)
- Entry in `index.sqlite`

**Success criteria for the MVP demo:**
1. End-to-end run on 3–5 representative NEOBA clips with no cloud calls
2. JSON output schema matches the March 25 Gemini prototype (so downstream tooling is unchanged)
3. Qualitative comparison doc: "Gemini said X, local said Y, here's where we're equivalent and where we're weaker"
4. A short demo video / screen recording for the next IDT meeting

---

## Effort estimate (rough)

Assuming you're the only builder and you're comfortable with Python + ML tooling:

| Milestone | Effort |
|---|---|
| Stage 1 (ingest + segmentation) | 0.5 day — mostly gluing existing tools |
| Stage 2 (extraction, with swappable VLM backend) | 2.5–3.5 days — mlx-whisper setup, Gemma 4 + Qwen2.5-VL both wired behind a common interface, Apple Vision OCR, InsightFace |
| Stage 3 (aggregation) | 0.5 day |
| Stage 4 (LLM synthesis with schema) | 1–2 days — this is the prompt engineering loop, plus Gemma 4 tooling shakeout |
| Stage 5 (storage + basic review) | 0.5–1 day |
| Gemma 4 vs. Qwen2.5-VL A/B on representative clips | 0.5 day |
| Collapsed Stage 2+4 variant (native-video Gemma 4 path) | 1 day (optional, after decomposed path works) |
| Qualitative eval vs. Gemini prototype | 0.5 day |
| **Total** | **~6–9 working days for a demonstrable MVP, ~7–10 with the collapsed variant** |

This fits inside the window before the June 1 fabrication contract award, with room for iteration.

---

## Open questions / decisions to make

- [ ] **Does the MVP target M3 Pro (your current machine) or the CPL NVIDIA GPU server?** Building for Mac first is faster (everything's installed); porting to CUDA later is mostly a matter of swapping runtimes. But if the GPU server is the production target, better to build there from day one.
- [ ] **Face grouping only, or face identification?** Identification requires named-person enrollment data and has rights implications of its own. Recommend grouping-only for MVP.
- [ ] **How does this interact with the existing `neoba-archive-classifier` app?** Same repo, separate repo, or shared backend? My vote: separate Python package for the pipeline, imported by the classifier app's UI.
- [ ] **Who owns this in the IDT?** (See the separate pipeline-ownership memo — this stack is the concrete artifact that makes that conversation real.)
- [ ] **Gemma 4 tooling stability on your specific Mac.** The model is 9 days old. Ollama has native support at launch and `mlx-vlm` benchmarks are public, but there's a known GitHub issue reporting "FA hang, MLX not supported" on M5 Max. Verify on your chip before committing — if MLX is flaky, the Ollama (llama.cpp) path is the fallback at ~15 tok/s for 31B dense and ~75 tok/s for 26B MoE. Worth doing a 30-minute smoke test before writing real pipeline code.
- [ ] **Decomposed pipeline vs. collapsed Stage 2+4.** Build the decomposed path first (it's more auditable and gives you Whisper's specialist transcript quality), then spike the collapsed single-call variant as a direct comparison. Let the data decide, not the architecture aesthetic.

---

## Why this is strategically useful, not just technically

Beyond the technical merits, building this MVP does three things in parallel:

1. **Answers Ben's architectural intent in his own terms.** Modular, non-destructive, local, Dublin Core-compatible — every principle he named in the March 25 all-hands is satisfied by this stack.
2. **Makes the pipeline-ownership question concrete.** Right now the conversation is abstract ("someone should build this"). A working local MVP is a forcing function: the question becomes "Ben, are you building Stage 4 synthesis or am I?" and the answer shapes the real scope split.
3. **Produces an artifact you can show.** Given your tendency to communicate through making rather than verbal advocacy, a working local pipeline in hand is a stronger lever than a deck or a meeting talking point.

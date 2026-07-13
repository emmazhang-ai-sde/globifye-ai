# RAG for Per-Company Knowledge Bases - Design Doc

**Author:** Shuyang Zhang (AI)
**Last updated:** 2026-07-13
**Status:** proposal, not implemented. Today's system uses full-prompt injection (Option A below).
**Related:** [`sip-loop-mvp-step-by-step-guidence/step7-agent-roadmap.md`](./sip-loop-mvp-step-by-step-guidence/step7-agent-roadmap.md) section 1

The voice agent answers phone calls for multiple businesses, and each business has its own knowledge base (services, prices, hours, policies). Today the whole KB is pasted into the LLM system prompt on every call. That is the correct design at the current size, but it has a known ceiling: KBs will grow (product catalogs, policy docs, FAQ exports), businesses will have more than one document, and every token injected is paid on every LLM turn of every call. This doc lays out the options for moving from "inject everything" to "retrieve what the caller is asking about," and when to make that move.

## 1. Where we are today

| Fact | Value (2026-07-13) |
|---|---|
| Companies | 2 (Belle Beauty Co., Maison Boutique) |
| KB size per company | ~2.1-2.3 KB of markdown, roughly 550-650 tokens |
| Injection point | `_build_system_prompt()` in `sip/scripts/step2_stt_bridge.py`, chosen per call by the dialed number |
| Grounding rule | "Answer only from the knowledge base; never invent prices, policies, hours, products, or availability" |
| Latency budget | 1.5s target for a full voice turn; currently ~1.8s (file-based TTS is ~1.0s of it) |

## 2. Options

### Option A: Full-prompt injection (current)

```
+--------------------------+
|  Call arrives (line N)   |
+--------------------------+
            |
            v
+--------------------------+
|  Load <company>.md whole |
+--------------------------+
            |
            v
+--------------------------+
|  System prompt =         |
|  identity + rules + KB   |
+--------------------------+
            |
            v
+--------------------------+
|  Every LLM turn sees the |
|  entire KB in context    |
+--------------------------+
```

| Pros | Cons |
|---|---|
| Zero added latency, zero moving parts | Token cost scales with KB size, paid on every turn |
| The model always sees everything: no retrieval misses | Stops fitting when KBs become catalogs (thousands of tokens) |
| Trivial to reason about and debug | One markdown file per company: no multi-document story |
| Freshness = edit file + restart bridge | Freshness requires a restart; no UI editing path |

### Option B: Structured section retrieval (no embeddings)

Split each KB by markdown section (`## Services`, `## Booking`, ...) and inject only the sections that match the caller's question, selected by keyword rules or by a cheap LLM call ("which sections are relevant?").

```
+--------------------------+
|  STT final: caller asks  |
|  "how much for nails?"   |
+--------------------------+
            |
            v
+--------------------------+
|  Section picker:         |
|  keywords or cheap LLM   |
+--------------------------+
            |
            v
+--------------------------+
|  Inject 1-2 sections     |
|  into this turn's prompt |
+--------------------------+
```

| Pros | Cons |
|---|---|
| No embedding infrastructure at all | Phone speech is paraphrase-heavy: "how much for nails" must hit "Manicure". Keyword matching is fragile for exactly this input |
| Cheap and fast | An LLM section-picker adds a serial LLM hop inside a 1.5s budget |
| Sections are human-authored, so retrieval units are clean | Quality degrades quietly: a missed section looks like the agent "not knowing" |

### Option C: Vector retrieval on Supabase pgvector

Chunk each KB by section, embed the chunks once at ingest, store them in the SIP demo's existing Supabase project with a `company_key` column, and at question time embed the caller's utterance and pull the top few chunks for that company only.

```
Ingest (once per KB edit)             Query (per caller question)
+------------------------+            +---------------------------+
|  <company>.md          |            |  STT final text           |
+------------------------+            +---------------------------+
            |                                      |
            v                                      v
+------------------------+            +---------------------------+
|  Chunk by section      |            |  Embed the question       |
|  (200-400 tokens)      |            |  (one API call, ~60-150ms)|
+------------------------+            +---------------------------+
            |                                      |
            v                                      v
+------------------------+            +---------------------------+
|  Embed + upsert into   |            |  pgvector top-k, filtered |
|  sip_kb_chunks         |            |  WHERE company_key = ...  |
|  (company_key, section,|            |  (<20ms at this scale)    |
|   content, embedding)  |            +---------------------------+
+------------------------+                         |
                                                   v
                                      +---------------------------+
                                      |  Inject top chunks into   |
                                      |  this turn's prompt       |
                                      +---------------------------+
```

| Pros | Cons |
|---|---|
| Semantic match handles spoken paraphrases ("nails" -> Manicure) | New moving parts: embeddings API, ingest step, retrieval failure modes |
| `company_key` filter doubles as the tenant boundary | Adds ~60-170ms to the first token of a turn (embed + query) |
| Reuses the Supabase project the demo already syncs to (4.4): no new infrastructure vendor | Needs an eval habit: scripted caller questions with expected sections, checked on every KB change |
| Scales to catalogs, multiple docs per company, and UI-edited KBs (DB becomes the source of truth) | Embedding provider is a new dependency and a new key to manage |

## 3. Industry-standard stack (if/when Option C is built)

Prices as of July 2026.

| Layer | Choice | Why |
|---|---|---|
| Vector store | Supabase pgvector | Already have the project (`rjhjveatqnwxbnfrthsr`) and the service key path from the call mirror; no new vendor; SQL filters give per-company isolation in the same query |
| Embeddings | OpenAI `text-embedding-3-small` ($0.02 / 1M tokens) | Cheap, strong on short paraphrase matching, and `OPENAI_API_KEY` is already in `.env.local`. At our KB sizes, ingest cost is effectively zero; per-question cost is ~10-30 tokens |
| Alternative embeddings | Voyage, Cohere | Better multilingual/retrieval benchmarks in some suites, but a new vendor and key for marginal gain at this scale |
| Chunking | By markdown section, 200-400 tokens, section title kept in the chunk | The KB files are already written in clean sections; the section title is the best retrieval signal we have |
| Top-k | k=3 with the company filter | KBs are small; 3 sections comfortably cover any single question without re-bloating the prompt |
| Reranker | None for now | Adds latency and a vendor for a corpus of ~10 sections per company; revisit only if retrieval quality measurably fails |

## 4. Multi-tenant isolation

The retrieval filter is the tenant boundary: every query runs `WHERE company_key = <the company answering this call>`, so one business's knowledge can never surface on another's line. This mirrors how the demo already picks the system prompt by the Stasis argument. Sketch:

```sql
create table sip_kb_chunks (
  id          bigint generated always as identity primary key,
  company_key text not null,          -- beauty | boutique | ...
  section     text,                   -- "Services and starting prices"
  content     text not null,
  embedding   vector(1536)            -- text-embedding-3-small
);
create index on sip_kb_chunks using hnsw (embedding vector_cosine_ops);
```

## 5. Latency check against the 1.5s budget

Option C adds one embeddings API call (~60-150ms) plus a pgvector query (<20ms) before the LLM call, on the turn's critical path. Two offsets: the prompt gets smaller (fewer input tokens, slightly faster first token), and the current latency king remains file-based TTS playback (~1.0s), which is a separate, already-tracked optimization. Net: Option C fits the budget, but it should land together with (or after) the TTS streaming work, not instead of it.

## 6. Final decision

| Layer | Today | Planned (trigger below) |
|---|---|---|
| KB storage | Markdown files in `sip/knowledge-base/` | Rows in `sip_kb_chunks` (Supabase), files remain the authoring format |
| KB in the prompt | Entire file, every call | Top-3 retrieved sections per caller question |
| Retrieval | None | pgvector cosine top-k with `company_key` filter |
| Embeddings | None | OpenAI `text-embedding-3-small` |
| Tenant isolation | Per-call system prompt selection | Same, plus the SQL company filter |

**Recommendation:** stay on Option A now, and adopt Option C directly (skipping B) when any trigger fires:

1. Any company's KB exceeds roughly 2,000 tokens, or a company needs more than one document.
2. The KB becomes UI-editable or synced from a customer system (the DB must become the source of truth anyway).
3. More than ~5 companies onboard (per-call token cost and KB management both start to matter).

The reasoning chain: injection is strictly better while everything fits (no retrieval misses, no added latency), so the move is triggered by scale, not by preference. When the move happens, B is not a useful stop along the way: its keyword fragility is worst exactly for phone speech, and C's infrastructure cost is unusually low for us because the Supabase project, service key path, and OpenAI key all already exist. One step, done once.

## 7. Open questions

| Question | Notes |
|---|---|
| Embedding provider sign-off | `text-embedding-3-small` assumed because the key exists; confirm with the team before building |
| KB authoring workflow | Who edits KBs once customers are real: us via files, or customers via UI? Decides how ingest runs (git hook vs upload endpoint) |
| Retrieval eval | Keep a small set of scripted caller questions per company with expected sections; run it on every KB change. Without this, retrieval quality degrades silently |
| History-aware retrieval | Follow-up questions ("and on Saturday?") may need the previous turn prepended to the retrieval query |

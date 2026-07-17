# Cross-Call Caller Memory - Design Doc

**Author:** Shuyang Zhang (AI)
**Last updated:** 2026-07-15
**Status:** skeleton / proposal, not implemented. Today every call is stateless: the agent remembers nothing about a caller from one call to the next. This doc proposes a per-caller memory layer that is written after each call and read at the start of the next one, so the agent can say "last time we discussed the 40lb brisket package" instead of starting cold.
**Related:** [`rag-per-company-kb-design-doc.md`](./rag-per-company-kb-design-doc.md) (the parallel KB retrieval layer), [`sip-loop-mvp-step-by-step-guidence/step7-agent-roadmap.md`](./sip-loop-mvp-step-by-step-guidence/step7-agent-roadmap.md) section 1

The voice agent answers phone calls for multiple businesses. It knows each business's facts (the KB), but it has no memory of the people who call: every call starts from zero, even a repeat prospect who was quoted a price last week. This doc proposes cross-call caller memory, the ability to recall what a specific caller discussed in prior calls and open the next call with that context.

The key framing, and the reason this is its own doc: the KB layer is a **read** system (authoritative company facts, retrieved by semantic similarity), and caller memory is a **write** system (per-caller history, produced by the calls themselves). They share infrastructure and a prompt-assembly seam, but they are not the same subsystem. Section 2.1 makes the case for building this **on top of** the KB RAG, not collapsing it into the same table and query.

> **Skeleton note:**
> This is a structural draft. Section headers, the data model, and the two data flows are settled enough to react to; cells marked `TBD` or `TO CALIBRATE` are open decisions, collected again in section 10.

## 1. Where we are today

| Fact | Value (2026-07-15) |
|---|---|
| Caller memory | None. Each call builds a fresh conversation history (`MAX_HISTORY`) that is discarded at hangup |
| Caller identity | Available but unused: the inbound caller number (ANI) is on the Asterisk channel and reaches `step2_stt_bridge.py` via the Stasis event `TBD - confirm exact field` |
| What persists after a call | Only the call mirror to Supabase (if enabled); it is not read back on a later call |
| Grounding rule | "Answer only from the knowledge base; never invent prices, policies, hours, products, or availability" |
| Prompt assembly | `_build_system_prompt()` bakes a static system prompt at call start; retrieval (KB doc) will make position 0 per-turn |
| Latency budget | 1.5s target for a full voice turn; currently ~1.8s |

## 2. The design: write after each call, read at the start of the next

Two independent flows around one new table, `sip_caller_memory`:

- **Write-back** runs when a call ends. One LLM pass turns the call transcript into a short summary plus structured facts (interested products, any quoted price and its date, commitments, agreed next step), and upserts one row keyed by `(company_key, caller_id, call_id)`. This is off the live call path, so it costs the current call nothing.
- **Read** runs when a call begins. Look up this caller's most recent memory rows by exact key and recency (not vector similarity), and inject them as a distinct "returning caller context" block in the system prompt, alongside the KB layer.

```
Write-back (at call end)              Read (at call start)
+------------------------+            +---------------------------+
|  Full call transcript  |            |  Inbound call: caller_id  |
+------------------------+            +---------------------------+
            |                                      |
            v                                      v
+------------------------+            +---------------------------+
|  Summarize + extract   |            |  Lookup by (company,      |
|  facts (one LLM pass)  |            |  caller_id), recency top-N|
+------------------------+            +---------------------------+
            |                                      |
            v                                      v
+------------------------+            +---------------------------+
|  Upsert one row into   |            |  Inject "returning caller |
|  sip_caller_memory     |            |  context" block           |
+------------------------+            +---------------------------+
            |                                      |
            v                                      v
+------------------------+            +---------------------------+
|  Memory ready for the  |            |  Agent greets with        |
|  caller's next call    |            |  context, re-grounds price|
+------------------------+            +---------------------------+
```

### 2.1 Why this is on top of the KB RAG, not collapsed into it

It is tempting to reuse the KB retrieval pipeline directly: both look like "retrieve chunks, inject into the prompt." That is surface similarity. On the four properties that actually decide the storage and query design, they diverge, and collapsing them into the same table and same top-k query breaks the KB layer's guarantees.

| Property | KB RAG (`sip_kb_chunks`) | Caller memory (`sip_caller_memory`) |
|---|---|---|
| Tenant key | Per company (`company_key`) | Per caller: `(company_key, caller_id)`, one level finer |
| Write path | Read-only at call time; written by a daily ingest from git-authored docs | Written by the calls themselves, one row per completed call |
| Trust level | Authoritative facts; "never invent prices" | Derived from STT transcript, possibly noisy or misheard; not authoritative |
| Access pattern | Vector cosine top-k (semantic search) | Exact key + recency ordering (relational lookup); vectors only if needed later |

The decisive pair is **write path** and **trust level**. The KB layer is fundamentally a read system; caller memory is fundamentally a write system, so they cannot share one lifecycle. And if a possibly-misheard "you quoted me $9/lb" row is dropped into the same cosine top-k as the authoritative pricing chunk, the model can no longer tell an authoritative product fact from an imperfect recollection, and the whole "never invent prices" grounding is at risk.

So the two layers **share** what is safe to share and stay **separate** where it matters:

| Shared (reuse the KB layer's infra) | Separate (new for caller memory) |
|---|---|
| Same Supabase project (`rjhjveatqnwxbnfrthsr`) | New table `sip_caller_memory`, never rows inside `sip_kb_chunks` |
| The prompt-assembly seam in `_build_system_prompt()` (position 0 rebuild) | The call-end write-back path (the KB layer has no write-back) |
| The same embedding key, only if semantic memory search is added later | A recency lookup by caller, not a vector top-k, at least initially |

Net: on top of, alongside. The final position-0 prompt becomes `identity + rules + static core (playbook) + returning-caller context + retrieved KB detail`.

### 2.2 Benefits and the costs we take on

| Benefit | Cost we take on |
|---|---|
| A repeat caller is greeted with context, not from zero (higher-trust, more human sales calls) | A new write-back job and a new table to keep correct |
| Memory read is a keyed lookup at call start (once per call), so almost no live-call latency | Caller identity is a soft key (ANI can be blocked, spoofed, or shared); needs an identity-trust policy (section 7) |
| Reuses the Supabase project the KB layer already uses: no new vendor | Stores derived caller data, so PII and retention become a real concern (section 7) |
| Independent of the KB layer: can ship before or after RAG without coupling | Summarization quality gates memory quality; a bad summary poisons the next call's opener |

## 3. Industry-standard stack

Prices as of July 2026.

| Layer | Choice (proposed) | Why |
|---|---|---|
| Memory store | Supabase Postgres table `sip_caller_memory` | Same project as the KB layer and the call mirror; SQL key + recency lookup is exactly the access pattern; no new vendor |
| Caller identity key | Inbound caller number (ANI / E.164) from the ARI channel | Already present on every call; the natural per-person key. Soft key, see section 7 |
| Summarize + extract | Fast, cheap LLM, one pass at call end (`TO CALIBRATE` which model) | Off the call path, so latency is not critical; correctness and cost are. Reuse the pipeline's existing LLM client |
| Retrieval | Recency top-N by `(company_key, caller_id)`, no embeddings | A caller has few prior calls; "most recent N" covers the opener. Simpler than the KB layer, not a second vector pipeline |
| Optional semantic memory | pgvector over memory rows | Only if a caller accumulates many calls and "the relevant past slice" beats "the most recent slice". Deferred |
| Redaction | `TBD` masking pass before store | Strip payment details and anything the sales flow does not need |

## 4. Data model

One row per completed call. The `(company_key, caller_id, call_id)` unique key makes the write-back idempotent: re-processing a call updates its row in place instead of duplicating it. The recency index serves the read path directly.

```sql
create table sip_caller_memory (
  id              bigint generated always as identity primary key,
  company_key     text not null,                    -- pacificbeef | globifye | ...
  caller_id       text not null,                    -- E.164 caller number (ANI); soft key, may be blocked/shared
  call_id         text not null,                    -- Asterisk channel uniqueid for this call
  summary         text,                             -- short natural-language recap of the call
  facts           jsonb,                            -- {interested_products, quoted_price, quoted_at, commitments, next_step}
  next_step       text,                             -- the agreed follow-up, surfaced first on the next call
  identity_trust  text not null default 'unverified', -- 'unverified' | 'confirmed' (section 7)
  created_at      timestamptz not null default now(),
  unique (company_key, caller_id, call_id)          -- UPSERT target; one row per call
);
create index on sip_caller_memory (company_key, caller_id, created_at desc);
-- Deferred, only if section 3's optional semantic memory is added:
-- alter table sip_caller_memory add column embedding vector(1536);
-- create index on sip_caller_memory using hnsw (embedding vector_cosine_ops);
```

Multi-tenant and per-caller isolation: every read runs `WHERE company_key = ... AND caller_id = ...`, so one business never sees another's caller history, and within a business one caller's memory never surfaces on another's line. Enable Supabase row-level security on `sip_caller_memory` keyed by `company_key`, matching the KB layer's plan.

## 5. Write-back: turning a call into memory

Fires when the call ends (Stasis end / channel hangup), fully off the live call path.

| Step | Action | Detail |
|---|---|---|
| Trigger | On call end | No latency cost to the call that just finished; can even run async / queued |
| Summarize | One LLM pass over the call transcript | A short recap of what was discussed |
| Extract | Pull structured facts (same or a second pass) | Interested products, any quoted price + the date it was quoted, commitments, agreed next step |
| Redact | Mask sensitive PII before storing (`TBD` policy) | Keep only what the sales flow needs |
| Upsert | Write one row on `(company_key, caller_id, call_id)` | Idempotent: reprocessing updates in place |

> **What "off the call path" means:**
> The live call has already hung up when write-back runs, so its cost (an LLM summary call) never adds to the 1.5s voice-turn budget. Only the read side (section 6) touches a live call, and that is a single keyed lookup.

Failure handling: if summarization fails, log and skip; a missing memory row simply means the next call opens cold, which is exactly today's behavior. No memory is better than a wrong memory.

## 6. Read: injecting returning-caller context

At call start, before the greeting, look up the caller's recent memory and, if present, inject it as its own prompt block.

```sql
select summary, facts, next_step, identity_trust, created_at
from sip_caller_memory
where company_key = :company               -- tenant boundary
  and caller_id   = :caller                -- this caller only
order by created_at desc                   -- most recent first
limit 3;
```

| Situation | Behavior |
|---|---|
| Known caller with prior memory | Inject the returning-caller block; greet with light context |
| Unknown / first-time caller | No memory block; behave exactly as today (greet, qualify) |
| Caller ID blocked or withheld | Treat as unknown; do not attempt a lookup |
| Lookup slow or DB down | Skip the memory block; the call proceeds statelessly (graceful degradation) |

**The trust framing (this is the crux, and it resolves the "remember my price" case).** The memory block is derived from an STT transcript, so it is injected as *background about the caller*, not as authoritative fact, with an explicit instruction:

> This is context from prior calls with this phone number. It may be imperfect. Acknowledge it naturally, but never quote a remembered price as the current price. Any price you state must come from the knowledge base for this call.

So when the caller asks "last time you said $9/lb, still $9?", the agent can acknowledge the past ("we did discuss around that") but re-grounds the *current* price in the KB, keeping the KB as the single source of truth for prices. Memory drives rapport and continuity; the KB still drives facts.

**Injection into the current loop.** The returning-caller block is fixed for the whole call (it does not change per turn, unlike KB detail), so build it once at call start and cache it, then include it in every position-0 rebuild: `identity + rules + static core (playbook) + returning-caller context + retrieved KB detail`.

## 7. Identity trust and privacy

Caller memory keys on the phone number, which is a **soft** identity: it can be blocked, spoofed, or shared (a household or an office line). Two consequences:

| Risk | Mitigation |
|---|---|
| Memory belongs to a different person on the same number | Start each returning caller as `identity_trust = 'unverified'`; the agent confirms lightly ("am I speaking with <name> again?") before acting on anything sensitive from memory |
| Leaking a prior caller's PII to whoever answers on that number | Keep the injected block to non-sensitive continuity (topics, interests, next step); never read back stored payment or personal detail until identity is confirmed |
| Long-term retention of derived personal data | Define a retention window and a delete path (`TBD`); support "forget this caller" |

This section is deliberately conservative: the failure mode of caller memory is not a bad answer, it is a privacy incident, so identity trust gates what memory is allowed to do.

## 8. Latency check against the 1.5s budget

Caller memory is far lighter on the live call than the KB layer:

| Step | Added latency | When |
|---|---|---|
| Memory lookup (keyed, recency) | <20ms | Once at call start, not per turn |
| Returning-caller block assembly | negligible (cached for the call) | Once at call start |
| Write-back (summarize + upsert) | 0ms on the live call | Runs after hangup, off the call path |

So the read side adds a single sub-20ms lookup at call start and nothing per turn; the write side never touches a live call. This fits comfortably inside the 1.5s budget and, unlike the KB query rewrite, adds no per-turn cost.

## 9. Decision and rollout

| Layer | Today (stateless) | Target (caller memory) |
|---|---|---|
| Memory across calls | None; history discarded at hangup | Rows in `sip_caller_memory`, one per completed call |
| Write path | None | LLM summarize + extract at call end, off the call path |
| Read path | None | Keyed recency lookup at call start, injected as a returning-caller block |
| Retrieval | None | Recency top-N by `(company_key, caller_id)`; no embeddings initially |
| Grounding | KB only | KB still the sole source of price/policy facts; memory is background only |
| Isolation | Per-call prompt selection | Plus `(company_key, caller_id)` filter and (planned) row-level security |

**Decision (proposed):** build caller memory as a parallel subsystem on top of the KB RAG, sharing the Supabase project and the prompt-assembly seam, with its own table, its own call-end write-back, and a recency lookup rather than vector search. Do not collapse it into `sip_kb_chunks` or the KB top-k query.

Sequencing: caller memory is independent of the KB RAG and adds almost no live-call latency, so it can land before, after, or alongside RAG. Signals that make it worth building:

1. Repeat callers become common enough that starting cold is a visible weakness.
2. Sales flow needs continuity (following up on a quoted price, an agreed next step) across calls.
3. A CRM or customer record exists to reconcile against, so memory has a home beyond the phone number.

## 10. Open questions

| Question | Notes |
|---|---|
| Caller ID field | Confirm the exact ARI/Stasis field that carries the inbound number and how it reaches `step2_stt_bridge.py` |
| Summarize model + prompt | Which fast model, and the exact summary + fact-extraction schema for `facts` jsonb |
| Redaction policy | What PII is stripped before storage, and what is kept for the sales flow |
| Identity confirmation UX | How lightly the agent confirms identity before trusting memory, without a clunky "verify yourself" gate |
| Retention + delete | Retention window, and a "forget this caller" path for privacy/compliance |
| When (if) to add vector search | The call-count / history-size threshold where recency top-N stops being enough |
| Write-back timing | Synchronous at hangup vs queued/async, and what happens if the summary LLM call fails |
| Reconciliation with the call mirror | Whether memory derives from the existing Supabase call mirror or from the live transcript directly |

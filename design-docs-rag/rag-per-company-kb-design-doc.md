# RAG for Per-Company Knowledge Bases - Design Doc

**Author:** Shuyang Zhang (AI)
**Last updated:** 2026-07-16
**Status:** in build. The ingest half (schema + ingest job) is live as of 2026-07-16; call-time retrieval is designed (section 6) and lands with the TTS-streaming work, so live calls still use full-prompt injection until then. The committed target: a pre-built vector DB refreshed by a scheduled job, queried by similarity at call time.
**Related:** [`step7-agent-roadmap.md`](../sip/design-docs-sip/sip-loop-mvp-step-by-step-guidence/step7-agent-roadmap.md) section 1
**Build steps:** [`rag-build-step-by-step/`](./rag-build-step-by-step/) - [1 schema](./rag-build-step-by-step/step1-vector-table-schema.md), [2 ingest](./rag-build-step-by-step/step2-ingest-job.md), [3 retrieval](./rag-build-step-by-step/step3-call-time-retrieval.md), [4 eval](./rag-build-step-by-step/step4-retrieval-eval.md), [5 Action](./rag-build-step-by-step/step5-ingest-github-action.md) (built 1 -> 2 -> 4 -> 5 -> 3; 3 is on the call path and lands with TTS streaming)
**Glossary:** [`glossary.md`](./glossary.md) - plain-language definitions of ingest, retrieval, embed, chunk, vector, top-k, etc.

The voice agent answers phone calls for multiple businesses, and each business has its own knowledge base (services, prices, hours, policies). Today the whole KB is pasted into the LLM system prompt on every call. That is the correct design at the current size, but it has a known ceiling: KBs will grow (product catalogs, policy docs, FAQ exports), businesses will have more than one document, and every token injected is paid on every LLM turn of every call. This doc commits to making the move from "inject everything" to "retrieve what the caller is asking about" (RAG), and specifies how it is built.

## 1. Where we are today

| Fact | Value (2026-07-15) |
|---|---|
| Companies | 2 (Pacific Beef Trading, GlobiFYE) |
| KB size per company | Pacific Beef ~17.5 KB / ~3,600 tokens (overview, catalog, grading, logistics, export terms, FAQ, glossary — well over the 2,000 trigger); GlobiFYE ~3.6 KB / ~800 tokens |
| KB structure | Each KB is one markdown file with a fixed template: a **playbook** part (sales pipeline stages, qualifying questions, common objections, "when you don't know") plus a **detail** part (about us, who we sell to, what we sell, pricing) |
| Injection point | the bridge script (`sip/scripts/step2_stt_bridge.py`) builds the agent's prompt once per call, choosing the company by the dialed number |
| Grounding rule | "Answer only from the knowledge base; never invent prices, policies, hours, products, or availability" |
| Fallback in place | a scripted fallback line ("I'm not sure I have the details you're looking for, but I can have a team member follow up... may I have your name and a phone number?") already fires when the KB does not cover a question |
| Latency budget | 1.5s target for a full voice turn; currently ~1.8s (file-based TTS is ~1.0s of it) |

## 2. Pipeline

Two flows over one store: a scheduled **ingest** writes the vectors (off the call path), and a per-turn **retrieval** reads them (on the call path). They meet only at `sip_kb_chunks`, which is what keeps every embedding cost off the live call. Sections 5 and 6 detail each half; the whole flow at a glance:

```
   INGEST  (scheduled, off the call path)        RETRIEVAL  (per turn, on the call path)
   ==========================================    ==========================================
   KB files  (md / pdf / docx)                   Caller utterance  (STT final)
       |  changed files only (hash)                  |  rewrite follow-up -> standalone query
       v                                             v
   chunk -> tag core/detail -> embed             embed the query  (same model as ingest)
       |  UPSERT  (writes)                           |  cosine top-k  (reads):
       |                                             |  kind='detail',  WHERE company_key
       v                                             v
   +--------------------------------------------------------------------------------------+
   |                    sip_kb_chunks    (Supabase pgvector)                              |
   |   one row per chunk:  company_key | kind(core|detail) | section | content | embedding|
   +--------------------------------------------------------------------------------------+
                    |  matched `detail` chunks for this turn
                    v
        rebuild the system prompt  =  static core (playbook)  +  matched detail
                    |
                    v
        LLM answers on the call   (playbook core always present, detail swapped per turn)
```

How each stage feeds the next:

- **KB files -> chunks.** Each document is split by section (markdown `##`, DOCX heading, PDF ~300-token window); the section title rides inside each chunk as retrieval signal (section 5).
- **chunk -> `core`/`detail` tag.** Playbook sections (pipeline, qualifying questions, objections, "when you don't know") are tagged `core`; everything else is `detail`. Only `detail` is ever retrieved; `core` is always injected (section 2.1).
- **chunk -> embedding -> `sip_kb_chunks`.** Each chunk is embedded once and written into the table, replacing its old row in place; a per-file fingerprint means only changed files ever re-embed. This is the only write path, and it never runs during a call (section 5).
- **`sip_kb_chunks` is the meeting point.** Ingest writes it ahead of time; retrieval only reads it. That split is the whole reason no call ever waits on embedding (sections 5, 7).
- **utterance -> query.** A follow-up ("and how much is that?") is first rewritten to a standalone query using the previous turn; a self-contained question skips the rewrite (section 6).
- **query -> top-k.** The query is embedded with the same model, then cosine top-k (k=3) over `kind='detail'`, filtered to `company_key` - which is also the tenant boundary (sections 4, 6).
- **top-k -> prompt.** The system prompt is rebuilt each turn as static core (always) + this turn's matched detail: the playbook drives the conversation, the detail answers the question (section 6).
- **a miss degrades, never breaks.** Best match beyond the floor -> core only + the fallback line; embeddings API down -> inject the whole KB file that turn; no chunks yet -> the no-KB prompt (section 6).

### 2.1 Not all KB content is retrievable: static core vs retrieved detail

The agent is a sales rep, not an FAQ bot: the agent code tells it to work a five-stage pipeline "using the playbook in the knowledge base." So part of every KB has to be present on **every** turn to drive the conversation, and pure top-k retrieval would break that. The "sales pipeline stages" text matches almost no specific caller utterance, so it would rarely be retrieved; and a prospect saying "that's too expensive" might pull the *pricing* chunk and evict the *objections* chunk exactly when it is needed.

So the KB splits in two, and only the detail half is retrieved:

| Static core (always injected) | Retrievable detail (chunked, fetched top-k) |
|---|---|
| Identity line + agent rules | About us |
| The sales pipeline (five stages) | Who we sell to |
| Qualifying questions | What we sell (products, cuts, packages) |
| Common objections + responses | Pricing and terms |
| "When you don't know" (the fallback rule) | Specs, policies, catalog detail (future PDFs / DOCX) |

The core is small and bounded (the same template shape for every company), so keeping it resident costs little. The detail is what grows into catalogs, so that is what retrieval narrows. Each chunk is tagged `core` or `detail` at ingest by its section title (section 5); at call time the core is always injected and only `detail` chunks go through similarity search (section 6).

Why retrieval and not keep injecting everything: injection re-pays the whole KB on every turn and has no answer for catalogs, multiple documents per company, UI editing, or freshness. Retrieval pays each document's embedding cost once at ingest, then fetches only the few relevant detail chunks per turn. The tradeoffs we take on to get there:

| Benefit | Cost we take on |
|---|---|
| Semantic match handles spoken paraphrases ("what cuts do you carry" -> chuck, brisket, loin) | New moving parts: embeddings API, ingest job, retrieval failure modes |
| The DB is pre-built and refreshed daily, so no ingest ever runs on the call path | Adds latency to the first token of a turn (query rewrite + embed + lookup, see section 7) |
| `company_key` filter doubles as the tenant boundary | Daily cadence means a KB edit goes live at the next run (up to ~24h) unless the job is also push-triggered |
| Handles markdown, PDF, and Word, so customers can drop in real policy docs and catalogs | Needs an eval habit: scripted caller questions with expected sections, checked on every KB change |
| Reuses the Supabase project the demo already syncs to (4.4): no new infrastructure vendor | Embedding provider is a new dependency and a new key to manage |

## 3. Industry-standard stack

Prices as of July 2026.

| Layer | Choice | Why |
|---|---|---|
| Vector store | Supabase pgvector | Already have the project (`rjhjveatqnwxbnfrthsr`) and the service key path from the call mirror; no new vendor; SQL filters give per-company isolation in the same query |
| Embeddings | OpenAI `text-embedding-3-small` ($0.02 / 1M tokens) | Cheap, strong on short paraphrase matching, and `OPENAI_API_KEY` is already in `.env.local`. At our KB sizes, ingest cost is effectively zero; per-question cost is ~10-30 tokens |
| Alternative embeddings | Titan V2, Voyage, Cohere, `3-large`, free tiers, self-hosted | Evaluated in [`rag-stack-evaluation.md`](./rag-stack-evaluation.md); none beats `3-small` on this project's criteria (deployed schema fit, integration surface, cost at this scale) |
| Document loaders | Markdown (native read), PDF (`pypdf`), DOCX (`python-docx`) | Customers will hand us policy docs and catalogs as PDF and Word, not only markdown; these two libraries cover both formats without pulling in a heavy ingestion framework |
| Chunking | Split by document structure: markdown and Word by their headings, PDFs (no reliable headings) by a fixed-size window. The heading rides inside each chunk, oversized sections split further, and a table is never cut mid-row (exact sizes: Step 2 appendix) | Markdown and Word carry explicit headings that make clean retrieval units; PDFs usually do not, so they fall back to a fixed token window. The heading (or page) is the strongest retrieval signal available for each format |
| Chunk role | Tag each chunk `core` or `detail` by its section title (the playbook titles are `core`, everything else `detail`) | Keeps the playbook resident every turn so it cannot be evicted by a fact query (section 2.1); only `detail` chunks are retrieved |
| Ingest trigger | Daily scheduled GitHub Action, incremental by content hash | KB files live in the repo, so CI already has them; a daily scan keeps the vector DB pre-built and fresh with zero call-path work, and hashing means only changed files pay the re-embed cost |
| Query rewrite | Fast, cheap model, gated to detected follow-ups | Turns "and how much is that?" into a standalone query before embedding (section 6); gating and a small model keep it off the critical path for self-contained questions |
| Top-k | k=3 over `kind='detail'` with the company filter | KBs are small; 3 detail chunks comfortably cover any single question without re-bloating the prompt |
| Reranker | None for now | Adds latency and a vendor for a corpus of ~10 sections per company; revisit only if retrieval quality measurably fails |

### 3.1 Alternatives evaluated (vector store, embeddings model)

The vector store (pgvector vs Chroma / Elasticsearch / Pinecone) and the embeddings model (`3-small` vs Titan V2 / Voyage / Cohere / `3-large` / free tiers / self-hosted) were both compared in full. At this project's scale neither turns on quality or price; both turn on *fit with what is already deployed* and *integration surface*, and nothing beats the two chosen. The complete comparison tables and reasoning live in [`rag-stack-evaluation.md`](./rag-stack-evaluation.md).

## 4. Data model and multi-tenant isolation

The retrieval filter is the tenant boundary: every query runs `WHERE company_key = <the company answering this call>`, so one business's knowledge can never surface on another's line. This mirrors how the demo already picks the system prompt by the Stasis argument.

Column notes: `source_file` ties each chunk back to its document (so a changed or deleted file re-syncs precisely); `chunk_index` gives every chunk a stable identity within its file so the daily job can UPSERT in place instead of delete-then-insert; `kind` marks `core` (always injected) vs `detail` (retrieved); `content_hash` and `embedding_model` together are the change key (section 5), so bumping the model forces a full re-embed rather than silently mixing model outputs.

The table itself is one row per chunk - company, source document, position in that document, `core`/`detail` kind, section title, the text, the change key, and the vector - plus the indexes that make the nearest-vector lookup and the per-file sync fast. The full definition lives in [`rag/rag-schema.sql`](../rag/rag-schema.sql) and was applied through the Supabase SQL editor, idempotently, the same way the SIP demo schema was; see [Step 1](./rag-build-step-by-step/step1-vector-table-schema.md) for how it was run and verified.

Tenant boundary, precisely: the SIP app connects to Supabase with the **service-role key, which bypasses RLS**, and selects the tenant with the `WHERE company_key = ...` filter (derived from the dialed number). So the enforceable controls are that WHERE filter in every query, plus a test asserting the dialed-number to company_key mapping on every deploy; a wrong mapping is the real leakage risk. A per-company RLS policy would not gate a single service-role connection, so it is not the boundary. Enabling RLS with no policy only blocks anonymous/other roles entirely, which is optional hardening, not the mechanism.

## 5. Building the vector DB: the daily ingest job

The vector DB is pre-built and kept fresh by a scheduled job, so nothing is ever embedded during a call. A GitHub Action runs once a day against the KB files in the repo, re-embeds only what changed, and writes the result to `sip_kb_chunks`. Because it is the same Action, it can also run on push to the KB path and on manual dispatch, so an urgent edit does not have to wait for the next daily run.

```
+-----------------------------------+
|  Daily GitHub Action (scheduled)  |
+-----------------------------------+
                  |
                  v
+-----------------------------------+
|  Discover KB files per company    |
|  *.md  *.pdf  *.docx              |
+-----------------------------------+
                  |
                  v
+-----------------------------------+
|  Hash each file (sha256), compare |
|  to stored hash + embed model     |
+-----------------------------------+
                  |
                  v
+-----------------------------------+
|  Changed or new only:             |
|  load -> chunk -> tag -> embed    |
+-----------------------------------+
                  |
                  v
+-----------------------------------+
|  Upsert changed chunks by key,    |
|  prune removed files & indexes    |
+-----------------------------------+
                  |
                  v
+-----------------------------------+
|  sip_kb_chunks is pre-built and   |
|  fresh before the next call       |
+-----------------------------------+
```

What each run does, per company:

| Step | Action | Detail |
|---|---|---|
| Discover | List `*.md`, `*.pdf`, `*.docx` under the company's KB folder | The folder name is the `company_key` |
| Detect change | Fingerprint each file; compare fingerprint + embedding model against what is stored | Skipped only when **both** match; a model change re-embeds everything (stored and query vectors must come from the same model) |
| Load | Markdown: read text; PDF: `pypdf` text extract; DOCX: `python-docx` paragraphs | One loader per extension, dispatched by file suffix |
| Chunk | Split by document headings (PDFs, which lack reliable headings, by a fixed window); oversized sections split further | The section or heading title is kept inside each chunk as retrieval signal |
| Tag | Mark each chunk `core` or `detail` by its section title | Playbook titles (pipeline, qualifying questions, objections, when-you-don't-know) are `core`; everything else `detail` |
| Embed | `text-embedding-3-small` on each chunk | Sent in batches, so even a large document ingests in a few API calls |
| Sync | Replace each chunk's row in place; record the fresh fingerprint | Updating in place means no chunk ever disappears mid-call (a delete-then-insert would leave a gap) |
| Prune | Delete rows for files no longer on disk, and leftover rows past a file's new length | Removes deleted documents and handles a file that shrank |

> **What's a content hash:**
> A short fingerprint (sha256) of the whole file. If two runs see the same fingerprint (and the same embedding model), the file did not change, so the job skips re-embedding it. Only the fingerprint has to be compared, not the file contents.

Freshness note: with the daily schedule alone, an edit is live at the next scheduled run (up to ~24h later). Adding the push trigger on the KB path closes that gap to minutes for git-authored edits, and the daily run stays as a safety net that also catches anything the push trigger missed.

## 6. Call-time retrieval: matching the caller to the KB

At call time the job's output is read, never written. When the STT returns a final utterance, the agent rewrites it into a standalone query, embeds that query with the same model used at ingest, and compares it against the pre-built `detail` vectors by cosine similarity, restricted to the company answering the call. The retrieved detail is injected alongside the static core, which is always present.

```
+-----------------------------------+
|  STT final text (may be a         |
|  follow-up: "how much is that?")  |
+-----------------------------------+
                  |
                  v
+-----------------------------------+
|  Rewrite to a standalone query    |
|  (prev turn + utterance)          |
+-----------------------------------+
                  |
                  v
+-----------------------------------+
|  Embed the query (ingest model)   |
+-----------------------------------+
                  |
                  v
+-----------------------------------+
|  Cosine top-k over kind='detail', |
|  WHERE company_key = ...          |
+-----------------------------------+
                  |
                  v
+-----------------------------------+
|  Rebuild system prompt =          |
|  static core + matched detail     |
+-----------------------------------+
                  |
                  v
+-----------------------------------+
|  LLM answers; core playbook       |
|  always present to drive the call |
+-----------------------------------+
```

**Follow-up handling (query rewrite).** Phone dialogue is full of context-dependent follow-ups ("and how much is that?", "what about the ribeye?"). Embedding the raw utterance retrieves poorly, so before embedding we rewrite it into a standalone query using the previous user turn (and the last agent turn) as context. To protect the latency budget, the rewrite uses a fast, cheap model and runs only when the utterance looks like a follow-up (short, or opens with "and / what about / how much / that"); a self-contained question skips the rewrite and is embedded directly.

**Injection into the current loop.** Today the bridge builds the agent's system prompt once at call start, with the whole KB inside, and never touches it again. Retrieval changes that to a per-turn refresh: before each LLM call, the prompt is rebuilt as identity + rules + the playbook core + this turn's retrieved detail. The conversation history itself is untouched - only the facts slot of the prompt changes - and the core is fixed per company, so the per-turn work is just swapping the detail block.

**Failure handling.** Retrieval is on the critical path, so both a retrieval miss and an API outage need a defined behavior:

| Situation | Behavior |
|---|---|
| Best match distance above the floor (no good detail chunk) | Inject the static core only; the existing fallback line fires ("I'm not sure I have the details... may I take your name and number?") |
| Embeddings API slow or down mid-call | Fall back to injecting the whole KB file for that turn (files are local and tiny), so the call keeps full grounding instead of losing it |
| Company has no ingested chunks yet | The same fallback prompt the loader already uses today (greet, qualify, capture contact) |

Why similarity and not keyword match: the caller says "cuts" and the KB says "chuck, brisket, loin, round". They share no words, but their embeddings are close, so cosine similarity ranks that chunk first where a plain keyword rule would miss it. This is the whole reason we embed instead of keyword-matching.

The lookup itself is one small database query: among this company's `detail` chunks, order by closeness to the question's vector and keep the top 3. (The concrete query lives in [Step 3](./rag-build-step-by-step/step3-call-time-retrieval.md)'s appendix.)

> **What's the distance floor:**
> Closeness is measured as cosine distance - smaller means more similar. The floor is the cutoff that means "nothing here is close enough": if even the nearest chunk is farther away than the floor, we treat the search as a miss and use the fallback line instead of letting a weak match invite a made-up answer.

### 6.1 Retrieval strategy: when to retrieve, and how deep

The flow above describes *one* retrieval. Two choices sit on top of it - *when* to run a retrieval at all, and *how deep* to search - and both exist to protect the latency budget (section 7).

First, correct one intuition: **retrieval does not cost extra LLM tokens, it saves them.** A retrieved prompt is `static core + 3 chunks` (~900 tokens) and stays flat as catalogs grow, versus the whole KB re-paid every turn under injection (a few thousand tokens now, more later). The only added spend is embedding the query (~10-30 tokens, effectively free). What retrieval *does* add is **latency**, so the whole strategy is to spend that latency only when it pays off.

**When to retrieve - do not retrieve on every utterance.** Most turns do not need a fresh lookup:

- **Gate on real questions.** Greetings, acknowledgements ("okay", "let me think"), and back-channel do not trigger retrieval; only an actual information-seeking question does. A short heuristic (or a cheap classifier) decides, and the static core answers the rest.
- **Preload the common answers.** The handful of highest-frequency questions per company ride in the always-injected block alongside the playbook core, so the common case is answered with **zero** live retrieval. A live lookup then runs only for the long tail that block does not cover. (Cost: a curated common-answers block per company, calibrated from real call logs.)
- **Cheap mechanics for the lookups that do run.** Prefer the no-LLM "prepend the previous turn" rewrite over an LLM rewrite call (section 9), and consider a local embedding model to drop the API round-trip and the mid-call outage failure mode ([`rag-stack-evaluation.md`](./rag-stack-evaluation.md)). Thresholds (what counts as a question, when the preloaded block is insufficient) come from the Step 4 eval, not from guessing.

Net: **default to not retrieving.** The static core plus a small preloaded common-answers block carries the common case; a live lookup runs only for a genuine, uncovered question.

**How deep - hierarchical retrieval for long documents (FUTURE, not used at current scale).** Today each company has ~10 short documents (~5 chunks each, ~50 total), so a flat top-k over all `detail` chunks is enough, and that is what ships. It stops being enough when a *single* document is long (a 50-page PDF catalog is hundreds of chunks) or there are many documents: a flat search drowns in near-duplicate chunks from the same big file. The fix then is **coarse-to-fine**:

1. **Coarse (route).** At ingest, generate a one-paragraph summary per long document (LLM, off the call path) and store it as a `kind='summary'` row. At query time, match the question against the summaries first to pick the right document(s).
2. **Fine (drill in).** Run the top-k only within the matched document's chunks (`where kind='detail' and source_file in (...)`), so the fine search is over one document, not the whole corpus.

This narrows the fine search and cuts the "many near-duplicate chunks from one big file" noise. It is a clean extension of the data model (add a `kind` value; make the query two-stage) and directly answers the PDF/DOCX chunk-quality open question (section 9). **Adopt it when long PDF/DOCX documents land and the Step 4 eval shows flat retrieval degrading on them - not before.**

## 7. Latency check against the 1.5s budget

Ingest is off the call path entirely: the daily job pays all the chunking and embedding cost ahead of time, so a call only does the query side. Before the main LLM call, the query side adds:

| Step | Added latency | When |
|---|---|---|
| Query rewrite | ~100-250ms (fast, cheap model) | Only on detected follow-ups |
| Embed the query | ~60-150ms | Every retrieved turn |
| pgvector lookup | <20ms | Every retrieved turn |

So a self-contained question adds ~80-170ms; a follow-up adds ~180-420ms. Offsets: the prompt is smaller than full injection once KBs grow (static core + 3 chunks < whole catalog), and the current latency king remains file-based TTS playback (~1.0s), a separate, already-tracked optimization. The query rewrite is the one piece that can threaten the 1.5s budget, which is why it is gated to follow-ups and uses a fast model; if it still proves too costly, the fallback is the cheaper "prepend the previous turn" method (no LLM call). Net: the retrieval design fits the budget, but it should land together with (or after) the TTS streaming work, not instead of it.

## 8. Decision and rollout

| Layer | Today (injection) | Target (retrieval) |
|---|---|---|
| KB storage | Markdown files in `sip/knowledge-base/` | Rows in `sip_kb_chunks` (Supabase); md/pdf/docx files remain the authoring format |
| KB in the prompt | Entire file, every call | Static core (playbook) always injected + top-3 retrieved detail chunks per turn |
| Retrieval | None | pgvector cosine top-k over `kind='detail'` with the `company_key` filter |
| Embeddings | None | OpenAI `text-embedding-3-small` |
| Ingest | None | Daily GitHub Action, pre-built and incremental by content hash + model |
| Tenant isolation | Per-call system prompt selection | Same, plus the SQL company filter and (planned) row-level security |

**Decision:** vector retrieval (RAG) is the target architecture. Today's system still uses full-prompt injection, which is fine to run while KBs are tiny, but retrieval is the committed direction and this doc specifies it end to end. Injection stays only as the migration-from state (and as the API-failure fallback), not as a competing option.

Sequencing: retrieval adds latency and its own moving parts, so it should land together with (or after) the TTS streaming work (section 7), not ahead of it. The signals below mark when building it moves from worthwhile to urgent:

1. Any company's KB exceeds roughly 2,000 tokens, or a company needs more than one document.
2. The KB becomes UI-editable or synced from a customer system (the DB must become the source of truth anyway).
3. More than ~5 companies onboard (per-call token cost and KB management both start to matter).

**Status (2026-07-15):** signal 1 is now met. Pacific Beef's KB has grown into a full product catalog, grading, logistics, and export-terms reference at ~2,350 tokens, so building is warranted. Per the sequencing above, the ingest half (schema + daily Action + eval) comes first and is off the call path; the call-time retrieval half still lands with or after the TTS streaming work.

**Update (2026-07-16): the ingest half is live.** Step 1's `sip_kb_chunks` table is applied, and [`rag/ingest.py`](../rag/ingest.py) has run against the real corpus: 109 detail chunks (globifye 58, pacificbeef 51) embedded with `text-embedding-3-small` and written to Supabase. A standalone retrieval smoke test ([`rag/retrieve.py`](../rag/retrieve.py), no query rewrite and not wired into the call path yet) confirms the loop end to end: "what cuts do you sell?" returns Pacific Beef's product catalog as the top matches. Remaining: the retrieval eval (RAG Step 4), the daily GitHub Action (Step 5), and the call-time retrieval integration (Step 3), which still lands with the TTS streaming work. See the [build steps](./rag-build-step-by-step/).

The design is a clean split: a daily job pre-builds the vectors so no call ever waits on ingest; each call rewrites the utterance to a standalone query, retrieves the top detail chunks, and injects them alongside a static playbook core that is always present. When retrieval finds nothing or the embeddings API is down, the call degrades gracefully to the existing fallback line or to full-KB injection, never to an ungrounded answer.

## 9. Open questions

| Question | Notes |
|---|---|
| Embedding provider sign-off | `text-embedding-3-small`, now backed by the provider comparison in [`rag-stack-evaluation.md`](./rag-stack-evaluation.md) (Titan V2, Voyage, Cohere, `3-large` evaluated); still needs a team confirm |
| No-match distance floor | The exact cosine-distance threshold that means "no good chunk" must be calibrated from the eval set: too low starves real answers, too high lets noise through and invites hallucination. **First live data point (2026-07-16):** a correct top match ("what cuts do you sell?" -> product catalog) scored ~0.40 cosine similarity (~0.60 cosine distance), so the floor must sit above ~0.6 or it rejects good matches |
| Query-rewrite model + gating | Which fast model, and the exact follow-up-detection heuristic; measure its added latency against the 1.5s budget before shipping, and keep the no-LLM "prepend previous turn" method as a fallback |
| Core-section designation | **Resolved (Step 2, Decision 1):** the corpus is ingested as `detail`-only; the playbook `core` stays static in the agent code + single-file KB (Option 1). the ingest's tagger promotes any section whose title is a playbook title to `core`, so an uploaded doc defaults to `detail` and a playbook doc dropped into a corpus folder becomes `core` with no code change. A per-file marker is the future path only if a customer's playbook uses non-template titles. |
| PDF/DOCX chunk quality | PDFs lack clean section headers, so window-based chunks may retrieve worse than markdown sections; include PDF cases in the retrieval eval before trusting them |
| Action secrets and scope | The daily GitHub Action needs the Supabase service key and `OPENAI_API_KEY` as repo secrets; confirm the DB key is scoped to write `sip_kb_chunks` and nothing else |
| Retrieval eval | Scripted caller questions per company with expected sections. At today's ~950-token KBs, retrieval ≈ injection (3-4 chunks, k=3), so the eval only has teeth on a larger real or synthetic KB. Run it in the same Action and fail the build on a hit-rate regression (metric: recall@3) |
| Future UI upload path | KBs are git-authored today, so the daily Action against the repo is enough. If customers later upload KBs through a UI, ingest moves to an upload endpoint writing the same table, and the daily job becomes a reconciler |

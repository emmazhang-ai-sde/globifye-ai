# RAG Build, Step 2 - The Ingest Job

**Parent doc:** [`../rag-per-company-kb-design-doc.md`](../rag-per-company-kb-design-doc.md) (section 5, building the vector DB)
**Code:** [`rag/ingest.py`](../../rag/ingest.py)
**Builds on:** [Step 1 - the vector table](./step1-vector-table-schema.md)
**Status: MET 2026-07-16.** The live ingest ran clean and filled the table; a retrieval smoke test reads the vectors back and returns the right chunks.
**Goal:** stand up the write side of RAG: one script that reads each company's KB documents, cuts them into chunks, embeds each chunk, and fills the `sip_kb_chunks` table.
**Non-goals:** no call-time retrieval (that *reads* the table - [Step 3](./step3-call-time-retrieval.md)), no eval ([Step 4](./step4-retrieval-eval.md)), no GitHub Action yet ([Step 5](./step5-ingest-github-action.md)). Entirely off the call path, so nothing here can affect a live call.

## 1. Why this step, and where it sits

The design's core promise is that no embedding work ever happens during a phone call - the vectors are always pre-built. This step is what pre-builds them. It is the safe half of the project: a batch script, off the hot path, re-runnable at will.

The material it reads is the **per-company folders**, not the single-file KBs:

| | What it is | Used by |
|---|---|---|
| `sip/knowledge-base/pacificbeef.md`, `globifye.md` | the legacy single-file KB | today's full-prompt injection (the live call) |
| `sip/knowledge-base/pacificbeef/`, `globifye/` (10 docs each) | the RAG corpus | this ingest job -> `sip_kb_chunks` |

The folder name identifies the company; the single files are deliberately skipped.

## Prerequisites - two gates, both resolved

A live ingest needed two things. Both were unmet on 2026-07-15 and both were opened on 2026-07-16, which is when the live run succeeded (see the checkpoint log):

| Gate | State (2026-07-15) | Resolution (2026-07-16) |
|---|---|---|
| Step 1's table exists | **Not applied** - a read against the database confirmed the table was absent | **Done** - [Step 1](./step1-vector-table-schema.md) applied; the table now holds 109 rows |
| An OpenAI key is set | **Empty** - the key line existed in `ai-pipeline/.env.local` with no value, so nothing could be embedded | **Done** - real key set locally (the file is gitignored, one per machine) |

## 2. The technical decisions, and why

### Decision 1: the DB holds `detail` only; the playbook (`core`) stays static

**This is the one real design choice in the whole build, so the reasoning is recorded in full.**

**Requirement.** The agent is a sales rep, not an FAQ bot. Every single turn its prompt needs the **playbook**: the five pipeline stages, qualifying questions, common objections, and the "when you don't know" fallback rule. That text drives the conversation and must never be dropped. Separately, it needs **detail** (products, cuts, pricing, specs), but only the parts relevant to what the caller just asked.

**The tension we hit.** The corpus folders that RAG ingests contain *only detail content*. The playbook lives in the single-file KB and in the agent code, **not** in the folders. So a naive "ingest the folder, tag playbook sections `core`" produces **zero** `core` chunks. The design doc's own open question flagged this as unresolved. Three ways to resolve it:

| Option | What lands in the DB | Where the playbook lives | Cost taken on |
|---|---|---|---|
| **1. Detail-only (chosen)** | detail chunks only | static, in code + single-file KB, injected every turn (as today) | none; no new content, matches today's design |
| 2. Also ingest the playbook | detail + core rows | in the DB, parsed out of the single-file KB | the single file also holds detail sections that would duplicate the folder docs, so a dedup rule is needed; the playbook still also sits in code |
| 3. A playbook doc per folder | detail + core rows | a new authored file in each folder | new files to write and keep in sync with the code |

> **Why the playbook does not belong in a vector DB:**
> A vector DB earns its keep by letting you retrieve a *few relevant chunks out of many*. The playbook is the opposite: small, fixed, the same shape for every company, and needed on *every* turn no matter what the caller says. Putting it in the DB adds machinery (a dedup rule, a second source file) and buys nothing, because you would just fetch all of it every time anyway. Retrieval is for the *detail that grows into catalogs*. That is the part worth narrowing.

**The choice: Option 1.** The reasoning chain:

1. RAG's whole job here is to narrow the detail. The playbook is not a retrieval target and never will be.
2. It is the smallest, lowest-risk change: RAG swaps "inject *all* the detail every turn" for "retrieve the *relevant* detail." The playbook keeps working exactly as it does today. Nothing on the live call path changes shape.
3. It forecloses nothing. The `core`/`detail` tagging machinery is built now; the `core` rows are simply empty. The day a company's playbook needs to live in the corpus (a customer uploads their own), dropping a playbook document into the folder makes the tagger mark it `core` automatically - Option 3, reachable later with zero code change.
4. Options 2 and 3 solve "make the DB the single source for the playbook too," which only matters once the playbook becomes UI-editable or customer-owned. That rollout signal is not met. Build each piece when its signal fires.

**Why keep the `core`/`detail` machinery at all, if everything is `detail` today?** Because it costs nothing and it is already proven correct: run the same chunker on the single-file KB (which *does* contain the playbook) and all four playbook sections come back tagged `core` (see the checkpoint log). Dormant, not absent.

### Decision 2: cut along the document's own structure, never through a table

Documents are split at their headings, because a heading is the strongest clue about what a section is about - and the heading text is kept inside each chunk, so the search can see it. A section that runs too long is split further at natural boundaries (paragraphs, then lines), and a table is always kept whole, because half a table is useless to retrieve. **Why not just fixed-size windows for everything?** Windows are the fallback for PDFs, which lack reliable headings; throwing away the headings markdown *does* have would make retrieval worse, not simpler. (Size budgets and mechanics: appendix.)

### Decision 3: only re-embed what changed

Each file gets a fingerprint; a run skips any file whose fingerprint *and* embedding model both match what is stored. That keeps repeat runs nearly free - and folding the model into the check means switching embedding models forces a clean full re-embed, because vectors from two different models must never be mixed (they are not comparable).

### Decision 4: replace rows in place, then clean up

Re-ingesting a file replaces its rows one for one rather than deleting them all and re-inserting - so there is never a moment mid-call where a chunk is simply gone. Afterwards, rows belonging to deleted files (or to the tail of a file that shrank) are pruned.

### Decision 5: no heavy dependencies, and reuse what is already proven

The script is deliberately plain: standard library plus one small HTTP package, no vendor SDKs - matching how the other SIP scripts are built, and keeping the future CI run trivial to set up. The database-auth handling is copied from the demo server rather than rewritten, because getting it wrong cost real debugging time once already; a lesson paid for once should be reused, not re-learned. It also checks the embedding size before writing anything, so a wrong-model response fails loudly at the script instead of deep inside the database. (The auth subtlety and wire format: appendix.)

## 3. What one run does

Per company: **discover** the KB files -> **skip** unchanged ones (fingerprint) -> **load** each changed file -> **chunk** it along its structure -> **tag** each chunk core/detail -> **embed** in batches -> **write** the rows in place -> **prune** leftovers. The design doc (section 5) has the same flow as a diagram; the appendix maps each stage to the code.

## 4. How it was proven

Three passes, cheapest first - each one verified before the next:

| Pass | What it proves | Result |
|---|---|---|
| Dry-run (no DB, no key needed) | discovery, chunking, and tagging work on the real corpus | 20 files -> 109 chunks, all `detail`, as expected |
| Live run (both gates open) | embedding and writing work end to end | 109 chunks embedded and written; an immediate re-run skips everything (fingerprint check works) |
| Read-back, from the database side | every row landed with a vector attached | both companies: right file counts, right chunk counts, zero rows missing an embedding |

Commands and the verification SQL: appendix.

## Deliverable for this step

**Deliverable:** `sip_kb_chunks` holds every corpus chunk for both companies, each with its embedding, tagged `detail`.

**Status (2026-07-16): MET.** 109 chunks live (globifye 58, pacificbeef 51), zero missing embeddings, and a retrieval smoke test returns the right sections.

### Checkpoint log

**2026-07-16 - ingest live, table filled, retrieval demonstrated.**

- Both gates opened (Step 1 table applied, OpenAI key set). The live run was clean: 20 files -> 109 chunks (globifye 58, pacificbeef 51), all embedded, nothing skipped, all `detail`. The embeddings came back at the expected size, so the model output and the table column line up.
- **The vectors are usable, verified from the read side.** A standalone smoke test ([`rag/retrieve.py`](../../rag/retrieve.py) - a small slice of Step 3, not on the call path) embedded "what cuts do you sell?" for Pacific Beef and ranked all 51 detail chunks by closeness. The top 3 were all from `product-catalog.md`. The right document surfaced first, so the whole loop works end to end: write vectors -> a question finds the matching sections.
- **A real data point for the no-match floor:** that *correct* top match scored only ~0.40 cosine similarity (~0.60 distance). So the "not close enough" cutoff must sit above ~0.6 - a naively tight floor would reject good matches. Calibrate it from [Step 4](./step4-retrieval-eval.md)'s eval before trusting it.

**2026-07-15 - chunk/tag pipeline verified, embed/write still gated.**

- Dry-run over the real corpus: 20 files -> 109 chunks, all `detail`, each carrying its document + section title inside the chunk text.
- **The tagger is proven, not just idle:** running the same chunker on the single-file KB (which *does* contain the playbook) returns exactly the four playbook sections tagged `core` and the rest `detail`. This is the evidence behind Decision 1: `core` is dormant, not broken.
- **A real chunker bug, found and fixed here:** the first splitter only cut at blank lines, so a run-on block with no blank lines (the FAQ) came out as one oversized chunk. Fixed by adding finer split levels that still keep tables whole. After the fix, no chunk exceeds the size budget.
- **Both gates were discovered by checking reality first,** not by a failed run: a direct database read proved the table was absent, and a structural check of the env file proved the key line was present but empty. Both were recorded up front so the live run was never attempted blind.

## Failures log

| Symptom | Cause | Fix |
|---|---|---|
| "key missing" on the first dry-run | the key line existed in the env file but had an empty value | the script fails loudly rather than embedding with a broken key; the dry-run was changed to degrade gracefully to chunk/tag-only so the logic could still be verified |
| One chunk far over the size budget | the splitter only cut at blank lines; a run-on FAQ list has none | added finer fallback split levels (paragraphs -> lines -> fixed window), tables always kept whole |

Likely ones to watch on a future run: a "table not found" error means Step 1 was not applied; a permission error on insert means the schema's access grant did not run (re-run the whole schema file); an error writing the embedding means the vector did not reach the database in the format it expects.

## Appendix - build-time specifics (skip on a first read)

**Running it:**

```bash
cd globifye-ai
venv/bin/python3 -u rag/ingest.py --dry-run    # chunk/tag only; no DB, no key needed
venv/bin/python3 -u rag/ingest.py              # live: embed + write (both gates required)
venv/bin/python3 -u rag/ingest.py --company pacificbeef   # one company only
```

First live run reported `files=20 ... embedded=109, skipped=0`; an immediate re-run reports `skipped(unchanged)=20, embedded=0`.

**Verifying from the database** (Supabase SQL editor):

```sql
select company_key,
       count(*)                                  as chunks,
       count(*) filter (where kind='core')       as core,
       count(*) filter (where kind='detail')     as detail,
       count(*) filter (where embedding is null) as missing_embedding,
       count(distinct source_file)               as files
from sip_kb_chunks
group by company_key
order by company_key;
```

Invariants: `missing_embedding = 0`, `core = 0` (today), `files = 10` per company. Counts as of 2026-07-16: globifye 58 chunks, pacificbeef 51.

**Stage-to-code map:** discover -> `discover()`; change detection -> `fetch_stored_hashes()` (fingerprint = sha256 of the file, compared together with the stored model name); load -> `load_text()` (markdown natively; PDF via `pypdf`, DOCX via `python-docx`, both lazy-imported); chunk -> `chunk_markdown()` (split by `##`, sub-split over ~400 estimated tokens at paragraph -> line -> fixed-window levels, `|` table rows kept together; token estimate is `len/4`, no tokenizer dependency); tag -> `tag_kind()` (playbook section titles -> `core`); embed -> `embed()` (batched, dimension asserted = 1536); write -> `upsert_rows()` (UPSERT on `(company_key, source_file, chunk_index)`); prune -> `delete_where()`.

**Two wire details worth knowing:** Supabase auth adds a `Bearer` header only for legacy `eyJ...` JWT keys - a new-format `sb_secret_...` key uses the `apikey` header alone and would fail with a Bearer attached (pattern copied from `demo_ui_server.py`, where this was debugged once already). And the embedding travels as pgvector's text form (`"[0.1,0.2,...]"`), which Postgres casts into the vector column on insert.

## Next

[Step 3 - call-time retrieval](./step3-call-time-retrieval.md) is the read side and lands on the call path, so it ships with or after the TTS-streaming work - do the off-path [Step 4 (eval)](./step4-retrieval-eval.md) and [Step 5 (Action)](./step5-ingest-github-action.md) first.

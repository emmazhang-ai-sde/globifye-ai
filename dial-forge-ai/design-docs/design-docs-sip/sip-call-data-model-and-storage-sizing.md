# SIP Call: Data Model and Storage Sizing

**Author:** Shuyang Zhang (AI)
**Last updated:** July 17, 2026
**Audience:** wil (DB load planning), backend

## Context

This doc answers a request from wil:

> no I mean make a call with the ai and process it and when it gets sent to the database or it is converted into data I want you to show me the structure please and data type of everything
>
> like I want to see what the data looks like in the database and how much space it takes up
>
> so I can start trying to figure out how much of a load 1000 organizations would be like on the current database

So there are three questions to answer, in order:

1. When an AI call is processed and lands in the database, what tables and columns does it fill, and what is the data type of each field?
2. What does one real call actually look like as stored rows, and how many bytes does it take?
3. If we had 1000 organizations, how much of a load is that on the current database?

**One honesty note up front, so the numbers are trusted.**
The schema and the per-field types below are read straight from the code and the live schema file, so they are exact. The byte sizes are of two kinds, and each is labeled where it appears:

| Label | Meaning |
|---|---|
| **Measured** | Computed from the 20 real call records already sitting in `sip/demo-ui/call-history/`. Real data, but these are short demo/test calls. |
| **Modeled** | A projection built on top of the measured per-unit costs (bytes per turn, bytes per embedding). Assumptions are stated inline so you can change them. |

For the truly authoritative on-disk numbers (Postgres row headers, TOAST, index bloat, autovacuum slack), run the SQL in Appendix A against the live database. That is the number to quote in a real capacity plan. This doc gets you to the right order of magnitude and shows exactly where the bytes go.

---

## 1. What one call turns into

A call is handled by two processes. The real-time loop (`sip/scripts/step2_stt_bridge.py`) runs the conversation: audio in, speech-to-text, LLM, text-to-speech, audio out. It does not touch the database. The demo server (`sip/demo-ui/demo_ui_server.py`) rebuilds the call from the event stream, optionally runs a post-call analysis, and mirrors everything to Supabase off the hot path.

```
   Phone call (RTP audio)
          |
          v
  +----------------+     +----------------+     +----------------+
  |  STT (Modulate)| --> |  LLM (Groq)    | --> |  TTS (Deepgram)|
  |  what caller   |     |  agent reply   |     |  voice back to |
  |  said          |     |                |     |  the caller    |
  +----------------+     +----------------+     +----------------+
          |                      |
          +----------+-----------+
                     v
          in-memory call record
          (turns[], timings, company)
                     |
             (call ends)
                     v
     +--------------------------------+
     |  optional post-call analysis   |   Groq llama-3.3-70b, JSON mode
     |  summary, topics, objections   |   (on demand, not automatic)
     +--------------------------------+
                     |
                     v
     +--------------------------------+
     |   mirror to Supabase           |   best-effort, daemon thread
     +--------------------------------+
                     |
     writes to 5 (or 6) tables:
       recordings   1 row    (the call itself)
       transcript   N rows   (one per spoken turn)
       sip_calls    1 row    (SIP demo metadata)
       analysis     1 row    (only if analysis was run)
       topics       M rows   (one per key topic)
       contacts    0-1 rows  (only if the caller gave a name/phone)
```

So one processed call is not one row. It is **one call header plus one row per spoken turn plus one analysis plus a few topic rows.** The per-turn transcript rows are what make storage grow with call length, and they are the main cost driver.

> **Two schema lineages, one correction.**
> The old migration file `ai-pipeline/supabase/migrations/001_schema.sql` describes `recordings.id` as a UUID and has a `call_metadata` column and a `duration` column. That file is stale. The SIP code writes against the live merged-backend project, where `recordings.id` is a **bigint**, there is no `call_metadata`, and the column is `duration_seconds`. Confirmed by the real records showing integer recording ids (106, 101, ...). The tables below use the **live** types. The divergence is logged in `step6.1-schema-alignment-0713.md`.

---

## 2. The structure and data type of everything

These are the tables a processed call writes to. Types are the live-schema types the sync code (`demo_ui_server.py:294-467`) actually writes against.

### recordings (the call itself, 1 row per call)

| Column | Type | Notes |
|---|---|---|
| `id` | bigint | PK. The recording id (e.g. 106) that every other table points back to. |
| `audio_url` | text | **null today.** Call-audio capture is not built yet. See the audio note in section 6. |
| `duration_seconds` | int | `round(ended_at - started_at)`. |
| `did_number` | text | The dialed extension (Pacific Beef = 1000, GlobiFYE = 2000). |
| `caller_number` | text | null in the softphone demo, set later if the caller states a phone. |
| `sip_provider` | text | `"asterisk"`. |
| `sip_session_id` | text | **UNIQUE.** The Asterisk channel id. This is the idempotency key: re-syncing the same call reuses the row instead of duplicating it. |
| `status` | text | `"completed"`. |
| `organization_id` | int (FK) | Which business the call was for. |
| `agent_config_id` | int (FK) | Which agent persona answered. |
| `contact_id` | int (FK) | Set later if the caller is identified. |
| `call_mode` | text | Left null. The DB check currently accepts only `inbound` or null (open question, section 8). |

### transcript (what was said, N rows per call, one per turn)

Base columns from the migration plus three columns SIP added (`supabase-schema.sql:45-49`).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK. |
| `recording_id` | bigint (FK) | Points at `recordings.id`. |
| `speaker` | text | `"Agent"` or `"Client"`. |
| `speaker_role` | text | `"agent"` or `"client"` (SIP-added). |
| `speaker_name` | text | Resolved name, e.g. the agent persona or the identified caller (SIP-added). |
| `organization_id` | int (FK) | SIP-added, indexed. |
| `content_raw` | text | The utterance text. |
| `content_clean` | text | Same as `content_raw` today. SIP has no filler-strip pass yet, so this column is a duplicate (see section 4). |
| `sentence_start_sec` | numeric | Seconds into the call when the turn started. |
| `sequence_index` | int | Turn order, 0-based. |
| `created_at` | timestamptz | Defaults to `now()`. |

### sip_calls (SIP demo metadata, 1 row per call)

The only SIP-specific table (`supabase-schema.sql:25-37`).

| Column | Type | Notes |
|---|---|---|
| `id` | text | PK. The demo call id (`timestamp.channel`, e.g. `20260716-114033-1784220031-2`). |
| `recording_id` | bigint (FK) | Links to `recordings`. |
| `started_at` | double precision | Epoch seconds. |
| `ended_at` | double precision | Epoch seconds. |
| `company` | text | The business the call was for. |
| `direction` | text | `sales_to_client` or `client_to_sales`. |
| `caller` | text | Who initiated. |
| `dialed_by` | text | The signed-in demo user who placed the call. |
| `channel_id` | text | Asterisk channel id. |

### analysis (post-call coaching, 1 row per call, only if analysis was run)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK. |
| `recording_id` | bigint (FK) | Links to `recordings`. |
| `summary` | text | One-paragraph call summary. |
| `key_topics` | jsonb | `[{ name, start_time, end_time }]`. |
| `objection_analysis` | jsonb | `[{ timestamp, speaker, exact_quote, reason, suggestion }]`. |
| `what_went_well` | jsonb | `[{ timestamp, speaker, exact_quote, reason }]`. |
| `created_at` | timestamptz | Defaults to `now()`. |

> **Analysis is on-demand, not automatic.** It runs only when someone clicks analyze in the demo console (`POST /api/analyze/<id>`). In the 20 records on disk, 11 have analysis and 9 do not. Section 6 sizes calls both with and without it.

### topics (one row per key topic, M rows per call)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK. |
| `recording_id` | bigint (FK) | |
| `analysis_id` | uuid (FK) | Links to the `analysis` row. |
| `name` | text | Topic name. |
| `start_time` | numeric | |
| `sequence_index` | int | |
| `created_at` | timestamptz | |

### contacts (0 or 1 row, only if the caller is identified)

Written only when the analysis extracts a caller name or phone. `id` has **no DB default**, so SIP computes the next id manually before inserting (`demo_ui_server.py:470-513`).

| Column | Type | Notes |
|---|---|---|
| `id` | int | PK, no default. |
| `organization_id` | int (FK) | |
| `name` | text | |
| `phone` | text | |
| `company` | text | |

### sip_kb_chunks (knowledge base, RAG, not wired into calls yet)

This table does not fill per call. It fills **per organization**, once, when that org's knowledge base is ingested. It matters a lot for the 1000-org question because it is the one cost that scales directly with org count. Verbatim from `rag/rag-schema.sql:17-41`:

| Column | Type | Notes |
|---|---|---|
| `id` | bigint (identity) | PK. |
| `company_key` | text | Tenant key (`pacificbeef`, `globifye`, ...). Tenant isolation is a WHERE filter on this column. |
| `source_file` | text | e.g. `pacificbeef.md`. |
| `chunk_index` | int | 0-based position in the file. |
| `kind` | text | `core` (always injected) or `detail` (retrieved). |
| `section` | text | e.g. `"Packages and pricing"`. |
| `content` | text | The chunk text. |
| `content_hash` | text | sha256 of the source file. |
| `embedding_model` | text | e.g. `text-embedding-3-small`. |
| `embedding` | **vector(1536)** | The embedding. **This is the heavy column: 1536 floats = ~6.1 KB per row.** |
| `updated_at` | timestamptz | |

> **Status: RAG is not live in the call path yet** (`sip/knowledge-base/README.md`). Today the agent reads a single markdown file per company that lives in the repo, not the database. So per-org KB cost in the database is effectively **zero today** and becomes real only when RAG is turned on. It is included here because "1000 organizations" is exactly the scenario where this cost shows up.

---

## 3. A real stored call (worked example)

This is `call-history/20260716-114033-1784220031-2.json`, a real GlobiFYE demo call that was processed, analyzed, and synced (its `recording_id` is 106). Here is how it lands across the tables.

**recordings** (1 row):

| id | audio_url | duration_seconds | did_number | sip_provider | sip_session_id | status | organization_id |
|---|---|---|---|---|---|---|---|
| 106 | null | 147 | 2000 | asterisk | 1784220031.2 | completed | (GlobiFYE org id) |

**transcript** (10 rows, one per turn). First two rows:

| recording_id | speaker | speaker_role | content_raw | sentence_start_sec | sequence_index |
|---|---|---|---|---|---|
| 106 | Client | client | Okay, hi, can you hear me? | 5.6 | 0 |
| 106 | Agent | agent | Yes, I can hear you. Thanks for taking the time. To make sure DialForge is a fit, can you tell me roughly how many calls you handle each day ... | 6.5 | 1 |

...8 more rows through `sequence_index` 9.

**sip_calls** (1 row):

| id | recording_id | started_at | ended_at | company | direction | caller | dialed_by |
|---|---|---|---|---|---|---|---|
| 20260716-114033-1784220031-2 | 106 | 1784220033.74 | 1784220181.03 | GlobiFYE | sales_to_client | GlobiFYE | Bob Marsh (GlobiFYE) |

**analysis** (1 row): a `summary` paragraph, `key_topics` with 3 entries, `objection_analysis` = `[]`, `what_went_well` with 2 entries.

**topics** (3 rows): "Introduction to DialForge", "Daily call volume and purpose", "Scheduling a demo", each with a start time and sequence index.

So this one 2.5-minute call became roughly **16 rows across 4 tables**: 1 recording + 10 transcript + 1 sip_calls + 1 analysis + 3 topics.

---

## 4. How much space one call takes

**Measured across the 20 real records on disk.** Bytes are modeled Postgres row size (utf-8 text length plus per-row header, null bitmap, and fixed-width columns), not raw JSON file size.

| Table | Avg rows/call | Avg bytes/call (data only) |
|---|---|---|
| recordings | 1 | 102 |
| sip_calls | 1 | 153 |
| transcript | 3.6 | 1,079 |
| analysis | (11 of 20) | 523 |
| topics | 0.7 | 85 |
| **Data subtotal** | | **~1,940** |
| Indexes (~35% add-on) | | ~680 |
| **Total per call** | | **~2.6 KB** |

But these are short demo calls (3.6 turns on average). A real sales call is longer, so the honest planning number is higher. The useful unit costs to project with are:

| Unit | Cost | Why it matters |
|---|---|---|
| Per spoken turn (transcript row) | **~300 bytes** | Dominated by `content_raw` + `content_clean`, which are stored twice today. |
| Fixed per call (recordings + sip_calls) | **~255 bytes** | Written on every call. |
| Analysis + topics (when run) | **~600 bytes to ~2.5 KB** | Grows with call length (longer calls, more topics and objections). |

**Modeled per-call sizes for real calls:**

| Call profile | Turns | Transcript | + fixed + analysis | + ~35% index | **Total** |
|---|---|---|---|---|---|
| Short demo call (measured) | ~4 | ~1.1 KB | ~0.5 KB | | **~2.6 KB** |
| Typical 6-min sales call | ~30 | ~9 KB | ~2.5 KB | ~4 KB | **~15 KB** |
| Long 10-min sales call | ~50 | ~15 KB | ~3 KB | ~6 KB | **~24 KB** |

**Planning number: ~15 KB per processed call** for a typical call with analysis. Range 2.6 KB to 24 KB.

> **Cheap win worth flagging:** `content_raw` and `content_clean` hold identical text today (SIP has no filler-strip pass). Dropping the duplicate, or only storing `content_clean` when it differs, cuts roughly a third off the biggest table. Not urgent, but free to note now.

---

## 5. Per-organization fixed cost (the knowledge base)

Independent of call volume, each organization carries a knowledge base. This is the cost that scales with the number of organizations directly, whether or not they ever place a call.

**Today:** the live agent reads a single markdown file per company from the repo (`pacificbeef.md` is 17 KB, `globifye.md` is 3.6 KB). These files are not in the database, so the current per-org DB cost is **~0**.

**Once RAG is on** (next step), each org's KB is chunked and embedded into `sip_kb_chunks`. The cost per row:

| Component | Bytes |
|---|---|
| `embedding` vector(1536) | ~6,150 |
| `content` (~700 chars) + metadata | ~900 |
| Heap row | ~7,050 |
| HNSW index (roughly 1x the vector) | ~6,150 |
| **Per chunk, stored + indexed** | **~13 KB** |

Chunks per org depends on how big the KB is:

| KB size | Chunks | Per-org DB cost |
|---|---|---|
| Current demo corpus (~14 KB text) | ~20 | **~260 KB** |
| Realistic business KB (~70 KB text) | ~100 | **~1.3 MB** |
| Large KB (many docs) | ~300 | **~3.9 MB** |

**Planning number: ~1.3 MB per org** for the knowledge base, once RAG is live.

---

## 6. 1000 organizations: load on the current database

The load has two independent parts. Keep them separate, because one scales with org count and the other scales with how much those orgs actually call.

**Part A: knowledge base (scales with orgs only).**

| | Per org | 1000 orgs |
|---|---|---|
| KB in DB, today (markdown in repo) | 0 | **0** |
| KB in DB, RAG on, realistic KB | ~1.3 MB | **~1.3 GB** |
| KB in DB, RAG on, large KBs | ~3.9 MB | **~3.9 GB** |

**Part B: calls (scales with orgs x calls/org/day x retention).**
Using the ~15 KB/call planning number and 1 year of retention. The "calls per org per day" assumption is the big lever, so three scenarios are shown. (For reference, one prospect on a real demo call said they handle "almost 100 calls each day," so the heavy row is not unrealistic.)

| Scenario | Calls/org/day | Calls/year (1000 orgs) | Storage/year |
|---|---|---|---|
| Light | 5 | 1.8M | **~26 GB** |
| Medium | 20 | 7.3M | **~104 GB** |
| Heavy | 50 | 18.3M | **~261 GB** |
| Very heavy | 100 | 36.5M | **~522 GB** |

**Bottom line for 1000 orgs, text only:**

- The knowledge base is a **one-time ~1 to 4 GB** cost once RAG is on. Modest.
- The calls are the real driver, and they **accumulate over time**: roughly **~100 GB per year at 20 calls/org/day.** Cut retention in half and you cut that in half.
- At these sizes the database needs a **retention or archival policy** (cold-storage or delete old transcripts) rather than keeping everything hot forever. That is the main planning decision this points to.

> **The audio elephant.** All of the above is text. `audio_url` is null today because call audio is not captured. If we later store call recordings, audio dwarfs text: a 6-minute call is roughly **~1 MB compressed**, about **65x** the ~15 KB of text. At 1000 orgs x 20 calls/day that is **~7 TB/year of audio** versus ~100 GB of text. So the storage question really splits into "keep the text" (cheap, keep it in Postgres) and "keep the audio" (expensive, and if we do it, it belongs in object storage like S3 or Supabase Storage, with only the URL in the `recordings` table). Worth deciding before it becomes a surprise.

---

## 7. How to reproduce and get authoritative numbers

Two ways to get real numbers instead of the modeled ones above.

**Reproduce a fresh call end to end:** place a softphone call to extension 1000 or 2000, talk to the agent, hang up, then click analyze in the demo console. The call is written to `sip/demo-ui/call-history/<id>.json` locally and mirrored to Supabase. The `recording_id` in that JSON is the live row id to inspect.

**Measure the real on-disk size** by running the SQL in Appendix A against the live database. That returns actual `pg_total_relation_size` per table (heap + indexes + TOAST) and `pg_column_size` per column for a specific call, which is the number to quote in a real capacity plan.

---

## 8. Open questions and caveats

| Item | Note |
|---|---|
| `call_mode` | Left null. The DB check accepts only `inbound` or null. Backend should confirm the allowed values before we set it (from `step6.1`). |
| Audio storage | Not built. Biggest future cost. Decide object-storage vs DB before turning it on (section 6). |
| `content_clean` duplication | Identical to `content_raw` today. ~1/3 saving on the transcript table if de-duplicated (section 4). |
| Analysis coverage | On-demand only. If every call is analyzed automatically, add ~0.6 to 2.5 KB/call to every row of the section 6 table. |
| RAG not live | Per-org KB cost (Part A) is zero until RAG ships. |
| Embedding size | `vector(1536)` assumes `text-embedding-3-small`. A larger model (3072 dims) doubles the embedding cost per chunk. |
| Modeled vs measured | Section 4/6 numbers are order-of-magnitude. Appendix A gives the exact live figures. |

---

## Appendix A: SQL for authoritative live numbers

Run against the live Supabase project. `<REC_ID>` is a recording id from a synced call (e.g. 106).

**Total size per table (heap + indexes + TOAST):**

```sql
select
  relname as table,
  pg_size_pretty(pg_total_relation_size(relid))      as total,
  pg_size_pretty(pg_relation_size(relid))            as heap,
  pg_size_pretty(pg_total_relation_size(relid)
                 - pg_relation_size(relid))          as indexes,
  n_live_tup                                         as rows
from pg_stat_user_tables
where relname in
  ('recordings','transcript','sip_calls','analysis','topics','contacts','sip_kb_chunks')
order by pg_total_relation_size(relid) desc;
```

**Exact byte size of one full call** (sum every row that belongs to it):

```sql
select
  (select sum(pg_column_size(r.*)) from recordings r where r.id = <REC_ID>)                          as recordings_bytes,
  (select coalesce(sum(pg_column_size(t.*)),0) from transcript t where t.recording_id = <REC_ID>)    as transcript_bytes,
  (select coalesce(sum(pg_column_size(s.*)),0) from sip_calls s where s.recording_id = <REC_ID>)     as sip_calls_bytes,
  (select coalesce(sum(pg_column_size(a.*)),0) from analysis a where a.recording_id = <REC_ID>)      as analysis_bytes,
  (select coalesce(sum(pg_column_size(tp.*)),0) from topics tp where tp.recording_id = <REC_ID>)     as topics_bytes;
```

**Average bytes per call across all synced calls** (the empirical per-call number):

```sql
select
  count(*)                                                   as calls,
  pg_size_pretty(avg(per_call.bytes)::bigint)               as avg_bytes_per_call,
  pg_size_pretty(sum(per_call.bytes)::bigint)               as total_bytes
from (
  select r.id,
         pg_column_size(r.*)
         + coalesce((select sum(pg_column_size(t.*)) from transcript t where t.recording_id = r.id),0)
         + coalesce((select sum(pg_column_size(a.*)) from analysis   a where a.recording_id = r.id),0)
         + coalesce((select sum(pg_column_size(tp.*)) from topics    tp where tp.recording_id = r.id),0)
         as bytes
  from recordings r
) per_call;
```

**Per-org knowledge base size (once RAG is live):**

```sql
select company_key,
       count(*)                                    as chunks,
       pg_size_pretty(sum(pg_column_size(k.*)))    as heap_bytes
from sip_kb_chunks k
group by company_key
order by 2 desc;
```

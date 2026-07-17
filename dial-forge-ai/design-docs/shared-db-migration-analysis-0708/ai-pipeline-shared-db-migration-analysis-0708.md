# AI Pipeline — Shared Database Migration Path Analysis
**Author:** Shuyang Zhang (AI)
**Last updated:** 2026-07-08
**Related docs:** [`backend-system-design-v3.md`](../backend-system-design-v3.md) (backend target schema), [`ai-pipeline-mvp-step11-schema-migration.md`](./ai-pipeline-mvp-implementation-steps/ai-pipeline-mvp-step11-schema-migration.md) (schema alignment already done), [`ai-pipeline-data-dictionary.md`](./ai-pipeline-data-dictionary.md) (current live tables)

---

The backend team has proposed merging the AI pipeline into their environment on a single shared database. This doc analyzes how to make that move and recommends a path. The decision matters because it determines the AI team's blast radius on a shared production DB, how much of the real-time write path we still own, and how much re-work the move costs versus what Step 11 already bought us.

The good news up front: **the schema is already ~90% aligned.** Step 11 migrated our 5 owned tables to the backend's June 6 schema at the column level. So this is not a schema rewrite. It is a database *instance* consolidation plus an access-model and RLS decision, with a small schema-drift patch on top.

### Direction of the merge (one glance)

The merge has two layers, and the answer is different for each. This is the thing to be clear on before anything else:

```
        DIRECTION OF THE MERGE  —  two layers, opposite answers

  Database / schema  ────────────────────────────────────────────────

       AI's 5 tables  ───────────── merge into ─────────────►  backend
       We align to their schema and write into their one          ▲
       shared DB. Backend is the source of truth.            the "main" side

  Code / real-time pipeline  ─────────────────────────────────────────

       AI pipeline  ◄──────────────  stay separate  ────────────►  backend
       Deepgram → LLM → TTS stays ours, still on Vercel.
       Only the data write-target moves to the shared DB.
```

In one line: **the database merges (AI into backend, backend is main); the code does not merge (each team keeps its own app, we just re-point where data is written).** "Merge" here is a *database instance* consolidation, not a code-repo merge.

Why this direction and not the reverse: of the ~19 tables in the platform, the backend owns the large majority (auth, billing, CRM, SIP); the AI team owns only 5. Step 11 already had us aligning to *their* schema. The tenant tree, RLS, and org-isolation model are all backend's design. So the minority (us) folds into the majority (them), not the other way around.

---

## 1. What "shared database" actually changes

Step 11 and the shared-DB move are two different things, and it's worth separating them cleanly so we don't re-do work:

| | Step 11 (done) | This move (proposed) |
|---|---|---|
| What it aligned | Table **schemas** (columns, FKs, types) | The physical **database instance** |
| Result | Our tables match the backend's column definitions | One DB holds both teams' tables |
| Still separate after | The two Supabase **projects** stay separate | Nothing — single source of truth |

So today we have **two Supabase projects with matching schemas** but no shared data. The move collapses that into **one Supabase project** (backend-owned) that both teams read and write.

### Current state snapshot

```
┌────────────────────────────┐          ┌────────────────────────────┐
│   AI team Supabase project │          │  Backend Supabase project  │
│   (8 live tables)          │          │  (v3 target: 19 tables)    │
│                            │          │                            │
│   organizations  (stub)    │          │   full auth / billing /    │
│   users          (stub)    │          │   CRM / SIP plumbing       │
│   contacts       (stub)    │   NO      │                            │
│   recordings     (AI)      │  SHARED   │   recordings (defined)     │
│   transcript     (AI)      │   DATA    │   gpu_jobs   (defined)     │
│   analysis       (AI)      │          │                            │
│   topics         (AI)      │          │                            │
│   gpu_jobs       (AI)      │          │                            │
└────────────────────────────┘          └────────────────────────────┘
        writes via service-role key              RLS-first, org-isolation
```

The `organizations` / `users` / `contacts` tables in our project are **stubs** — created in Step 11 only so FK constraints wouldn't fail during local testing. They are empty or test-seeded. The backend owns the real versions.

---

## 2. Two independent decisions

The move breaks into two decisions that can be made separately:

- **Decision 1 — Data-move strategy:** do we migrate our existing data, or start clean?
- **Decision 2 — Integration architecture:** once on the shared DB, how does the AI pipeline write to it?

---

## 3. Decision 1 — Data-move strategy

### Option 1A: Clean cutover (no ETL)

```
AI Supabase (all test data)              Shared Supabase (backend)
   recordings  ── discard ──►  drop        recordings   (empty / fresh)
   transcript  ── discard             │     transcript
   analysis    ── discard             │     analysis
   topics      ── discard             │     topics
   gpu_jobs    ── discard             │     gpu_jobs
                                      ▼
                          repoint env vars → first real call writes fresh
```

| Pros | Cons |
|---|---|
| Zero migration code, zero data-mapping risk | Loses existing test rows (they have no value) |
| Nothing to reconcile (no ID collisions, no FK repair) | Any demo saved in the old DB must be re-recorded |
| Matches reality: our data is all test data | — |
| Fastest possible cutover | — |

### Option 1B: Dump and restore (ETL migration)

Export our tables, transform IDs to fit the backend's tenant tree, load into the shared DB.

| Pros | Cons |
|---|---|
| Preserves existing rows | Every FK field is NULL today → nothing meaningful to preserve |
| — | Requires mapping test rows onto real orgs/users that don't exist yet |
| — | Real migration effort and validation for data we'd throw away anyway |

### Decision 1 recommendation: **Clean cutover (1A)**

Everything in our DB is test data, and the fields that would make a row worth keeping (`organization_id`, `recorded_by`, `contact_id`) are all NULL because the backend dependencies that fill them haven't run yet. There is nothing to migrate. A dump-and-restore would be pure overhead for rows we'd discard. Start the shared DB clean and let the first real call write fresh.

This is the single biggest simplifier of the whole move: because we're pre-real-data, we skip the entire ETL problem.

---

## 4. Decision 2 — Integration architecture

Once we're on the shared DB, how does the AI pipeline write to it? Two options.

### Option 2A: Direct shared-DB access

Our `supabase-js` client points at the backend's project URL and keys. Writes go straight to the shared tables, exactly like today — only the connection target changes.

```
┌──────────────────────────┐
│   AI Pipeline (Vercel)   │
│   supabase-js client     │
└────────────┬─────────────┘
             │ direct writes
             ▼
┌─────────────────────────────┐
│  Shared Supabase (backend)  │
│  recordings / transcript    │
│  analysis / topics /gpu_jobs│
└─────────────────────────────┘
```

| Pros | Cons |
|---|---|
| Smallest code change — env vars + the drift patch in §5 | AI holds a key into the shared prod DB (blast radius) |
| Keeps the real-time transcript write path fast (no extra hop) | Two teams write the same tables with no API contract enforcing invariants |
| Unblocks the FK-fill work immediately | Must fit into the backend's RLS model (see §6) |
| No dependency on the API team building endpoints | — |

### Option 2B: Keep split DBs, bridge by `sip_session_id`

Federated: our DB keeps `transcript` / `analysis` / `topics`, the backend keeps everything else, and the two link by `sip_session_id`. This is what the v3 doc's "Tables owned by AI team (not in our DB)" line literally diagrams.

| Pros | Cons |
|---|---|
| No migration at all | **Rejects the stated goal** — this is *not* a shared database |
| Each team fully owns its instance | Every cross-table read (recording → its transcript) is a cross-DB join done in app code |
| — | Two RLS models, two backup policies, two sources of truth to keep consistent |
| — | The exact fragmentation Danish's "one shared table" direction was meant to kill |

### Decision 2 recommendation: **Direct shared-DB access (2A)**

The deciding factor is the **transcript write path.** Transcript rows are written in real time, per utterance, hundreds per call — so the write path has to stay fast and simple. Direct DB access (2A) keeps that path exactly as fast as it is today and is the smallest change to ship: repoint the client, apply the §5 drift patch, clean-cutover the data. It unblocks filling in the FK fields as soon as the backend's `organizations` / `users` / `contacts` rows exist.

2B is off the table by the premise: it is the opposite of a shared database.

The one thing 2A demands in return is discipline on the access boundary — the AI pipeline holds a key into the shared prod DB, so it should write under a **scoped role limited to the AI-owned tables** (not the shared god service-role key) and fit the backend's RLS model. That's the still-open §6 / §8 item, and it's the condition for doing 2A safely — not a reason to avoid it.

This keeps the hot path fast while giving the backend the control point it wants over the shared, cross-team rows.

---

## 5. Schema drift to patch before cutover

Step 11 aligned us to the **June 6** backend schema. Backend v3 is **June 17** and has moved. Before cutover, our `recordings` writes need to catch up:

### `recordings` — delta since Step 11

| Field | Step 11 (our current) | Backend v3 | Action |
|---|---|---|---|
| `sip_session_id` | ❌ missing | ✅ the bridge key to link call ↔ transcript | **Add** |
| `call_mode` | ❌ missing | ✅ `inbound` / `auto_dialer` / `human_transfer` | **Add** |
| `agent_config_id` | ❌ missing | ✅ FK → `agent_configs` | **Add** |
| everything else | ✅ present | ✅ | No change |

`sip_session_id` is the important one — v3 makes it the key that links a call to its transcript/analysis. If we adopt a shared DB this matters less as a *cross-DB* bridge, but the backend still uses it as the correlation ID between the SIP layer's call-start event and our recording row, so we need to accept and store it.

### New backend v3 tables we don't have

| Table | Owner | Relevant to AI? |
|---|---|---|
| `call_queue` | Backend | No — auto-dialer scheduling |
| `agent_configs` | Backend | Indirectly — `recordings.agent_config_id` points at it once the AI-caller feature is live |

These are backend-owned; we don't create them. We only need `recordings.agent_config_id` to reference `agent_configs` once that table exists.

> **Note:** our `createRecording` helper in `lib/supabase.ts` takes an optional-params object, so adding `sip_session_id` / `call_mode` / `agent_config_id` is additive — existing callers that omit them still work. Same pattern as the SIP fields we added in Step 11.

---

## 6. Complications to expect on the shared environment

This is the part the move actually costs us. Grouped by where it bites.

| # | Complication | Why it happens | What to do |
|---|---|---|---|
| 1 | **RLS flips from off to on** | Our tables have no RLS today; every write uses the service-role key that bypasses it. The backend's v3 enables org-isolation RLS on all tables. | Decide the AI writer's role. Either keep a **scoped service key** for the AI's owned tables (service role bypasses RLS by design — legitimate for a trusted server-side writer), or write under a real `auth.uid()` context. This must be agreed with the backend, not assumed. |
| 2 | **Service-role key custody** | Direct access (2A) means the AI pipeline holds a key into the shared prod DB. Today that key only touches our throwaway project. | Ask the backend to provision a **dedicated DB role scoped to the AI-owned tables** rather than sharing their god service-role key. Limits blast radius. |
| 3 | ~~FK constraints become real~~ **Resolved 2026-07-08** | Today `organization_id` / `recorded_by` / `contact_id` are NULL, so nothing enforces them. Worried a shared DB might require those rows to exist first. | Checked directly (§10.1): every `recordings` column except `id` is `is_nullable = YES`, including `organization_id`, `recorded_by`, `contact_id`, `sip_session_id`, `call_mode`, `agent_config_id`. Not a blocker — an insert missing all of these succeeds today. |
| 4 | **Stub-table collision** | Our `organizations` / `users` / `contacts` stubs would conflict with the backend's real tables on a shared DB. | Clean cutover (Decision 1A) handles this: we don't bring our stubs. We drop them and use the backend's. |
| 5 | **Ownership boundary is ambiguous in v3** | v3's "our group owns these" table lists `recordings` and `gpu_jobs`, but its diagram also says `transcript` / `analysis` / `topics` are "AI team (not in our DB)." On a shared DB, "not in our DB" no longer holds. | Settle write-ownership explicitly: who inserts the `recordings` row at call-start — the SIP layer's `POST /calls/start`, or the AI pipeline? This changes our code. See §7. |
| 6 | **Grants on SQL-created tables** | Step 11 hit `permission denied for table topics` because tables made via the SQL editor don't auto-grant roles. | If the backend creates tables the same way, the AI writer role needs explicit `GRANT`. Flag it so it's not re-discovered at demo time. |
| 7 | **Environment + secrets** | We move from our `.env.local` Supabase URL/keys to the backend's. | New `NEXT_PUBLIC_SUPABASE_URL`, anon key, and the scoped writer key in every environment (local, Vercel preview, Vercel prod). Rotate the old keys after cutover. |
| 8 | **Migration ordering / FK creation order** | Same lesson as Step 11: `organizations` before `users`/`contacts` before `recordings` before `transcript`. | On a shared DB the backend owns this, but our cutover must run *after* their base tables exist. |

Of these, **#3 is now resolved** (confirmed nullable, §10.1). The one that can still actually block us is **#1/#2 (RLS + key model)** — a backend decision we need an answer on before cutover, not after.

---

## 7. Write strategy — how we write into a schema we don't fully own

The natural worry with a shared DB is: *their tables have columns that don't match what we write — how do we insert at all?* The answer is that the mismatch is smaller and more contained than it looks.

### The mismatch is concentrated in one table

| Table | Who defines the schema | Mismatch risk |
|---|---|---|
| `transcript` / `analysis` / `topics` | **AI team** (v3: "owned by AI team") | **None** — we define the columns, so what we write *is* the schema |
| `gpu_jobs` | Backend defines, AI writes | Minimal — `compute_units` / `cost` we already leave null |
| `recordings` | **Backend defines, AI writes** | **This is the only boundary table** |

So "their table has stuff that doesn't match ours" is really about `recordings`. Their `recordings` has a **superset** of what we write: the extra columns are `sip_session_id`, `call_mode`, `agent_config_id`, plus the FK fields (`organization_id` etc.) we currently leave NULL.

### A partial INSERT is fine — Postgres does not require every column

Our write helper sends only the keys present in the params object:

```typescript
.from('recordings').insert(params)   // writes exactly the columns in `params`, nothing else
```

Any column not in `params` takes its default (NULL). **So extra columns on their table cost us nothing as long as they are nullable or have a default — we simply don't mention them, and no code changes.** The *only* case that breaks an insert is a `NOT NULL` column with no default that we don't own and can't fill.

And the columns we can't fill (`organization_id`, `sip_session_id`, `call_mode`) are exactly the ones the SIP / backend side knows at call-start, not us.

### Resolution: whoever owns a column writes it

v3's own data flow already has the SIP layer creating the `recordings` row at call-start (`POST /calls/start`), filling `organization_id`, `sip_session_id`, `call_mode`, `did_number`. That means we should **not** try to write those columns at all. The clean split:

```
Asterisk call comes in
        │
        ▼
POST /calls/start   ← SIP layer INSERTs the recordings row
        │             (fills organization_id, sip_session_id, call_mode, did_number)
        ▼
recordings row already exists — the "mismatched" columns are already filled
        │
        ▼
AI pipeline  ── UPDATE audio_url / status / duration_seconds on that row
             └─ INSERT transcript / analysis / topics / gpu_jobs (reference recording_id)
```

| Action | Now (we own the whole row) | Shared DB (ownership split) |
|---|---|---|
| Create `recordings` row | `createRecording()` inserts | **SIP layer inserts** (fills org / sip_session_id / call_mode) |
| Get `recording_id` | returned from our insert | from the call-start event, or look up by `sip_session_id` |
| During / after call | insert | **UPDATE** `audio_url` / `status` / `duration_seconds` on that row |
| Child tables `transcript` / `analysis` / `topics` / `gpu_jobs` | insert | **Unchanged** — still insert, referencing `recording_id` |

This makes the mismatch disappear: we never touch the columns we don't own. We write only our child tables plus the `recordings` columns that are genuinely ours (`audio_url`, `status`, `duration_seconds`).

### Confirm nullability instead of guessing

Which columns are `NOT NULL` vs nullable is not something to assume. Same approach as Step 11's verify script — ask the DB directly, run against the backend's shared DB:

```sql
-- List every recordings column and whether it is required
SELECT column_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'recordings'
ORDER BY ordinal_position;
```

Cross-check the result against the fields our `createRecording` / `writeAnalysis` send. It tells us exactly two things:
1. Whether every column we send **exists** (a missing one → `column does not exist` on insert).
2. Which `NOT NULL` columns we don't fill → those must be handled by the SIP layer creating the row, or by the backend making them nullable for the MVP window.

We should write this as a committed script (like `verify-step11-schema.ts`) and run it against the shared DB before cutover.

### The one thing this forces us to settle

**Who inserts the `recordings` row?** Everything above hinges on it:

- **SIP layer inserts it** (v3's data-flow, recommended) → we switch `createRecording` to a lookup + UPDATE, and never write the mismatched columns.
- **AI pipeline inserts it** → then `sip_session_id` / `call_mode` / `organization_id` must be **handed to us at call-start**, or their `NOT NULL` constraints block us.

This is the same open item as §8's integration contract; calling it out here because it is the concrete lever that decides the whole write strategy.

---

## 8. Integration contract — settle with the backend before cutover

These map onto the v3 doc's own "Integration Contract with AI Team" open items, narrowed to what this migration forces us to decide:

| Item | Question | Owner to confirm |
|---|---|---|
| **Who inserts `recordings`** | SIP layer at `POST /calls/start`, or the AI pipeline? Determines whether we keep `createRecording` or drop it. | Backend + AI |
| **`sip_session_id` format + generator** | Asterisk-generated or API-generated? UUID or string? We store it either way, but need the format. | Backend (Abraham/Kim) |
| **AI writer DB role** | Scoped role for the 5 AI tables, or shared service key? (Complication #2) | Backend |
| **RLS for AI writes** | Service-role bypass, or write under a real `auth.uid()`? (Complication #1) | Backend |
| ~~Required vs nullable FKs~~ | ✅ Resolved 2026-07-08 — confirmed nullable (§10.1). No longer open. | — |
| **`analysis-ready` signal** | We write `status = 'summarized'` directly on the shared `recordings` row. How does the backend's CRM-sync learn it's ready — poll `status`, Supabase Realtime, or a trigger? | Backend |

---

## 9. Final decision

| Dimension | Current | Planned |
|---|---|---|
| **Database instance** | Two separate Supabase projects | One shared Supabase project (backend-owned) |
| **Data-move strategy** | — | Clean cutover, no ETL (all test data) |
| **Integration architecture** | Direct writes, our own project | Direct writes to the shared DB for all AI tables, under a scoped AI role |
| **Schema** | June 6 alignment (Step 11) | Patch drift: add `sip_session_id`, `call_mode`, `agent_config_id` to `recordings` |
| **Access / security** | Full service-role key on a throwaway project | Scoped AI-writer role on the shared prod DB; RLS model agreed with backend |
| **Stub tables** | AI holds stub `organizations`/`users`/`contacts` | Dropped — use the backend's real tables |

**Recommendation in one line:** clean-cutover onto the backend's shared Supabase with **direct DB access** (fastest, keeps the real-time transcript path fast, unblocks the FK work), patch the small schema drift, and write under a scoped AI role once the RLS and key model are settled with the backend. Because everything today is test data, we get to skip the entire migration-ETL problem — the move is mostly re-pointing the client and agreeing the access boundary, not moving data.

**Blocked-on-backend before we can cut over:** the AI-writer role + RLS model (#1/#2). The required-FK question (#3) is resolved — confirmed nullable on the shared DB, §10.1. Everything else on our side is ready.

---

## 10. Cutover SQL

> **Method:** everything in §10 was run **by hand as SQL commands in the Supabase SQL editor** — inspect, create, grant, and verify. No programmatic connection, migration tooling, or dump/restore was used.

### There is no data-migration SQL

Clean cutover (Decision 1A) means we discard the test data — **no `INSERT ... SELECT`, no dump/restore, no ETL.** The only SQL is DDL to stand up our owned tables on the shared DB so it can receive writes. Most of the schema is not ours to run.

### Who runs what against the shared DB

| Table(s) | Who creates | Do we write SQL? |
|---|---|---|
| `organizations` / `users` / `contacts` / `recordings` / `gpu_jobs` + all billing/CRM tables | **Backend** (they own them) | **No.** Their `recordings` is already the v3 version — `sip_session_id` / `call_mode` / `agent_config_id` already exist. The §5 "drift" was in our *discarded* project, not the shared DB. |
| `transcript` / `analysis` / `topics` | **AI** (v3: "owned by AI team", assumed to live in a separate AI DB) | **Yes** — these three are the only tables we create. |

So our entire cutover SQL is: create three AI-owned tables, then grant.

### Step 10.1 — Inspect first, don't assume

Run against the backend's shared DB before creating anything:

```sql
-- Do our three tables already exist on the shared DB?
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('transcript', 'analysis', 'topics');

-- Confirm recordings is already the v3 version (the columns we depend on are present)
-- data_type is included, not just is_nullable — see the bigint-vs-uuid gotcha in Step 10.2.
-- A missing column is an obvious gap; a wrong type is not, and only shows up as a cryptic
-- FK error later if we don't check it here.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'recordings'
ORDER BY ordinal_position;
```

If `recordings` is missing `sip_session_id` / `call_mode` / `agent_config_id`, that ALTER is the **backend's** to run (hand them the §5 delta), not ours.

**Result (run against the shared DB, 2026-07-08):**

| column_name | is_nullable |
|---|---|
| id | NO |
| organization_id | YES |
| recorded_by | YES |
| contact_id | YES |
| did_number | YES |
| caller_number | YES |
| audio_url | YES |
| status | YES |
| duration_seconds | YES |
| sip_provider | YES |
| sip_session_id | YES |
| agent_config_id | YES |
| call_mode | YES |

Two things this confirms:
1. **The §5 drift is already closed.** `sip_session_id`, `call_mode`, `agent_config_id` all exist on the shared DB's `recordings` table today — the backend is already running the v3 schema. No ALTER needed from either side.
2. **Complication #3 is resolved, not just mitigated.** Every column except the `id` primary key is nullable — including `organization_id`, `recorded_by`, `contact_id`. This means an insert with none of those filled will **not** be rejected by a FK/NOT NULL constraint. The write-ownership question in §7 (who inserts `recordings`) is still open, but it's no longer a hard blocker — either side can insert today without being blocked by required columns.

### Step 10.2 — Create the three AI-owned tables (idempotent — safe if the backend already made some of this)

`CREATE TABLE IF NOT EXISTS` alone is not enough here: it's all-or-nothing per table. If the backend already created `transcript` with, say, only `id` and `recording_id`, a plain `CREATE TABLE IF NOT EXISTS` sees the table exists and **skips the whole statement** — the missing columns never get added. That's the opposite of what we want.

So this runs in two layers per table, and both layers are safe to re-run any number of times:

1. `CREATE TABLE IF NOT EXISTS` with just the primary key — creates the table only if it's **entirely** missing. If it already exists in any form, this is a no-op.
2. `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for every column — for each column individually: if it's already there, **skipped, untouched** (whatever type/default the backend gave it stays exactly as-is); if it's missing, added with our definition.

`recordings` must already exist (backend's) before these run, because of the foreign keys. Order: `recordings` (already there) → `analysis` → `topics` (its FK points at `analysis`).

```sql
-- transcript: one row per spoken utterance, FK → recordings
-- NOTE: same situation as analysis below — this table already existed on the shared DB
-- (confirmed 2026-07-08, id bigint, recording_id bigint). CREATE and the recording_id
-- ADD COLUMN are no-ops against the real shared DB; kept correct for a from-scratch environment.
CREATE TABLE IF NOT EXISTS transcript (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
);

ALTER TABLE transcript
  ADD COLUMN IF NOT EXISTS recording_id       bigint REFERENCES recordings(id),
  ADD COLUMN IF NOT EXISTS speaker            text,
  ADD COLUMN IF NOT EXISTS content_raw        text,
  ADD COLUMN IF NOT EXISTS content_clean      text,
  ADD COLUMN IF NOT EXISTS sentence_start_sec numeric,
  ADD COLUMN IF NOT EXISTS sequence_index     integer,
  ADD COLUMN IF NOT EXISTS created_at         timestamptz DEFAULT now();

-- analysis: one row per call
-- NOTE: this table already existed on the shared DB before this script ever ran (confirmed
-- 2026-07-08 — see gotcha below), with id bigint and recording_id bigint. The CREATE and the
-- recording_id ADD COLUMN below are both no-ops against the real shared DB; kept here only so
-- this block is still correct if run against an environment where analysis genuinely doesn't
-- exist yet (e.g. a fresh dev project).
CREATE TABLE IF NOT EXISTS analysis (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
);

ALTER TABLE analysis
  ADD COLUMN IF NOT EXISTS recording_id       bigint REFERENCES recordings(id),
  ADD COLUMN IF NOT EXISTS summary            text,
  ADD COLUMN IF NOT EXISTS key_topics         jsonb,
  ADD COLUMN IF NOT EXISTS objection_analysis jsonb,
  ADD COLUMN IF NOT EXISTS what_went_well     jsonb,
  ADD COLUMN IF NOT EXISTS created_at         timestamptz DEFAULT now();

-- topics: normalized copy of analysis.key_topics, FK → analysis
-- NOTE: topics.id is uuid, NOT bigint like the rest of this schema — this is intentional, not
-- an oversight. The very first attempt at this migration already ran `CREATE TABLE IF NOT EXISTS
-- topics (id uuid ...)` successfully (only the later ADD COLUMN failed and rolled back), so
-- topics.id is already committed as uuid on the shared DB. Nothing references topics.id via FK,
-- so there is no correctness issue — only a cosmetic inconsistency with the rest of the schema,
-- and not worth a DROP TABLE / rebuild to fix.
CREATE TABLE IF NOT EXISTS topics (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY
);

ALTER TABLE topics
  ADD COLUMN IF NOT EXISTS recording_id   bigint REFERENCES recordings(id),  -- bigint, not uuid — see gotcha below
  ADD COLUMN IF NOT EXISTS analysis_id    bigint REFERENCES analysis(id),    -- bigint, not uuid — analysis.id turned out to be bigint too, same gotcha
  ADD COLUMN IF NOT EXISTS name           text,
  ADD COLUMN IF NOT EXISTS start_time     numeric,
  ADD COLUMN IF NOT EXISTS sequence_index integer,
  ADD COLUMN IF NOT EXISTS created_at     timestamptz DEFAULT now();
```

> ⚠️ **Discovered gotcha (2026-07-08): `recordings.id` is `bigint`, not `uuid`.**
> Every design doc up to this point — Step 11's SQL, the data dictionary, and the `transcript`/`analysis` blocks above — assumed `uuid` for every table's primary key, including `recordings.id`. Running the `topics` block above against the shared DB failed:
> ```
> ERROR: 42804: foreign key constraint "topics_recording_id_fkey" cannot be implemented
> DETAIL: Key columns "recording_id" and "id" are of incompatible types: uuid and bigint.
> ```
> `topics` was the only block that errored, not `transcript` or `analysis` — that's a strong signal `transcript.recording_id` / `analysis.recording_id` **already existed** before this cutover (most likely pre-created by the backend), so `ADD COLUMN IF NOT EXISTS` silently skipped them without ever type-checking. `topics` was genuinely new, so it was the first to actually attempt the column and hit the real type.
>
> Because a multi-clause `ALTER TABLE ... ADD COLUMN a, ADD COLUMN b, ...` runs as one atomic statement, the failed `topics` ALTER rolled back completely — `topics` still has only its `id` column, nothing partial to clean up. The `bigint` fix above is safe to run as-is.
>
> **Why we adapt to `bigint` instead of "just making our columns `uuid`":** a foreign-key column *must* be the exact same type as the column it references — this is a hard Postgres rule, not a preference. `topics.recording_id` points at `recordings.id`, and `recordings.id` is `bigint`, so `topics.recording_id` **can only** be `bigint`. Typing it as `uuid` is what produced the `42804` error above — Postgres refuses to create the constraint. So there is no "write it as uuid" option on our side; the FK target's type decides ours. (Changing `recordings.id` itself from `bigint` to `uuid` is technically possible but out of the question — it's the backend's platform-wide primary-key convention, referenced by FKs across ~19 tables; re-typing the whole platform's PK to avoid a one-line frontend fix is the tail wagging the dog. We adapt our code and our column types to their schema, per the §1 merge direction.)
>
> **Before assuming `transcript`/`analysis` are fine, verify — don't guess:**
> ```sql
> SELECT table_name, column_name, data_type
> FROM information_schema.columns
> WHERE table_name IN ('recordings', 'transcript', 'analysis', 'topics')
> ORDER BY table_name, ordinal_position;
> ```
>
> **Result (run against the shared DB, 2026-07-08):**
>
> | table_name | column_name | data_type |
> |---|---|---|
> | analysis | id | bigint |
> | analysis | recording_id | bigint |
> | analysis | summary | text |
> | analysis | key_topics | jsonb |
> | analysis | objection_analysis | jsonb |
> | analysis | what_went_well | jsonb |
> | analysis | created_at | timestamp with time zone |
> | recordings | id | bigint |
> | recordings | organization_id | integer |
> | recordings | recorded_by | uuid |
> | recordings | contact_id | integer |
> | recordings | did_number | text |
> | recordings | caller_number | text |
> | recordings | audio_url | text |
> | recordings | status | text |
> | recordings | duration_seconds | integer |
> | recordings | sip_provider | text |
> | recordings | sip_session_id | text |
> | recordings | agent_config_id | bigint |
> | recordings | call_mode | text |
> | transcript | id | bigint |
> | transcript | recording_id | bigint |
> | transcript | speaker | text |
> | transcript | content_raw | text |
> | transcript | content_clean | text |
> | transcript | sentence_start_sec | numeric |
> | transcript | sequence_index | integer |
> | transcript | created_at | timestamp with time zone |
>
> `topics` doesn't appear — confirming it currently has only its `id` column, nothing else, exactly as predicted.
>
> **Three findings from this:**
> 1. **`transcript` / `analysis` were already fully built, correctly, before we touched anything.** Both existed with `recording_id bigint` matching `recordings.id bigint`. The idempotent design in Step 10.2 worked as intended — every `ADD COLUMN IF NOT EXISTS` on these two tables was a no-op, nothing was altered.
> 2. **A second instance of the same bug: `analysis.id` is `bigint`, not `uuid`.** This wasn't visible until this query — it breaks `topics.analysis_id`, which the original SQL also typed as `uuid`. Fixed in Step 10.2 above (`analysis_id bigint REFERENCES analysis(id)`).
> 3. **`recordings`' own FK-target columns aren't uniformly typed.** `organization_id` and `contact_id` are `integer`; `recorded_by` is `uuid` (consistent with `recorded_by` pointing at `users.id`, which likely inherits `uuid` from Supabase Auth's `auth.users.id`, while `organizations`/`contacts` use plain integer PKs). These are all still NULL today so nothing breaks now, but this matters for §6 complication #3's future FK-fill work — don't assume a single ID type when that code gets written; check each target table's real type first, the same way this section just did for `recordings`.

Column definitions reconstructed from the current write helpers and data dictionary (the `topics` columns match Step 11 verbatim).

**One known gap, called out rather than engineered around:** if the backend already created a column but *without* the foreign key we expect (e.g. `transcript.recording_id` exists as a bare `uuid` with no `REFERENCES recordings(id)`), `ADD COLUMN IF NOT EXISTS` skips it entirely — the FK is never retrofitted, since the column already "exists." Postgres doesn't have `ADD CONSTRAINT IF NOT EXISTS`, so patching a missing FK on an existing column would need a manual check against `information_schema.table_constraints` first. Worth confirming with §10.1-style inspection before assuming the FK is there, rather than building that check preemptively for a case that may not occur.

> **How this was actually run:** all of §10 was executed **by hand as SQL commands in the Supabase SQL editor** — no programmatic connection, no dump/restore tooling. Column list and types were confirmed the same way, by running the `information_schema` queries in §10.1 / the gotcha above directly in the editor and reading the results, rather than trusting the hand-copied definitions here. That manual `information_schema` check is what caught the `bigint` vs `uuid` mismatch before it reached production.

### Step 10.3 — Grant to `service_role` only

Tables made via the SQL editor don't auto-grant roles — this is the `permission denied for table topics` error from Step 11. Skipping this step entirely isn't an option: Postgres default-denies every non-owner role on a new table, including `service_role`, so the very first `writeTopics()` call would hit that same error. What *is* a real choice is the scope — which role(s) actually get granted.

**Checked against the codebase (2026-07-08) rather than assumed:** every read/write to `transcript` / `analysis` / `topics` anywhere in the AI pipeline goes through the `service_role` key — `createRecording`, `writeTranscript`, `writeTopics`, `writeGpuJob`, the `analysis` insert in `lib/llm.ts`, the analysis GET route, and `app/api/transcribe/live/route.ts` (that one's local variable is named `supabase`, but it's constructed with `SUPABASE_SERVICE_ROLE_KEY` — same role). Nothing touches these three tables as `anon` or `authenticated`.

So the earlier Step 11-style grant to `anon, authenticated, service_role` was broader than anything we actually use. `service_role` **is** already, concretely, the AI pipeline's identity — it's the literal key in our `.env.local` — so granting only that role *is* "only AI can write," today, without waiting on the backend to hand us a separate scoped role (§6 #1/#2, §8 — still open, but no longer blocking this step):

```sql
GRANT ALL ON TABLE transcript, analysis, topics TO service_role;
```

If the backend later provisions a dedicated non-`service_role` identity for us, swap the target role here — the SQL itself doesn't change, only who it's granted to. If the backend's own sync jobs (CRM push, per v3's Phase 3) need to *read* `analysis`, that's a separate, additive `GRANT SELECT ON TABLE analysis TO <their role>` — not something this step needs to anticipate.

### Step 10.4 — Verify

```sql
-- All three tables exist
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('transcript', 'analysis', 'topics');

-- Foreign keys resolve to the right parent tables
SELECT tc.table_name, kcu.column_name, ccu.table_name AS references_table
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_name = ccu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name IN ('transcript', 'analysis', 'topics');
```

Expected: `topics.analysis_id → analysis`, `topics.recording_id → recordings`, `transcript.recording_id → recordings`, `analysis.recording_id → recordings`.

**Result (run against the shared DB, 2026-07-08) — ✅ confirmed, matches expected exactly:**

| table_name | column_name | references_table |
|---|---|---|
| transcript | recording_id | recordings |
| analysis | recording_id | recordings |
| topics | analysis_id | analysis |
| topics | recording_id | recordings |

**§10 is done.** All three AI-owned tables exist on the shared DB with the correct (backend-matching `bigint`) FK types, `service_role` has been granted, and every foreign key resolves to its intended parent. The remaining work to actually cut over is application-level, not SQL — see below.

### After the SQL: re-point the client

The DDL above only prepares the DB. To actually cut over, update `NEXT_PUBLIC_SUPABASE_URL` + keys (local, Vercel preview, Vercel prod) to the shared project, apply the write-strategy code change from §7 (create → lookup + UPDATE for `recordings`), and rotate the old project's keys. Those are code/config steps, not SQL. §11 is the full inventory of what those steps touch.

---

## 11. Bindings to update (what "re-point the client" actually touches)

Inventoried against the codebase 2026-07-08. A "database binding" is any place that holds a connection to the old Supabase project — env vars, client construction, or a hardcoded URL/key.

### Every binding is 3 code sites + 1 env file, all inside `ai-pipeline/`

| Location | What it binds | Env vars read |
|---|---|---|
| `lib/supabase.ts:7-15` | Builds `supabase` (anon) and `supabaseAdmin` (service) — the clients nearly everything imports | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| `app/api/transcribe/live/route.ts:4-7` | Builds its **own** inline client — does *not* import from `lib/supabase.ts` | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| `scripts/verify-step11-schema.ts:7-9` | Its own inline client (dev/verify tool) | same two |
| `.env.local` | **Where the actual URL + keys live** — the source of all three values above | — |

**Two things this inventory confirms:**
1. **No hardcoded `*.supabase.co` URLs anywhere.** Every binding flows through env vars, so the value change is centralized: swap the three vars in `.env.local` (and in Vercel per environment) and all three code sites repoint at once.
2. **The three client constructions are independent** — the transcribe/live route and the verify script don't reuse `lib/supabase.ts`. An env swap covers all three (same vars), but changing `lib/supabase.ts` alone would *not* catch a hardcoded fallback if one were ever added to the other two.

> ### ⚠️ Everyone must set these three in their own `.env.local`
>
> These live in `.env.local`, which is git-ignored — it is **not** in the repo, so cloning does not give them to you. Each person has to fill in their own. **Do not commit them and do not paste the keys into chat/Slack** — pull them yourself from the shared project's dashboard (**Settings → API**).
>
> | Var | Where to get it | Same for everyone? |
> |---|---|---|
> | `NEXT_PUBLIC_SUPABASE_URL` | `https://rjhjveatqnwxbnfrthsr.supabase.co` | ✅ Yes — the shared project URL, identical for all. |
> | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Settings → API → Project API keys → `anon` / publishable | Shared today (one project key). Would only differ per person if the backend later issues per-developer keys. |
> | `SUPABASE_SERVICE_ROLE_KEY` | Settings → API → Project API keys → `service_role` (secret) | Shared today (one project secret). This is the value that *would* become per-person if the backend gives each of us a scoped AI role instead of the shared service key (see §6 #1-2, §8). |
>
> **Note on "same vs. different per person":** on a single shared Supabase project, all three are actually the same value for everyone right now — the reason to grab your own is security hygiene (secrets never travel through chat or git), not that the values differ. The two keys only become genuinely per-person *if* the backend provisions individual scoped roles/keys, which is the still-open §6 / §8 access-model decision. Until that lands, expect all three identical.

### Previous demos — no per-demo binding to change

The batch flow, live/demo UI, and Step-12 frontend all reach the DB *through API routes → `lib/supabase.ts` (+ the inline transcribe/live client)*. None construct a Supabase client of their own, so repointing the env vars migrates every demo at once.

### SIP pipeline — has **no** DB binding today

`sip/scripts/step2_stt_bridge.py` does not touch Supabase at all. It bridges audio → Modulate STT → Groq → ElevenLabs → Asterisk ARI; its only outbound calls are `requests.post` to ARI (`http://localhost:8088/ari/...`). Its "transcript" references are an in-memory `queue.Queue`, not the DB table.

So there is nothing to repoint on the SIP side — but per §7 and the v3 data flow, the SIP layer is the component that *should* create the `recordings` row at call-start. When that write is added, it is a **new** binding (a Supabase or `pg` client in Python) that must target the shared DB from day one and use the writer identity from §6/§8. This is the one place the migration adds new code rather than repointing existing code.

### Gotchas when repointing

| Gotcha | Detail |
|---|---|
| **`NEXT_PUBLIC_` vars are baked at build time** | `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` are compiled into the client bundle. They must be set in Vercel for each environment (preview, prod) *before* the build, not just in local `.env.local`. |
| **Bigint IDs break two demo display lines** | §10 established IDs are `bigint`, so `createRecording` now returns a **number**, not a uuid string. `app/demo/page.tsx:318` and `app/batch/page.tsx:131` call `recordingId.slice(0, 8)` — a String method — which throws `TypeError` on a number. Fix: `String(recordingId).slice(0, 8)`, and widen the `useState<string \| null>` type to include `number`. |
| **Demo keeps `createRecording`; SIP path does not** | §7's "SIP layer inserts `recordings`" applies only to the SIP call path. The browser demo has no call-start event, so it must still `createRecording` itself. Don't remove it from the demo path thinking §7 said to. |
| **Grants already done** | `service_role` was granted in §10.3, and every demo/API write uses `service_role`, so writes are authorized on the shared DB with no further grant. |
| **Linking is preserved automatically** | `transcript.recording_id → recordings` FK is live on the shared DB (§10.4). As long as the demo creates the recording first and streams transcript rows under that `recording_id` (which it already does), the STT data lands linked — no extra step. |

### Stale-schema fixes applied (2026-07-08)

Pointing the app at the shared DB surfaced several places where demo/test code still assumed the *pre-Step-11* schema. All fixed; recorded here so the migration record is complete and the pattern is recognizable if more turn up.

| # | File | Was | Problem | Fix |
|---|---|---|---|---|
| 1 | `app/demo/page.tsx:106` | `body: JSON.stringify({ call_metadata: {} })` | `call_metadata` column was dropped in Step 11; `createRecording` passes the whole body into `.insert()`, so PostgREST rejected it: *"Could not find the 'call_metadata' column of 'recordings' in the schema cache."* This is what made **Start Live** fail with a "failed" banner. | `body: JSON.stringify({})` |
| 2 | `app/demo/page.tsx:318`, `app/batch/page.tsx:131` | `recordingId.slice(0, 8)` | IDs are now `bigint` (number), and `.slice` is a String method → `TypeError` at render. | `String(recordingId).slice(0, 8)` + widen `useState` to `string \| number \| null` |
| 3 | `app/api/transcribe/route.ts:28` | `createRecording({ filename: file.name })` | `filename` is not a `recordings` column (never was post-Step-11) → same "column not found" write failure for the `/batch` upload flow. | `createRecording({})` — filename isn't persisted; no column exists for it |
| 4 | `scripts/test-transcript.ts:31` | `createRecording({ rep, client, source })` | Same class — `rep`/`client`/`source` aren't columns. Broke the transcript test script. | `createRecording({})` |

**Diagnostic that pinned #1 fast:** `curl -s -X POST .../api/recordings/create -d '{}'` returned `{"recording_id":2}` — an empty body wrote fine, proving the DB / grant / insert all worked. Only the demo (sending `call_metadata`) failed. When a write 500s, curl with an empty body first: it separates "the DB rejects us" from "our payload is wrong."

**Takeaway:** these were latent before the migration — they'd have failed against the old DB too once Step 11 dropped those columns; they just weren't exercised until now. Anything that writes to `recordings` should send only real columns (see §10.1 / the data dictionary for the authoritative list). After these fixes, `npx tsc --noEmit` is clean.

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

Once we're on the shared DB, how does the AI pipeline write to it? Three options.

### Option 2A: Direct shared-DB access

Our `supabase-js` client points at the backend's project URL and keys. Writes go straight to the shared tables, exactly like today — only the connection target changes.

```
┌──────────────────────────┐
│   AI Pipeline (Vercel)   │
│   supabase-js client     │
└────────────┬─────────────┘
             │ direct writes
             ▼
┌──────────────────────────┐
│  Shared Supabase (backend)│
│  recordings / transcript  │
│  analysis / topics /gpu_jobs│
└──────────────────────────┘
```

| Pros | Cons |
|---|---|
| Smallest code change — env vars + the drift patch in §5 | AI holds a key into the shared prod DB (blast radius) |
| Keeps the real-time transcript write path fast (no extra hop) | Two teams write the same tables with no API contract enforcing invariants |
| Unblocks the FK-fill work immediately | Must fit into the backend's RLS model (see §6) |
| No dependency on the API team building endpoints | — |

### Option 2B: API-mediated writes

The AI pipeline stops touching Supabase directly. It calls backend/API-team endpoints (`POST /calls/start`, a transcript-write route, `POST /analysis-ready/:id`). The backend owns every write, validation, and RLS.

```
┌──────────────────────────┐
│   AI Pipeline (Vercel)   │
└────────────┬─────────────┘
             │ POST /calls/start, /transcribe, /analysis-ready
             ▼
┌──────────────────────────┐
│  Backend API (Vercel)    │  ← owns all writes, validation, RLS
└────────────┬─────────────┘
             │ writes
             ▼
┌──────────────────────────┐
│  Shared Supabase (backend)│
└──────────────────────────┘
```

| Pros | Cons |
|---|---|
| AI never holds a DB key — cleanest security boundary | Every transcript utterance round-trips an extra API hop → latency + a failure point on the hot path |
| Backend enforces ownership, validation, invariants in one place | Blocked on the API team building and maintaining those routes |
| Matches the v3 architecture diagram literally | Most code change on our side (replace every DB helper with an HTTP call) |
| — | Real-time per-sentence writes (hundreds/call) are the worst fit for this |

### Option 2C: Keep split DBs, bridge by `sip_session_id`

Federated: our DB keeps `transcript` / `analysis` / `topics`, the backend keeps everything else, and the two link by `sip_session_id`. This is what the v3 doc's "Tables owned by AI team (not in our DB)" line literally diagrams.

| Pros | Cons |
|---|---|
| No migration at all | **Rejects the stated goal** — this is *not* a shared database |
| Each team fully owns its instance | Every cross-table read (recording → its transcript) is a cross-DB join done in app code |
| — | Two RLS models, two backup policies, two sources of truth to keep consistent |
| — | The exact fragmentation Danish's "one shared table" direction was meant to kill |

### Decision 2 recommendation: **Direct access now (2A), phase toward API-mediation for low-frequency writes later**

The deciding factor is the **transcript write path.** Transcript rows are written in real time, per utterance, hundreds per call. Routing those through an extra API hop (2B) adds latency and a failure point exactly where we can least afford it. Direct DB access (2A) keeps that path as fast as it is today and is the smallest change to ship.

2C is off the table by the premise: it is the opposite of a shared database.

So the recommendation is phased:

- **Phase 1 (now, test data):** 2A direct access. Repoint the client, apply the §5 drift patch, clean-cutover the data. Fastest route to a single source of truth, and it unblocks filling in the FK fields as soon as the backend's `organizations` / `users` / `contacts` rows exist.
- **Phase 2 (pre-production):** move the **low-frequency, cross-cutting** writes behind the backend API where ownership and validation matter most — the call-start `recordings` insert and the `analysis-ready` notification. Keep the **high-frequency** `transcript` / `analysis` / `topics` writes on direct DB access (scoped key + RLS), since they're the AI team's owned tables and the latency-sensitive path.

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
| 3 | **FK constraints become real** | Today `organization_id` / `recorded_by` / `contact_id` are NULL, so nothing enforces them. On the shared DB with real data, inserting a `recordings` row may require those rows to exist first. | Confirm which FKs are `NOT NULL` on the shared DB. If `organization_id` becomes required, our call-start path is **blocked** until the backend's org/user provisioning runs. Keep them nullable for the MVP window, or coordinate ordering. |
| 4 | **Stub-table collision** | Our `organizations` / `users` / `contacts` stubs would conflict with the backend's real tables on a shared DB. | Clean cutover (Decision 1A) handles this: we don't bring our stubs. We drop them and use the backend's. |
| 5 | **Ownership boundary is ambiguous in v3** | v3's "our group owns these" table lists `recordings` and `gpu_jobs`, but its diagram also says `transcript` / `analysis` / `topics` are "AI team (not in our DB)." On a shared DB, "not in our DB" no longer holds. | Settle write-ownership explicitly: who inserts the `recordings` row at call-start — the SIP layer's `POST /calls/start`, or the AI pipeline? This changes our code. See §7. |
| 6 | **Grants on SQL-created tables** | Step 11 hit `permission denied for table topics` because tables made via the SQL editor don't auto-grant roles. | If the backend creates tables the same way, the AI writer role needs explicit `GRANT`. Flag it so it's not re-discovered at demo time. |
| 7 | **Environment + secrets** | We move from our `.env.local` Supabase URL/keys to the backend's. | New `NEXT_PUBLIC_SUPABASE_URL`, anon key, and the scoped writer key in every environment (local, Vercel preview, Vercel prod). Rotate the old keys after cutover. |
| 8 | **Migration ordering / FK creation order** | Same lesson as Step 11: `organizations` before `users`/`contacts` before `recordings` before `transcript`. | On a shared DB the backend owns this, but our cutover must run *after* their base tables exist. |

The two that can actually block us are **#3 (required FKs)** and **#1/#2 (RLS + key model)**. Both are backend decisions we need answers on before cutover, not after.

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
| **Required vs nullable FKs** | Is `recordings.organization_id` `NOT NULL` on the shared DB? (Complication #3) | Backend |
| **`analysis-ready` notification** | Direct DB write of `status = 'summarized'`, or `POST /analysis-ready/:id` to the backend? (Decides Phase 2 scope) | Backend + AI |

---

## 9. Final decision

| Dimension | Current | Planned |
|---|---|---|
| **Database instance** | Two separate Supabase projects | One shared Supabase project (backend-owned) |
| **Data-move strategy** | — | Clean cutover, no ETL (all test data) |
| **Integration architecture** | Direct writes, our own project | Phase 1: direct writes to shared DB. Phase 2: low-frequency writes (`recordings` create, `analysis-ready`) via backend API; keep `transcript`/`analysis`/`topics` direct |
| **Schema** | June 6 alignment (Step 11) | Patch drift: add `sip_session_id`, `call_mode`, `agent_config_id` to `recordings` |
| **Access / security** | Full service-role key on a throwaway project | Scoped AI-writer role on the shared prod DB; RLS model agreed with backend |
| **Stub tables** | AI holds stub `organizations`/`users`/`contacts` | Dropped — use the backend's real tables |

**Recommendation in one line:** clean-cutover onto the backend's shared Supabase with **direct DB access** now (fastest, keeps the real-time transcript path fast, unblocks the FK work), patch the small schema drift, and phase the low-frequency cross-team writes behind the backend API later once the RLS and key model are settled. Because everything today is test data, we get to skip the entire migration-ETL problem — the move is mostly re-pointing the client and agreeing the access boundary, not moving data.

**Blocked-on-backend before we can cut over:** the required-FK answer (#3) and the AI-writer role + RLS model (#1/#2). Everything else on our side is ready.

---

## 10. Cutover SQL

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
SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_name = 'recordings'
ORDER BY ordinal_position;
```

If `recordings` is missing `sip_session_id` / `call_mode` / `agent_config_id`, that ALTER is the **backend's** to run (hand them the §5 delta), not ours.

### Step 10.2 — Create the three AI-owned tables

`recordings` must already exist (backend's) before these run, because of the foreign keys. Order: `recordings` (already there) → `analysis` → `topics` (its FK points at `analysis`).

```sql
-- transcript: one row per spoken utterance, FK → recordings
CREATE TABLE IF NOT EXISTS transcript (
  id                 uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  recording_id       uuid REFERENCES recordings(id),
  speaker            text,
  content_raw        text,
  content_clean      text,
  sentence_start_sec numeric,
  sequence_index     integer,
  created_at         timestamptz DEFAULT now()
);

-- analysis: one row per call
CREATE TABLE IF NOT EXISTS analysis (
  id                 uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  recording_id       uuid REFERENCES recordings(id),
  summary            text,
  key_topics         jsonb,
  objection_analysis jsonb,
  what_went_well     jsonb,
  created_at         timestamptz DEFAULT now()
);

-- topics: normalized copy of analysis.key_topics, FK → analysis
CREATE TABLE IF NOT EXISTS topics (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  recording_id   uuid REFERENCES recordings(id),
  analysis_id    uuid REFERENCES analysis(id),
  name           text,
  start_time     numeric,
  sequence_index integer,
  created_at     timestamptz DEFAULT now()
);
```

The `topics` block is verbatim from Step 11. `transcript` / `analysis` are reconstructed from the current write helpers and data dictionary.

> **More reliable than hand-typing — dump the authoritative schema from our current project:**
> ```bash
> pg_dump "$OLD_SUPABASE_DB_URL" \
>   --schema-only --no-owner \
>   -t transcript -t analysis -t topics
> ```
> Use the exported `CREATE TABLE` statements to build on the shared DB. This guarantees the tables match what we've actually been running, with no dropped column or type drift from a hand-copied version.

### Step 10.3 — Grant to the AI writer role

Tables made via the SQL editor don't auto-grant roles — this is the `permission denied for table topics` error from Step 11. Grant immediately after creating. The target role depends on the write-identity the backend gives us (§6 complications #1/#2, still open):

```sql
-- Replace <ai_writer_role> with the role the backend provisions for us.
GRANT ALL ON TABLE transcript, analysis, topics TO <ai_writer_role>;

-- If the interim model is still the service key, this matches Step 11:
-- GRANT ALL ON TABLE transcript, analysis, topics TO anon, authenticated, service_role;
```

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

### After the SQL: re-point the client

The DDL above only prepares the DB. To actually cut over, update `NEXT_PUBLIC_SUPABASE_URL` + keys (local, Vercel preview, Vercel prod) to the shared project, apply the write-strategy code change from §7 (create → lookup + UPDATE for `recordings`), and rotate the old project's keys. Those are code/config steps, not SQL.

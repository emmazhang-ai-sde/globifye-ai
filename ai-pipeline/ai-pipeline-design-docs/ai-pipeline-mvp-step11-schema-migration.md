# Step 11 — Schema Migration: Multi-Tenant Supabase Update

## Context

Two inputs drove this step:

**1. June 1, 2026 — PM Danish's feedback after the demo**

Danish gave one structural action item for the AI pipeline:

> "Redesign the transcription table for multi-tenant scalability."
> - All tenants share **one table** — never create separate tables or databases per company
> - Each transcription row must reference a single **recording UUID** as a foreign key
> - Tag each row to the company and user it belongs to; access control handles visibility at query time
> - Scale estimate: 20 salespersons × 100 calls/day = 2,000 transcription rows/day across two companies

**2. June 6, 2026 — Backend team schema (`2026-06-06-backend-db-schema.md`)**

Abraham/Kim shared the authoritative platform-wide schema. This is the schema every team must conform to. The AI pipeline was built in isolation with 3 tables; the backend defines 17. This step aligns our code to their schema.

---

## Schema Delta: Old vs. New

### `recordings` — major rework

| Field | Old | New | Action |
|---|---|---|---|
| `call_metadata` | ✅ catch-all JSON | ❌ removed | **Drop** — replaced by explicit columns |
| `organization_id` | ❌ | ✅ FK → organizations | **Add** (required, tenant anchor) |
| `recorded_by` | ❌ | ✅ FK → users | **Add** (who started the call) |
| `contact_id` | ❌ | ✅ FK → contacts | **Add** (CRM contact for this call) |
| `did_number` | ❌ | ✅ varchar | **Add** (org's DID phone number) |
| `caller_number` | ❌ | ✅ varchar | **Add** (inbound caller's number) |
| `status` | ❌ | ✅ varchar | **Add** (`in_progress` / `completed` / `failed`) |
| `duration` | ✅ | renamed | **Rename** → `duration_seconds` |
| `sip_provider` | ❌ | ✅ varchar | **Add** (which SIP provider handled the call) |
| `audio_url` | ✅ | ✅ | No change |
| `created_at` | ✅ | ✅ | No change |

### `transcript` — one addition

| Field | Status |
|---|---|
| `sequence_index` | **Add** — integer, ordering counter per recording |
| Everything else | No change |

Multi-tenancy on transcript is **inherited** — `recording_id → recordings.organization_id`. No direct `organization_id` on transcript rows (this is the correct normalized approach; Danish's requirement is satisfied via the FK chain).

### `analysis` — one removal

| Field | Status |
|---|---|
| `raw_llm_output` | **Drop** — removed from backend schema |
| `summary`, `key_topics`, `objection_analysis`, `what_went_well` | No change |

### New: `topics` table

Normalized form of `key_topics`. Backend schema defines it separately alongside the JSONB field in `analysis`.

| Field | Type |
|---|---|
| `id` | uuid, PK |
| `recording_id` | uuid, FK → recordings |
| `analysis_id` | uuid, FK → analysis |
| `name` | text |
| `start_time` | numeric (seconds) |
| `sequence_index` | integer |

### New: `gpu_jobs` table

Log every AI job for usage tracking and future billing.

| Field | Type |
|---|---|
| `id` | uuid, PK |
| `organization_id` | uuid, FK → organizations |
| `recording_id` | uuid, FK → recordings |
| `job_type` | varchar (`transcription` / `analysis`) |
| `status` | varchar (`completed` / `failed`) |
| `compute_units` | numeric (nullable for now) |
| `cost` | numeric (nullable for now) |
| `created_at` | timestamptz |

---

## Technical Decisions

### Decision 1: Multi-tenancy via shared table + FK chain (not RLS yet)

**Danish's requirement:** never create separate tables per tenant. All orgs share the same `recordings` and `transcript` tables.

**Approach:** Every `recordings` row carries `organization_id`. `transcript` rows reach their org via `recording_id → recordings.organization_id`. Query-time filtering is done in application code for now (e.g., `WHERE recordings.organization_id = $orgId`).

**Why not RLS yet:** Abraham's backend note says RLS is deferred — use Supabase default security for now. We follow the same decision: add `organization_id` to the schema, but do not implement RLS policies in this step. That is a backend concern.

---

### Decision 2: Keep `analysis.key_topics` JSONB AND write to `topics` table

The backend schema keeps both:
- `analysis.key_topics` — JSONB array (what the LLM returns directly)
- `topics` table — normalized rows (enables indexing, future CRM webhook pushes per topic)

**Our approach:** After the LLM call, write `key_topics` into `analysis.key_topics` as before, then loop through the array and insert individual rows into `topics`. This is two writes but zero extra LLM cost.

**Why not drop JSONB:** The `analysis` row is the canonical LLM output record. Keeping the raw JSON there makes the `analysis` row self-contained for debugging and future LLM output comparison.

---

### Decision 3: Drop `raw_llm_output`

The backend schema removed this field. We had added it for debugging (May 20 decision: "keep it — useful for debugging and auditing"). Since the backend schema no longer has it, we align and remove it.

If debug logging is needed in the future, it belongs in `gpu_jobs.raw_payload` (a similar pattern the backend uses in `payment_logs`), not in the `analysis` table.

---

### Decision 4: `sequence_index` tracked as an in-memory counter per session

The `transcript` table needs `sequence_index` to guarantee row ordering independent of `created_at` (rapid consecutive utterances can have identical timestamps at millisecond resolution).

**Approach:** In `startLive()`, initialize a local `sequenceIndexRef = useRef(0)`. Increment it by 1 on each `speech_final` event before calling `/api/transcribe/live`. Reset to 0 when a new recording session starts.

---

### Decision 5: `gpu_jobs` write is fire-and-forget

After `/api/analyze` successfully writes to the `analysis` table, insert a row into `gpu_jobs`. `compute_units` and `cost` are `null` for now — billing calculation is the backend team's responsibility. A failure to write `gpu_jobs` must not block or roll back the analysis write.

---

## Implementation: Step-by-Step

### Step 11.1 — Run SQL migrations in Supabase

Open the Supabase SQL editor and run the following in order.

**11.1.a — Alter `recordings`**

```sql
ALTER TABLE recordings
  DROP COLUMN IF EXISTS call_metadata,
  ADD COLUMN organization_id uuid REFERENCES organizations(id),
  ADD COLUMN recorded_by uuid REFERENCES users(id),
  ADD COLUMN contact_id uuid REFERENCES contacts(id),
  ADD COLUMN did_number varchar,
  ADD COLUMN caller_number varchar,
  ADD COLUMN status varchar DEFAULT 'in_progress',
  ADD COLUMN sip_provider varchar,
  ADD COLUMN duration_seconds numeric;

-- rename old duration column if it exists
ALTER TABLE recordings RENAME COLUMN duration TO duration_seconds;
```

> Note: if the `organizations`, `users`, and `contacts` tables don't exist yet in your dev Supabase, create them first (even as empty stubs) so the FK constraints don't fail.

```sql
 -- 1. organizations (users 和 contacts 都依赖它，先建)
  CREATE TABLE IF NOT EXISTS organizations (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    name text,
    created_at timestamptz DEFAULT now()
  );

  -- 2. users (depends on organizations)
  CREATE TABLE IF NOT EXISTS users (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id uuid REFERENCES organizations(id),
    email text,
    role text,
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now()
  );
  
  -- 3. contacts (depends on organizations)
  CREATE TABLE IF NOT EXISTS contacts (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id uuid REFERENCES organizations(id),
    apollo_id text,
    hubspot_id text,
    name text,
    email text,
    phone text,
    company text,
    created_at timestamptz DEFAULT now()
  );

```

**11.1.b — Alter `transcript`**

```sql
ALTER TABLE transcript
  ADD COLUMN sequence_index integer;
```

**11.1.c — Alter `analysis`**

```sql
ALTER TABLE analysis
  DROP COLUMN IF EXISTS raw_llm_output;
```

**11.1.d — Create `topics`**

```sql
CREATE TABLE topics (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  recording_id uuid REFERENCES recordings(id),
  analysis_id uuid REFERENCES analysis(id),
  name text,
  start_time numeric,
  sequence_index integer,
  created_at timestamptz DEFAULT now()
);
```

**11.1.e — Create `gpu_jobs`**

```sql
CREATE TABLE gpu_jobs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id),
  recording_id uuid REFERENCES recordings(id),
  job_type varchar,
  status varchar,
  compute_units numeric,
  cost numeric,
  created_at timestamptz DEFAULT now()
);
```

---

### Step 11.2 — Update `lib/supabase.ts`

**Replace `createRecording`** (the entire function, currently takes `metadata: Record<string, unknown>`):

> ⚠️ Implement the full function body — do not leave `{ ... }` as a placeholder. Same applies to `writeTopics` and `writeGpuJob` below.

```typescript
export async function createRecording(params: {
  organization_id?: string
  recorded_by?: string
  contact_id?: string
  did_number?: string
  caller_number?: string
  audio_url?: string
  status?: string
  duration_seconds?: number
  sip_provider?: string
} = {}): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('recordings')
    .insert(params)
    .select('id')
    .single()

  if (error) throw new Error(`Failed to create recording row: ${error.message}`)
  return data.id
}
```

**Add two new helpers at the end of the file:**

```typescript
export async function writeTopics(topics: {
  recording_id: string
  analysis_id: string
  name: string
  start_time: number
  sequence_index: number
}[]): Promise<void> {
  if (topics.length === 0) return
  const { error } = await supabaseAdmin.from('topics').insert(topics)
  if (error) throw new Error(`Topics write failed: ${error.message}`)
}

export async function writeGpuJob(params: {
  organization_id?: string
  recording_id: string
  job_type: string
  status: string
}): Promise<void> {
  await supabaseAdmin.from('gpu_jobs').insert(params)
  // fire-and-forget — intentionally no error throw
}
```

---

### Step 11.3 — Update `app/api/recordings/create/route.ts`

Only one line changes — replace `createRecording(body.call_metadata ?? {})` with `createRecording(body)`. The new `createRecording` accepts the full body directly; all new fields are optional so an empty body still works.

```typescript
import { NextResponse } from 'next/server'
import { createRecording } from '@/lib/supabase'

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const recordingId = await createRecording(body)   // was: createRecording(body.call_metadata ?? {})
    return NextResponse.json({ recording_id: recordingId })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
```

---

### Step 11.4 — Update `app/api/transcribe/live/route.ts` + `app/frontend/page.tsx`

**route.ts — two lines change:**

```typescript
// line 10: add sequence_index to destructure
const { recording_id, speaker, content_raw, sentence_start_sec, sequence_index } = await req.json();

// insert block: add sequence_index
const { error } = await supabase.from('transcript').insert({
  recording_id,
  speaker,
  content_raw,
  content_clean: content_raw.trim(),
  sentence_start_sec,
  sequence_index,        // add this
});
```

**page.tsx — three places:**

1. Near the other `useRef` declarations, add:
```typescript
const sequenceIndexRef = useRef(0)
```

2. In `startLive()`, in the session-reset block (where `accumulatedRef.current = ''` is), add:
```typescript
sequenceIndexRef.current = 0
```

3. In the `speech_final` block, add `sequence_index` to the `/api/transcribe/live` fetch body:
```typescript
body: JSON.stringify({
  recording_id: liveRecordingId,
  speaker,
  content_raw: fullUtterance,
  sentence_start_sec: startSec,
  sequence_index: sequenceIndexRef.current++,   // add this — post-increment
}),
```

---

### Step 11.5 — Update `lib/llm.ts`

All changes are in `lib/llm.ts`. `app/api/analyze/route.ts` does not need to change.

**1. Replace the existing `supabase` import at the top of the file:**

> ⚠️ `lib/llm.ts` already has `import { supabaseAdmin } from './supabase'`. Replace that line with the one below — do not add a second import line or TypeScript will error on the duplicate `supabaseAdmin` identifier. Also remove any comments referencing `raw_llm_output` that may be left over from the old implementation.

```typescript
import { supabaseAdmin, writeTopics, writeGpuJob } from './supabase'
```

**2. In `analyzeTranscript` — remove `includeRaw`, return only `parsed`:**

Replace:
```typescript
const structuredModel = model.withStructuredOutput(AnalysisSchema, { includeRaw: true })
const { raw, parsed } = await structuredModel.invoke([
  { role: 'system', content: SYSTEM_PROMPT },
  { role: 'user', content: `Analyze the following sales call transcript:\n\n${transcriptText}` },
])
const rawOutput = typeof raw.content === 'string'
  ? raw.content
  : JSON.stringify(raw.content)
return { parsed, rawOutput }
```

With:
```typescript
const structuredModel = model.withStructuredOutput(AnalysisSchema)
const parsed = await structuredModel.invoke([
  { role: 'system', content: SYSTEM_PROMPT },
  { role: 'user', content: `Analyze the following sales call transcript:\n\n${transcriptText}` },
])
return { parsed }
```

**3. In `writeAnalysis` — remove `raw_llm_output`, add `writeTopics` + `writeGpuJob`:**

Replace the entire function body:
```typescript
export async function writeAnalysis(recordingId: string) {
  const { parsed } = await analyzeTranscript(recordingId)

  const { data, error } = await supabaseAdmin
    .from('analysis')
    .insert({
      recording_id:       recordingId,
      summary:            parsed.summary,
      key_topics:         parsed.key_topics,
      objection_analysis: parsed.analysis.objections,
      what_went_well:     parsed.analysis.what_went_well,
    })
    .select()
    .single()

  if (error) throw new Error(`DB insert failed: ${error.message}`)

  await writeTopics(
    parsed.key_topics.map((t, i) => ({
      recording_id:   recordingId,
      analysis_id:    data.id,
      name:           t.name,
      start_time:     t.start_time,
      sequence_index: i,
    }))
  )

  writeGpuJob({ recording_id: recordingId, job_type: 'analysis', status: 'completed' })

  return data
}
```

---

### Step 11.6 — Zod schema in `lib/llm.ts`

No changes needed. `raw_llm_output` was never part of the Zod schema — it was derived from `includeRaw: true`, which Step 11.5 already removed.

---

### Step 11.7 — End-to-End Test

1. Run `npm run dev`, open the live UI
2. Start a session, speak a few sentences, stop
3. Check Supabase table viewer:
   - `recordings` — new columns present (SIP fields will be `null`, that's fine) ✓
   - `transcript` — `sequence_index` increments from 0 per utterance ✓
4. Click "Analyze Call"
5. Check Supabase table viewer:
   - `analysis` — row written, no `raw_llm_output` column ✓
   - `topics` — one row per key topic, `sequence_index` matches array order ✓
   - `gpu_jobs` — one row with `job_type: 'analysis'`, `status: 'completed'` ✓

**Known issue: `Topics write failed: permission denied for table topics`**

Tables created via the Supabase SQL editor do not automatically receive role grants (unlike tables created through the Supabase UI). If you see this error, run the following in the SQL editor before retrying:

```sql
GRANT ALL ON TABLE topics TO anon, authenticated, service_role;
GRANT ALL ON TABLE gpu_jobs TO anon, authenticated, service_role;
```

`gpu_jobs` is granted at the same time — it was created the same way and will hit the identical error if not fixed preemptively.

---

## Files to Touch

| File | Change |
|---|---|
| Supabase SQL editor | Run migrations 11.1.a – 11.1.e |
| `lib/supabase.ts` | Update `createRecording`, add `writeTopics` + `writeGpuJob` |
| `app/api/recordings/create/route.ts` | New fields, drop `call_metadata` |
| `app/api/transcribe/live/route.ts` | Accept + pass `sequence_index` |
| `lib/llm.ts` | Remove `includeRaw`, drop `raw_llm_output` from DB write, add `writeTopics` + `writeGpuJob` calls |
| `app/frontend/page.tsx` | Add `sequenceIndexRef`, increment on speech_final, reset on stop |

---

## What This Step Does NOT Cover

- **RLS (Row Level Security)** — deferred per Abraham's backend note; this is a backend concern
- **SIP-sourced fields** (`did_number`, `caller_number`, `sip_provider`, `contact_id`) — these will be populated by Abraham/Kim's SIP layer; our routes accept them as optional for now
- **`compute_units` / `cost` calculation** — `gpu_jobs` rows are written with these as `null`; billing logic is Wil's responsibility
- **`organizations` / `users` / `contacts` stub tables** — if they don't exist in your dev Supabase yet, create empty versions so FK constraints don't block local testing

# AI Pipeline MVP — Step-by-Step Outline

**Project:** GlobiFYE Sales Call System
**Goal:** End-to-end working demo — audio file in → transcript stored → analysis out
**Stack:** Next.js + Vercel + Supabase + Deepgram Nova-3 + LLM (TBD)
**Demo deadline:** Monday, May 27, 2026

---

## Context

Shuyang is a GlobiFYE SD intern. The PM (Danish Parray) asked for a working end-to-end AI pipeline prototype to demo on Monday, May 27, 2026. Today is Saturday May 24. The pipeline must cover two phases from the pipeline diagram:

- **Phase 1 (During Call):** Audio → Deepgram STT → Partial Results (UI captions) + Final Results (DB writes)
- **Phase 2 (Post-call):** Button-triggered → single LLM call → structured JSON → DB + UI

No code exists yet — only architecture docs. This plan builds the MVP step by step without writing code directly.

---

## MVP Scope

For the Monday demo: **audio file in → transcript stored → analysis out**. A minimal working proof-of-concept, not a polished UI. Real-time WebSocket streaming can be layered in after the core pipeline validates.

---

## Step-by-Step Outline

### Step 1 — Project Setup

#### 1.1 Create the Next.js project

Run in your terminal (pick a location for the project folder):

```bash
npx create-next-app@latest globifye-pipeline
```

When prompted, answer:

```bash
Need to install the following packages:
create-next-app@16.2.6
Ok to proceed? (y) 
✔ Would you like to use the recommended Next.js defaults? › No, customize settings
✔ Would you like to use TypeScript? … No / Yes
✔ Which linter would you like to use? › ESLint
✔ Would you like to use React Compiler? … No / Yes
✔ Would you like to use Tailwind CSS? … No / Yes
✔ Would you like your code inside a `src/` directory? … No / Yes
✔ Would you like to use App Router? (recommended) … No / Yes
✔ Would you like to customize the import alias (`@/*` by default)? … No / Yes
✔ Would you like to include AGENTS.md to guide coding agents to write up-to-date Next.js code? … No / Yes
```
```
Creating a new Next.js app in /Users/shuyangzhang/globifye-pipeline.

Using npm.

Initializing project with template: app-tw 


Installing dependencies:
- next
- react
- react-dom

Installing devDependencies:
- @tailwindcss/postcss
- @types/node
- @types/react
- @types/react-dom
- eslint
- eslint-config-next
- tailwindcss
- typescript


added 360 packages, and audited 361 packages in 14s

143 packages are looking for funding
  run `npm fund` for details

2 moderate severity vulnerabilities

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.

Generating route types...
✓ Types generated successfully

Initialized a git repository.

Success! Created globifye-pipeline at /Users/shuyangzhang/globifye-pipeline

```


---

#### 1.2 Navigate into the project

```bash
cd globifye-pipeline
```

---

#### 1.3 Install core dependencies

```bash
npm install @deepgram/sdk @supabase/supabase-js
```
```
added 10 packages, and audited 371 packages in 1s

143 packages are looking for funding
  run `npm fund` for details

2 moderate severity vulnerabilities

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.

```

> ⏳ LLM SDK is installed in **Step 3** after you pick which LLM to use.

---

#### 1.4 Create the folder structure

Create these folders manually (some already exist from `create-next-app`):

```
globifye-pipeline/
├── app/
│   ├── api/
│   │   ├── recordings/        ← Step 8: POST /api/recordings/create
│   │   ├── transcribe/        ← Step 8: POST /api/transcribe
│   │   └── analyze/           ← Step 8: POST /api/analyze
│   ├── page.tsx               ← Step 9: main UI page
│   └── layout.tsx
├── lib/
│   ├── deepgram.ts            ← Step 4: Deepgram client + parser
│   ├── supabase.ts            ← Step 2: Supabase client + DB helpers
│   └── llm.ts                 ← Step 6: LLM client + analysis prompt
├── types/
│   └── pipeline.ts            ← TypeScript type definitions
├── supabase/
│   └── migrations/
│       └── 001_schema.sql     ← Step 2: table definitions
└── .env.local                 ← Step 1.5: API keys (never commit this)
```

```bash
mkdir -p app/api/recordings app/api/transcribe app/api/analyze lib types supabase/migrations
```

---

#### 1.5 Create `.env.local`

Create a file named `.env.local` in the project root with these placeholders:

```env
# Speach-To-Text Model
## Deepgram — sign up at deepgram.com (Step 4)
DEEPGRAM_API_KEY=

# Supabase — from your Supabase project → Settings → API (Step 2)

## Project URL: the format is always https://<your-project-id>.supabase.co — the project ID is the string at the end of your dashboard URL.
NEXT_PUBLIC_SUPABASE_URL=         

## Publishable key  
NEXT_PUBLIC_SUPABASE_ANON_KEY=   

## Secret key
SUPABASE_SERVICE_ROLE_KEY=          # Secret key

# LLM — fill in after Step 3 (pick one)
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
```

> ⚠️ `SUPABASE_SERVICE_ROLE_KEY` is a secret — only use it in server-side API routes, **never** in browser code or `NEXT_PUBLIC_` variables.

---

#### 1.6 Confirm `.env.local` is gitignored

Open `.gitignore` (created automatically by `create-next-app`) and verify `.env.local` is listed. It should be there by default — just double-check before any `git add`.

---

#### 1.7 Create stub files for `lib/` and `types/`

Create empty placeholder files so the folder structure is ready for later steps:

```bash
touch lib/deepgram.ts lib/supabase.ts lib/llm.ts types/pipeline.ts
touch supabase/migrations/001_schema.sql
```

---

#### 1.8 Test the dev server

```bash
npm run dev
```

```
> globifye-pipeline@0.1.0 dev
> next dev

▲ Next.js 16.2.6 (Turbopack)
- Local:         http://localhost:3000
- Network:       http://192.168.10.240:3000
- Environments: .env.local
✓ Ready in 210ms
```

Open `http://localhost:3000` — you should see the default Next.js welcome page.  
> ✅ If it loads, **Step 1 is complete.**

---

### Step 2 — Supabase Database Schema

#### 2.1 Create a Supabase account and project

1. Go to [https://supabase.com](https://supabase.com) and sign up (or log in)
2. Click **"New Project"**
3. Fill in:
   - **Name:** `globifye-ai-pipeline` (or any name you like)
   - **Database Password:** set a strong password and save it somewhere safe
   - **Region:** pick the one closest to you (e.g. US East)
4. Under **Security**, configure as follows:

   | Option | Recommended | Reason |
   |---|---|---|
   | **Enable Data API** | ✅ On | Required by `supabase-js` to read/write the database |
   | **Automatically expose new tables** | ❌ Off | Safer — manually control which tables are accessible |
   | **Enable automatic RLS** | ✅ On | Automatically enables Row Level Security on new tables, preventing data leaks |

   > ⚠️ With RLS enabled, all table data is locked down by default. Using `supabaseAdmin` (Secret key) bypasses RLS, so development is unaffected during the MVP phase.

5. Click **"Create new project"** and wait ~1 minute for it to initialize

---

#### 2.2 Get your Supabase API keys

1. In your Supabase project, go to **Settings** (gear icon on the left sidebar) → **API**
2. Copy these three values into your `.env.local` file:

| `.env.local` variable | Where to find it in Supabase |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **Project URL** (e.g. `https://xxxx.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Publishable key** under "Project API keys" |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret key** under "Project API keys" |

Your `.env.local` should now look like:

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

> ⚠️ Never commit `.env.local` — double-check `.gitignore` includes it.

---

#### 2.3 Write the SQL schema

Open `supabase/migrations/001_schema.sql` and paste in the following:

```sql
-- =====================
-- Table 1: recordings
-- =====================
-- Written when: call starts (row created) and call ends (duration updated)
CREATE TABLE IF NOT EXISTS recordings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_metadata   JSONB,           -- e.g. { "rep": "Alice", "client": "Acme Corp" }
  audio_url       TEXT,            -- cloud storage URL (S3/GCS) — raw audio is never stored in DB
  duration        NUMERIC,         -- total call duration in seconds, updated when call ends
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================
-- Table 2: transcript
-- =====================
-- Written when: real-time, one row per final sentence during call (not partial results)
CREATE TABLE IF NOT EXISTS transcript (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id        UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  speaker             TEXT,         -- Deepgram speaker label, e.g. "Speaker 0", "Speaker 1"
  content_raw         TEXT,         -- Deepgram output with filler words kept (um, uh, like) — sent to LLM
  content_clean       TEXT,         -- filler words stripped — displayed in UI only
  sentence_start_sec  NUMERIC,      -- sentence-level timestamp in seconds — used for transcript jumping, not shown in UI
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcript_recording_id_idx ON transcript(recording_id);

-- =====================
-- Table 3: analysis
-- =====================
-- Written when: user clicks "Analyze" button (never auto-triggered)
CREATE TABLE IF NOT EXISTS analysis (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id        UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  summary             TEXT,
  key_topics          JSONB,        -- [{ "name": "Pricing Discussion", "start_time": 45.0 }]
                                    -- UI navigation index — clicking a topic jumps to that transcript position
  objection_analysis  JSONB,        -- [{ "timestamp": 142.5, "speaker": "Customer", "exact_quote": "...", "reason": "...", "suggestion": "..." }]
  what_went_well      JSONB,        -- [{ "timestamp": 60.0, "speaker": "Sales Rep", "exact_quote": "...", "reason": "..." }]
  raw_llm_output      TEXT,         -- full raw LLM response string — for debugging only
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analysis_recording_id_idx ON analysis(recording_id);

-- =====================
-- Grants
-- =====================
-- Required because "Automatically expose new tables" is OFF.
-- Without these, PostgREST will return "permission denied" even with the service role key.
GRANT ALL ON recordings TO service_role;
GRANT ALL ON transcript TO service_role;
GRANT ALL ON analysis TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
```

**Why are GRANT statements needed?**

Two separate Supabase security mechanisms are in play:

- **RLS (Row Level Security)** controls which *rows* a user can read or write within a table. When RLS is enabled, all rows are locked by default. The `service_role` key bypasses RLS entirely — it always has full row-level access.

- **"Automatically expose new tables"** controls whether new tables are *visible to the PostgREST Data API at all*. When this is turned OFF, new tables are not granted to any API role by default — meaning PostgREST cannot access them, even with the `service_role` key, because the underlying database-level permission (`GRANT`) was never issued.

This is why turning off "Automatically expose new tables" still causes `permission denied` even when using the `service_role` key — it's a different layer of access control. 
```bash
◇ injected env (5) from .env.local // tip: ◈ secrets for agents [www.dotenvx.com]
❌ Error: permission denied for table recordings
```
The `GRANT` statements above fix this by explicitly giving `service_role` permission to access each table.

---

#### 2.4 Run the SQL in Supabase

1. In your Supabase project, click **"SQL Editor"** in the left sidebar
2. Click **"New query"**
3. Paste the entire SQL from `001_schema.sql` into the editor
4. Click **"Run"** (or press `Cmd + Enter`)
5. You should see: `Success. No rows returned`

---

#### 2.5 Verify the tables were created

1. Go to **"Table Editor"** in the left sidebar
2. You should see three tables: `recordings`, `transcript`, `analysis`
3. Click into each one to confirm the columns match the schema above

---

#### 2.6 Set up the Supabase client in code

Open `lib/supabase.ts` and add:

```typescript
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Browser-safe client (limited permissions)
export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Server-only client (full permissions — only use in API routes)
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)
```

> ✅ Use `supabase` in client components, `supabaseAdmin` in server-side API routes only.

---

#### 2.7 Test the connection

In your terminal, make sure you are inside the project ai-pipeline folder, then run:

```bash
node -e "
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
client.from('recordings').select('*').limit(1).then(({ data, error }) => {
  if (error) console.error('❌ Error:', error.message);
  else console.log('✅ Connected to Supabase! Rows:', data.length);
});
"
```

> ⚠️ We use `SUPABASE_SERVICE_ROLE_KEY` here instead of `NEXT_PUBLIC_SUPABASE_ANON_KEY` because `RLS` is enabled — the anon key has no table permissions by default and will return `permission denied`. The service role key bypasses RLS and is the correct key to use for server-side testing.

If `dotenv` is not installed yet, run `npm install dotenv` first.

You should see:
```bash
◇ injected env (5) from .env.local // tip: ⌘ enable debugging { debug: true }
✅ Connected to Supabase! Rows: 0
```

> ✅ If it works, **Step 2 is complete.** Move on to Step 3 — LLM Selection.

---

Also keep `raw_llm_output` column in `analysis` for debugging (from Abraham's PDF schema).

---

### Step 3 — LLM Selection *(pending decision)*

Compare `MiniMax` vs `OpenAI GPT-4o` vs `Anthropic Claude Haiku/Sonnet` for the analytics task:
- Must support structured JSON output (JSON mode or tool use)
- Must handle ~2,000–5,000 token transcripts reliably
- Evaluate: output quality, latency, cost per call

**Recommended for MVP:** OpenAI GPT-4o or Anthropic Claude Sonnet (both have reliable JSON mode). Finalize this before Step 6.

---

### Step 4 — Deepgram Integration *(batch mode first, streaming later)*

- Sign up for Deepgram → claim ~$300 free credits (Gmail alias)
- Use Deepgram **batch API** for MVP (process a pre-recorded `.mp3`/`.wav` sample audio file)
- Configure: `model=nova-3`, `diarize=true`, `punctuate=true`, `utterances=true`
- Verify: speaker labels appear, timestamps are sentence-level, filler words are present in raw output

---

### Step 5 — Phase 1: Transcript Parsing & DB Write

After Deepgram returns results:
1. Extract each utterance (sentence-level segment with speaker + timestamps)
2. For each utterance:
   - `content_raw` = raw Deepgram text (filler words retained)
   - `content_clean` = filler words stripped (`um`, `uh`, `like`, `you know`, etc.)
   - `speaker` = Deepgram speaker label (Speaker 0, Speaker 1 → mapped to roles)
   - `sentence_start_sec` = utterance start timestamp
3. Batch-insert rows into `transcript` table

---

### Step 6 — Phase 2: LLM Analysis Prompt

Build a single structured prompt containing:
- **Step 0 (Second-pass correction):** Fix homophones, jargon, company names using full context. Corrected text feeds all subsequent steps.
- **Step 1:** Summary
- **Step 2:** Key topics (name + start_time)
- **Step 3:** Objection analysis (timestamp, exact_quote from corrected text, reason, suggestion)
- **Step 4:** What went well (timestamp, exact_quote from corrected text, reason)

Expected LLM JSON output shape (from `sales-call-system-pipeline-0520-v1.1.md`):

```json
{
  "summary": "...",
  "key_topics": [
    { "name": "...", "start_time": 0.0 }
  ],
  "analysis": {
    "objections": [
      {
        "timestamp": 142.5,
        "speaker": "Customer",
        "exact_quote": "...",
        "reason": "...",
        "suggestion": "..."
      }
    ],
    "what_went_well": [
      {
        "timestamp": 60.0,
        "speaker": "Sales Rep",
        "exact_quote": "...",
        "reason": "..."
      }
    ]
  }
}
```

---

### Step 7 — Phase 2: LLM Call & DB Write

1. Assemble full transcript from `content_raw` fields + timestamps
2. Call LLM with the prompt from Step 6
3. Parse structured JSON response
4. Write to `analysis` table (`summary`, `key_topics`, `objection_analysis`, `what_went_well`, `raw_llm_output`)

---

### Step 8 — Next.js API Routes

Wire the pipeline into Vercel-friendly API routes:
- `POST /api/recordings/create` — insert a new recording row, return `recording_id`
- `POST /api/transcribe` — accept audio file upload, call Deepgram batch API, parse utterances, write transcript rows, return them
- `POST /api/analyze` — accept full transcript JSON from frontend state, call LLM, write analysis row, return analysis JSON
- `GET /api/analysis/[id]` — fetch stored analysis for a recording

---

### Step 9 — Basic UI *(Next.js page)*

Build a single-page React component:
- Audio upload field + "Start" button → calls `/api/transcribe`
- Transcript panel — displays speaker-labeled lines (using `content_clean`) as they're written
- "Analyze" button — sends transcript from frontend state (no DB re-fetch) to `/api/analyze`
- Results panels — Summary, Key Topics list (clickable to scroll transcript), Objection Analysis cards, What Went Well cards

---

### Step 10 — Real-time WebSocket Layer *(post-demo, if time)*

- Vercel endpoint: `GET /api/deepgram-token` — generates short-lived Deepgram token
- Browser JS: opens `wss://api.deepgram.com` WebSocket using that token
- Sends 100–200ms audio chunks from microphone
- Receives partial results → update UI captions (no DB write)
- Receives final results → write to `transcript` table (micro-batch)

---

## Key Files to Create

| File | Purpose |
|---|---|
| `scripts/run-pipeline.js` or `.ts` | MVP end-to-end script |
| `lib/deepgram.ts` | Deepgram client + transcript parsing |
| `lib/supabase.ts` | Supabase client + DB write helpers |
| `lib/llm.ts` | LLM client + analysis prompt |
| `app/api/transcribe/route.ts` | API route for Phase 1 |
| `app/api/analyze/route.ts` | API route for Phase 2 |
| `supabase/migrations/001_schema.sql` | Supabase table definitions |

---

## Pending Decisions *(clarify before building)*

1. **MVP delivery format:** Standalone script (fastest) vs full Next.js app with UI?
2. **LLM selection:** Run a quick comparison → pick one before writing the prompt
3. **Sample audio:** Need a test `.mp3`/`.wav` of a sales call (real or synthetic) to validate the pipeline end-to-end

---

## Verification *(end-to-end test)*

1. Run the pipeline on a sample audio file
2. Check Supabase: `transcript` rows appear with speaker labels, `content_raw`, `content_clean`, `sentence_start_sec`
3. Check Supabase: `analysis` row appears with valid JSON in all four fields
4. Review LLM output: objections have `timestamps`, `exact_quotes`, `reasons`, `suggestions`
5. Confirm `what_went_well` and `summary` are populated

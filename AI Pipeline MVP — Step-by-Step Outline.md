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
# Deepgram — sign up at deepgram.com (Step 4)
DEEPGRAM_API_KEY=

# Supabase — from your Supabase project → Settings → API (Step 2)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# LLM — fill in after Step 3 (pick one)
OPENAI_API_KEY=
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
⚠ Warning: Next.js inferred your workspace root, but it may not be correct.
 We detected multiple lockfiles and selected the directory of /Users/shuyangzhang/package-lock.json as the root directory.
 To silence this warning, set `turbopack.root` in your Next.js config, or consider removing one of the lockfiles if it's not needed.
   See https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#root-directory for more information.
 Detected additional lockfiles: 
   * /Users/shuyangzhang/🟪 GlobiFYE/globifye-pipeline/package-lock.json
```

Open `http://localhost:3000` — you should see the default Next.js welcome page.  
✅ If it loads, **Step 1 is complete.**

---

### Step 2 — Supabase Database Schema

Create the 3 tables exactly as specified in `sales-call-system-pipeline-0520-v1.1.md`:

| Table | Key Fields |
|---|---|
| `recordings` | `id`, `call_metadata`, `audio_url`, `duration`, `created_at` |
| `transcript` | `recording_id`, `speaker`, `content_raw`, `content_clean`, `sentence_start_sec` |
| `analysis` | `recording_id`, `summary`, `key_topics` (JSON), `objection_analysis` (JSON), `what_went_well` (JSON) |

Also keep `raw_llm_output` column in `analysis` for debugging (from Abraham's PDF schema).

---

### Step 3 — LLM Selection *(pending decision)*

Compare MiniMax vs OpenAI GPT-4o vs Anthropic Claude Haiku/Sonnet for the analytics task:
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

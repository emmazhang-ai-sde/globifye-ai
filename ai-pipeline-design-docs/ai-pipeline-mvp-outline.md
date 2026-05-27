# AI Pipeline MVP — Step-by-Step Outline

**Project:** GlobiFYE Sales Call System
**Goal:** End-to-end working demo — audio file in → transcript stored → analysis out
**Stack:** Next.js + Vercel + Supabase + Deepgram Nova-3 + LangChain.js + LLM (provider TBD — Anthropic Claude Sonnet or OpenAI GPT-4o)
**Demo deadline:** Monday, May 27, 2026

---

## Context

The PM (Danish Parray) asked for a working end-to-end AI pipeline prototype to demo. The pipeline must cover two phases from the pipeline diagram:
- **Phase 1 (During Call):** Audio → Deepgram STT → Partial Results (UI captions) + Final Results (DB writes)
- **Phase 2 (Post-call):** Button-triggered → single LLM call → structured JSON → DB + UI

No code exists yet — only architecture docs. This plan builds the MVP step by step without writing code directly.

---

## MVP Scope

For the Monday demo: **audio file in → transcript stored → analysis out**. A minimal working proof-of-concept, not a polished UI. Real-time WebSocket streaming can be layered in after the core pipeline validates.

---

## Step-by-Step Outline

### Step 1 — Project Setup

→ See [ai-pipeline-mvp-step1-project-setup.md](ai-pipeline-mvp-step1-project-setup.md)

---

### Step 2 — Supabase Database Schema

→ See [ai-pipeline-mvp-step2-supabase-schema.md](ai-pipeline-mvp-step2-supabase-schema.md)

---

### Step 3 — LLM Selection

→ See [ai-pipeline-mvp-step3-llm-selection.md](ai-pipeline-mvp-step3-llm-selection.md)

---

### Step 4 — Deepgram Integration *(batch mode first, streaming later)*

→ See [ai-pipeline-mvp-step4-deepgram-integration.md](ai-pipeline-mvp-step4-deepgram-integration.md)

---

### Step 5 — Phase 1: Transcript Parsing & DB Write

This step takes the raw Deepgram utterances from Step 4 and writes them to the `transcript` table. Two versions of the text are produced per row: `content_raw` (filler words kept, sent to LLM in Step 7) and `content_clean` (filler words stripped, displayed in the UI in Step 9).

---

#### 5.1 Understand the data transformation

Each Deepgram utterance becomes one row in the `transcript` table:

```
Deepgram utterance                        transcript row
──────────────────────────────────────    ──────────────────────────────────────────────────────
speaker:    0                        →    speaker:            "Speaker 0"
transcript: "Yeah um I think the         content_raw:        "Yeah um I think the price is a bit high"
             price is a bit high"    →    content_clean:      "Yeah I think the price is a bit high"
start:      45.2                     →    sentence_start_sec: 45.2
```

Two things happen during the transformation:

1. **Filler word stripping** — `content_raw` is kept exactly as Deepgram returned it. `content_clean` has `um`, `uh`, `like`, `you know`, and similar words removed. The LLM receives `content_raw` because filler words signal hesitation and are useful for objection detection. The UI displays `content_clean` for readability.

2. **Speaker label formatting** — Deepgram returns `speaker` as an integer (`0`, `1`). We format it as a human-readable string (`"Speaker 0"`, `"Speaker 1"`) for the DB.

---

#### 5.2 Add filler word stripping to `lib/deepgram.ts`

Open `lib/deepgram.ts` and add this at the bottom, after `transcribeFile`:

```typescript
// ---------------------------------------------------------------------------
// Filler word stripping
// ---------------------------------------------------------------------------

// Matches filler words as whole words only, including any trailing comma and space.
// content_raw keeps these intact (sent to LLM — signals hesitation).
// content_clean strips them (displayed in UI).
const FILLER_PATTERN = /\b(um+|uh+|hmm+|mhm|uh-huh|like|you know)\b[,]?\s*/gi

export function stripFillerWords(text: string): string {
  return text
    .replace(FILLER_PATTERN, '')
    .replace(/\s{2,}/g, ' ')   // collapse any double spaces left behind
    .trim()
}
```

> **Why keep `like`?** It's in the list because the notes specified it, and in sales calls it almost always appears as a filler. If a specific use case needs to preserve it, remove `like` from the pattern.

---

#### 5.3 Add DB write helpers to `lib/supabase.ts`

Open `lib/supabase.ts` and add these two exports after the existing client setup:

```typescript
import { DeepgramUtterance, stripFillerWords } from './deepgram'

// ---------------------------------------------------------------------------
// Recording helpers
// ---------------------------------------------------------------------------

/**
 * Creates a new row in the recordings table and returns its UUID.
 * Must be called before writeTranscript — transcript rows have a FK to recordings.
 */
export async function createRecording(
  metadata: Record<string, unknown> = {}
): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('recordings')
    .insert({ call_metadata: metadata })
    .select('id')
    .single()

  if (error) throw new Error(`Failed to create recording row: ${error.message}`)
  return data.id
}

// ---------------------------------------------------------------------------
// Transcript helpers
// ---------------------------------------------------------------------------

/**
 * Batch-inserts all utterances as transcript rows for a given recording.
 * Produces content_raw (filler words kept) and content_clean (filler words stripped).
 */
export async function writeTranscript(
  recordingId: string,
  utterances: DeepgramUtterance[]
): Promise<void> {
  const rows = utterances.map(u => ({
    recording_id:       recordingId,
    speaker:            `Speaker ${u.speaker}`,         // "Speaker 0", "Speaker 1"
    content_raw:        u.transcript,                   // filler words intact — sent to LLM
    content_clean:      stripFillerWords(u.transcript), // filler words stripped — shown in UI
    sentence_start_sec: u.start,
  }))

  const { error } = await supabaseAdmin
    .from('transcript')
    .insert(rows)

  if (error) throw new Error(`Transcript write failed: ${error.message}`)
}
```

---

#### 5.4 Test the full Phase 1 pipeline

Create `scripts/test-transcript.ts`:

```typescript
import { transcribeFile } from '../lib/deepgram'
import { createRecording, writeTranscript } from '../lib/supabase'

const AUDIO_FILE = './sample-audio.mp3'

async function run() {
  // 1. Transcribe audio
  console.log('🎙️  Transcribing audio...')
  const utterances = await transcribeFile(AUDIO_FILE)
  console.log(`✅ Deepgram returned ${utterances.length} utterances`)

  // 2. Create a recordings row first (required — transcript has FK to recordings)
  const recordingId = await createRecording({
    rep: 'Test Rep',
    client: 'Test Client',
    source: 'mvp-test',
  })
  console.log(`✅ Recording row created: ${recordingId}`)

  // 3. Write all transcript rows in one batch insert
  await writeTranscript(recordingId, utterances)
  console.log(`✅ ${utterances.length} transcript rows written`)

  // 4. Preview first 3 rows
  console.log('\nPreview (first 3 utterances):')
  utterances.slice(0, 3).forEach(u => {
    console.log(`  [${u.start.toFixed(1)}s] Speaker ${u.speaker}: ${u.transcript}`)
  })

  // Save this — needed for Step 7 (LLM call uses recording_id to fetch transcript)
  console.log(`\n📋 recording_id for Steps 7+: ${recordingId}`)
}

run().catch(err => console.error('❌', err.message))
```

Run it:

```bash
npx ts-node --esm scripts/test-transcript.ts
```

Expected output:

```
🎙️  Transcribing audio...
✅ Deepgram returned 24 utterances
✅ Recording row created: a1b2c3d4-e5f6-...
✅ 24 transcript rows written

Preview (first 3 utterances):
  [0.0s] Speaker 0: Hi, thanks for calling GlobiFYE. How can I help you today?
  [3.2s] Speaker 1: Yeah, um, I was looking at your pricing page and I had a few questions.
  [6.8s] Speaker 0: Of course, happy to walk you through it.

📋 recording_id for Steps 7+: a1b2c3d4-e5f6-...
```

> **Copy the `recording_id`** printed at the end — you will need to paste it into the Step 7 test script.

---

#### 5.5 Verify in Supabase

**Check the `recordings` table:**
1. Go to Supabase **Table Editor** → `recordings`
2. Confirm one new row exists with your `call_metadata` (`{ "rep": "Test Rep", "client": "Test Client", ... }`)

**Check the `transcript` table:**
1. Go to **Table Editor** → `transcript`
2. Filter by `recording_id` = the UUID printed above
3. Confirm N rows exist (matching the utterance count)
4. Click into a few rows and verify:

| Column | What to check |
|---|---|
| `speaker` | Values are `"Speaker 0"` or `"Speaker 1"` (string, not integer) |
| `content_raw` | Contains filler words (`um`, `uh`, etc.) exactly as Deepgram returned them |
| `content_clean` | Same text with filler words removed — should read more fluently |
| `sentence_start_sec` | Numbers that increase from row to row, matching the audio timeline |

---

#### 5.6 Common errors and fixes

| Error | Likely cause | Fix |
|---|---|---|
| `Transcript write failed: violates foreign key constraint` | `writeTranscript` called before `createRecording` | Always call `createRecording` first and pass the returned `id` to `writeTranscript` |
| `content_clean` is identical to `content_raw` | Filler words in audio don't match the regex (e.g. different capitalization) | The `FILLER_PATTERN` uses the `i` flag — check if words like `"Like"` or `"Um"` appear at the start of a sentence and confirm the pattern catches them |
| `speaker` column shows `"Speaker undefined"` | Deepgram `diarize: true` not set, or single-speaker audio | Confirm `diarize: true` in `transcribeFile`; the `u.speaker ?? 0` fallback should prevent `undefined` but check Step 4 output |
| `Cannot find module './deepgram'` in `supabase.ts` | Import path wrong | Use `'./deepgram'` (not `'../lib/deepgram'`) since both files are in the same `lib/` folder |
| `sentence_start_sec` is `0` for all rows | Timestamps not in utterance data | Confirm `utterances: true` is set in `transcribeFile` — without it, `start` is not populated per utterance |

---

> ✅ If the `transcript` table has rows with distinct speakers, `content_raw` containing filler words, and `content_clean` without them, **Step 5 is complete.** Move on to Step 6 — LLM Analysis Prompt.

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

This step wires together the stored transcript (Step 5), the prompt design (Step 6), and the Supabase client (Step 2). The end result is a single `analysis` row written to Supabase.

---

#### 7.1 Install LangChain.js and the LLM provider package

Install the core LangChain packages plus the provider package that matches your Step 3 decision:

```bash
# If using Anthropic (Claude Sonnet)
npm install langchain @langchain/core @langchain/anthropic zod

# — OR —

# If using OpenAI (GPT-4o)
npm install langchain @langchain/core @langchain/openai zod
```

Then add the key to `.env.local`:

```env
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# — OR — OpenAI
# OPENAI_API_KEY=sk-...
```

> If the LLM provider isn't confirmed yet (Amy's evaluation in Step 3), install `@langchain/anthropic` as a placeholder — the provider package is the only thing that changes later.

---

#### 7.2 Populate `lib/llm.ts`

This file exports two functions:
- `analyzeTranscript(recordingId)` — fetches transcript rows, calls the LLM, returns parsed JSON
- `writeAnalysis(recordingId)` — calls the above, then writes the result to the `analysis` table

Open `lib/llm.ts` and add:

```typescript
import { ChatAnthropic } from '@langchain/anthropic'
// Switch provider here — everything below stays identical
// import { ChatOpenAI } from '@langchain/openai'

import { z } from 'zod'
import { supabaseAdmin } from './supabase'

// ---------------------------------------------------------------------------
// LLM client — swap provider by changing these two lines only
// ---------------------------------------------------------------------------

const model = new ChatAnthropic({
  model: 'claude-sonnet-4-6',
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

// OpenAI equivalent:
// const model = new ChatOpenAI({ model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY! })

// ---------------------------------------------------------------------------
// Output schema — LangChain enforces this shape via Zod, no manual JSON.parse needed
// ---------------------------------------------------------------------------

const AnalysisSchema = z.object({
  summary: z.string().describe('2-3 sentence overview of the call'),
  key_topics: z.array(
    z.object({
      name: z.string().describe('Topic name'),
      start_time: z.number().describe('Timestamp in seconds from the transcript'),
    })
  ),
  analysis: z.object({
    objections: z.array(
      z.object({
        timestamp: z.number().describe('Timestamp in seconds from the transcript'),
        speaker: z.string().describe('Speaker label from the transcript'),
        exact_quote: z.string().describe('Verbatim quote from the transcript'),
        reason: z.string().describe('Why this is an objection'),
        suggestion: z.string().describe('How the rep could respond'),
      })
    ).describe('Empty array [] if there are no objections'),
    what_went_well: z.array(
      z.object({
        timestamp: z.number().describe('Timestamp in seconds from the transcript'),
        speaker: z.string().describe('Speaker label from the transcript'),
        exact_quote: z.string().describe('Verbatim quote from the transcript'),
        reason: z.string().describe('Why this was effective'),
      })
    ).describe('Empty array [] if nothing notable'),
  }),
})

// Infer TypeScript type from schema — parsed result is fully typed
type Analysis = z.infer<typeof AnalysisSchema>

// ---------------------------------------------------------------------------
// Transcript assembly
// ---------------------------------------------------------------------------

type TranscriptRow = {
  speaker: string
  sentence_start_sec: number
  content_raw: string
}

/**
 * Converts DB rows into the labeled transcript string the LLM will receive.
 * Format: "[45.0s] Speaker 0: That pricing seems high for our budget."
 */
function buildTranscriptText(rows: TranscriptRow[]): string {
  return rows
    .map(r => `[${Number(r.sentence_start_sec).toFixed(1)}s] ${r.speaker}: ${r.content_raw}`)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

// The JSON template is removed — LangChain injects the Zod schema as structured
// output instructions automatically. The prompt only needs to describe the task.
const SYSTEM_PROMPT = `You are a sales call analyst. Analyze the provided timestamped sales call transcript.

Rules:
- All timestamps must correspond to real lines in the transcript.
- exact_quote must be verbatim text from the transcript.
- If there are no objections or nothing notable, return an empty array [].`

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

export async function analyzeTranscript(recordingId: string) {
  // 1. Fetch transcript rows in chronological order
  const { data: rows, error } = await supabaseAdmin
    .from('transcript')
    .select('speaker, sentence_start_sec, content_raw')
    .eq('recording_id', recordingId)
    .order('sentence_start_sec', { ascending: true })

  if (error) throw new Error(`DB fetch failed: ${error.message}`)
  if (!rows || rows.length === 0) throw new Error(`No transcript rows found for recording_id: ${recordingId}`)

  const transcriptText = buildTranscriptText(rows)

  // 2. Call the LLM with structured output enforcement
  // includeRaw: true preserves the raw LLM response string for the raw_llm_output DB field
  const structuredModel = model.withStructuredOutput(AnalysisSchema, { includeRaw: true })

  const { raw, parsed } = await structuredModel.invoke([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Analyze the following sales call transcript:\n\n${transcriptText}` },
  ])

  // 3. Extract raw text for debugging (stored in raw_llm_output column)
  const rawOutput = typeof raw.content === 'string'
    ? raw.content
    : JSON.stringify(raw.content)

  // parsed is fully typed as Analysis — no JSON.parse, no ?? fallbacks needed
  return { parsed, rawOutput }
}

// ---------------------------------------------------------------------------
// DB write
// ---------------------------------------------------------------------------

export async function writeAnalysis(recordingId: string) {
  const { parsed, rawOutput } = await analyzeTranscript(recordingId)

  // Zod validation guarantees shape — no ?? null / ?? [] fallbacks needed
  // LLM returns: analysis.objections + analysis.what_went_well
  // DB columns:  objection_analysis + what_went_well
  const { data, error } = await supabaseAdmin
    .from('analysis')
    .insert({
      recording_id:       recordingId,
      summary:            parsed.summary,
      key_topics:         parsed.key_topics,
      objection_analysis: parsed.analysis.objections,
      what_went_well:     parsed.analysis.what_went_well,
      raw_llm_output:     rawOutput,
    })
    .select()
    .single()

  if (error) throw new Error(`DB insert failed: ${error.message}`)
  return data
}
```

> **Switching to OpenAI?** Change only the top two lines: replace `import { ChatAnthropic }` with `import { ChatOpenAI }` from `@langchain/openai`, and update the `model` initialization. The Zod schema, prompt, and DB write logic are provider-agnostic and require no changes.

---

#### 7.3 Test it end-to-end

Create a quick test script at `scripts/test-analysis.ts`:

```typescript
import { writeAnalysis } from '../lib/llm'

// Paste a recording_id that already has transcript rows (from Step 5)
const RECORDING_ID = 'paste-your-recording-uuid-here'

writeAnalysis(RECORDING_ID)
  .then(row => {
    console.log('✅ Analysis written to Supabase:')
    console.log(JSON.stringify(row, null, 2))
  })
  .catch(err => {
    console.error('❌ Analysis failed:', err.message)
  })
```

Run it:

```bash
npx ts-node --esm scripts/test-analysis.ts
```

Expected output (abbreviated):

```json
✅ Analysis written to Supabase:
{
  "id": "a1b2c3d4-...",
  "recording_id": "...",
  "summary": "The sales rep discussed pricing and feature fit with the prospect...",
  "key_topics": [
    { "name": "Pricing Discussion", "start_time": 45.0 },
    { "name": "Competitor Comparison", "start_time": 112.3 }
  ],
  "objection_analysis": [
    {
      "timestamp": 142.5,
      "speaker": "Speaker 1",
      "exact_quote": "That's more than we were expecting to pay.",
      "reason": "Price anchoring — prospect had a lower number in mind",
      "suggestion": "Reframe around ROI: ask what the cost of inaction is over 12 months"
    }
  ],
  "what_went_well": [
    {
      "timestamp": 60.0,
      "speaker": "Speaker 0",
      "exact_quote": "It sounds like your main concern is onboarding time — is that right?",
      "reason": "Active listening — rep reflected the concern back before responding"
    }
  ],
  "raw_llm_output": "{ \"summary\": ...",
  "created_at": "2026-05-26T..."
}
```

---

#### 7.4 Common errors and fixes

| Error | Likely cause | Fix |
|---|---|---|
| `No transcript rows found` | Wrong `recording_id`, or Step 5 hasn't run yet | Paste the correct UUID; run Step 5 first |
| `Cannot find module '@langchain/anthropic'` | LangChain packages not installed | Run `npm install langchain @langchain/core @langchain/anthropic zod` |
| `OutputParserException` | LLM output didn't conform to the Zod schema | Check `SYSTEM_PROMPT` is clear; LangChain retries once automatically before throwing |
| `ZodError: invalid_type at ...` | LLM returned a field with the wrong type | Log `raw.content` to inspect the raw output; adjust `.describe()` hints in `AnalysisSchema` |
| `DB insert failed: null value in column "recording_id"` | UUID not passed through correctly | `console.log(recordingId)` at the top of `writeAnalysis` to confirm it's non-empty |
| `DB insert failed: insert or update on table "analysis" violates foreign key constraint` | `recording_id` doesn't exist in `recordings` table | Create the recording row first (Step 8 / `POST /api/recordings/create`) |

---

#### 7.5 Verify in Supabase

1. Go to Supabase **Table Editor** → `analysis`
2. Confirm one row exists for your `recording_id`
3. Click the row — check all four JSON columns are populated:
   - `summary` — a readable string, not null
   - `key_topics` — array with at least one `{ name, start_time }` entry
   - `objection_analysis` — array (may be `[]` if the call had no objections)
   - `what_went_well` — array with at least one entry
4. Check `raw_llm_output` — should contain the raw JSON string from the LLM (useful for debugging prompt issues)

> ✅ If all four columns are populated and the row links to the correct `recording_id`, **Step 7 is complete.** Move on to Step 8 — Next.js API Routes.

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
2. **LLM provider:** ✅ Framework decided (LangChain.js). Provider still pending Amy's evaluation — Anthropic Claude Sonnet or OpenAI GPT-4o. Once decided, change one import line and one `model` initialization in `lib/llm.ts`.
3. **Sample audio:** Need a test `.mp3`/`.wav` of a sales call (real or synthetic) to validate the pipeline end-to-end

---

## Verification *(end-to-end test)*

1. Run the pipeline on a sample audio file
2. Check Supabase: `transcript` rows appear with speaker labels, `content_raw`, `content_clean`, `sentence_start_sec`
3. Check Supabase: `analysis` row appears with valid JSON in all four fields
4. Review LLM output: objections have `timestamps`, `exact_quotes`, `reasons`, `suggestions`
5. Confirm `what_went_well` and `summary` are populated

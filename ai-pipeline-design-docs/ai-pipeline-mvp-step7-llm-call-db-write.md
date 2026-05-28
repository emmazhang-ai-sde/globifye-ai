# Step 7 — Phase 2: LLM Call & DB Write

*Part of [AI Pipeline MVP Outline](ai-pipeline-mvp-outline.md)*

---

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

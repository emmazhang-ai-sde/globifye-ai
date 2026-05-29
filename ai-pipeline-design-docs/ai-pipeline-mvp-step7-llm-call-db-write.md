# Step 7 — Phase 2: LLM Call & DB Write

*Part of [AI Pipeline MVP Outline](ai-pipeline-mvp-outline.md)*

---

This step wires together the stored transcript (Step 5), the prompt design (Step 6), and the Supabase client (Step 2). The end result is a single `analysis` row written to Supabase.

---

## What you will do in this step

**7.1** — Install LangChain.js and the LLM provider package  
**7.2** — Populate `lib/llm.ts` with the schema, prompt, and DB write logic  
**7.3** — Create and run `scripts/test-analysis.ts`  
**7.4** — Verify the result in Supabase  
**7.5** — Common errors and fixes

---

#### 7.1 Install LangChain.js and the LLM provider package

Install the core LangChain packages plus the provider package for your chosen provider.

---

**Option A — Groq (demo, recommended)**

```bash
npm install langchain @langchain/core @langchain/groq zod
```

Add the API key to `.env.local`: ```GROQ_API_KEY=gsk_...```
Get a free key at [console.groq.com](https://console.groq.com) — no credit card required. 
See **Step 3 section 3.7** for the full signup walkthrough.

> **Groq free tier token limit:** each analysis call uses roughly 7,000–8,000 tokens. If you hit a rate limit error on the first run, wait 60 seconds and retry — the free tier resets per minute.

---

**Option B — Ollama (fully local, no account needed)**

First, install Ollama and pull a model if you haven't already (see Step 3 section 3.8):

```bash
# Install Ollama (macOS)
brew install ollama

# Pull the model
ollama pull llama3.2

# Start the local server (leave running in a separate terminal)
ollama serve
```

Then install the LangChain package:

```bash
npm install langchain @langchain/core @langchain/ollama zod
```

No API key needed — Ollama has no `.env.local` entry.

> Ollama must be running (`ollama serve`) before you run the test script in 7.3. If you see `ECONNREFUSED localhost:11434`, the server isn't running.

---

**Production providers (after demo)**

```bash
# Anthropic (Claude Sonnet 4.6)
npm install langchain @langchain/core @langchain/anthropic zod
# Add to .env.local: ANTHROPIC_API_KEY=sk-ant-...

# OpenAI (GPT-4o)
npm install langchain @langchain/core @langchain/openai zod
# Add to .env.local: OPENAI_API_KEY=sk-...
```

The Zod schema, `SYSTEM_PROMPT`, and DB write logic in `lib/llm.ts` are provider-agnostic — only the import and `model` initialization change.

---

#### 7.2 Populate `lib/llm.ts`

This file exports two functions:
- `analyzeTranscript(recordingId)` — fetches transcript rows from Supabase, calls the LLM, returns parsed JSON
- `writeAnalysis(recordingId)` — calls the above, then writes the result to the `analysis` table

The full implementation is already in `lib/llm.ts`. The structure is:

```typescript
// 1. IMPORTS
// — LLM provider (ChatGroq for demo; swap to ChatAnthropic / ChatOpenAI for production)
// — z from 'zod'
// — supabaseAdmin from './supabase'

// 2. LLM CLIENT
// — const model = new ChatGroq({ model, apiKey })
// — Commented-out alternatives for Anthropic and OpenAI kept for easy swapping

// 3. OUTPUT SCHEMA (AnalysisSchema)
// — Zod object defining the exact shape of the LLM response
// — Fields: summary, key_topics[], analysis.objections[], analysis.what_went_well[]
// — Each field has a .describe() hint — LangChain sends these to the LLM as field-level instructions
//   (this replaces the JSON template you would otherwise write in SYSTEM_PROMPT)

// 4. TRANSCRIPT ASSEMBLY
// — type TranscriptRow: { speaker, sentence_start_sec, content_raw }
// — buildTranscriptText(rows): converts DB rows to "[45.2s] Speaker 0: ..." lines

// 5. SYSTEM_PROMPT
// — Role: sales coach giving actionable feedback to the rep
// — Explains the [Xs] transcript format and speaker disambiguation
// — Rules: timestamp precision, exact_quote strictness, objection types,
//          what_went_well definition, suggestion quality, empty array enforcement
// — See Step 6 section 6.4 for full prompt text and the reasoning behind each rule

// 6. analyzeTranscript(recordingId)  [exported]
// — Fetches transcript rows from Supabase ordered by sentence_start_sec
// — Calls model.withStructuredOutput(AnalysisSchema, { includeRaw: true })
//     includeRaw: true → returns both parsed (typed) and raw (string) response
//     parsed is used for the DB insert; raw is stored in raw_llm_output for debugging
// — Returns { parsed, rawOutput }

// 7. writeAnalysis(recordingId)  [exported]
// — Calls analyzeTranscript() to get parsed + rawOutput
// — Maps LLM field names to DB column names:
//     parsed.analysis.objections   → objection_analysis  (DB column name from Step 2 migration)
//     parsed.analysis.what_went_well → what_went_well
// — Inserts one row into the analysis table, returns the inserted row
```

**Key decisions to understand before editing:**

**`.describe()` hints on `AnalysisSchema`** — These are not comments. LangChain converts them into field-level instructions sent to the LLM alongside the schema. Changing a hint changes what the LLM puts in that field.

**`includeRaw: true`** — Without this, `withStructuredOutput` only returns `parsed`. You need `raw` to populate the `raw_llm_output` DB column, which is the main debugging tool if the LLM output ever fails schema validation.

**`analysis.objections` → `objection_analysis`** — The LLM schema uses `objections` (natural nesting inside `analysis`); the DB column is `objection_analysis` (defined in the Step 2 migration). The insert in `writeAnalysis` maps between them explicitly.

**`supabaseAdmin` not `supabase`** — The regular client is subject to Row Level Security (RLS) and will reject server-side inserts. `supabaseAdmin` uses the service role key and bypasses RLS.

---

#### 7.3 Create and run the test script

**Step 1 — Get the `recording_id` from Step 5**

Step 5 saved the recording UUID to `sample-transcripts/recording-ids.json`. Open it and copy the `recordingId` value from the most recent entry:

```json
[
  {
    "recordingId": "941ad1db-17a1-4cc6-a0d4-cdac06db264b",
    "source": "mvp-test",
    "createdAt": "2026-05-28T03:55:10.528Z"
  }
]
```

**Step 2 — Create `scripts/test-analysis.ts`**

```typescript
import { writeAnalysis } from '../lib/llm'

// Paste the recordingId value from sample-transcripts/recording-ids.json
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

**Step 3 — Run it**

```bash
npx tsx --env-file=.env.local scripts/test-analysis.ts
```

> **Why `--env-file` and not `dotenv.config()`?** Same reason as Step 5: `lib/supabase.ts` initializes the Supabase client at module load time. With `tsx`, ES module imports are hoisted — so Supabase initializes before `dotenv.config()` runs and sees an empty `NEXT_PUBLIC_SUPABASE_URL`. Passing `--env-file` loads all variables before any module initializes.

**Step 4 — Check the output**

Expected output (abbreviated):

```
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
  "created_at": "2026-05-27T..."
}
```

> The `exact_quote` values in the output should be text you recognize from the transcript in `sample-transcripts/sample-audio-1.json`. If the quotes look paraphrased or invented, go back to Step 6 and tighten `SYSTEM_PROMPT`.

---

#### 7.4 Verify in Supabase

1. Go to Supabase **Table Editor** → `analysis`
2. Confirm one row exists for your `recording_id`
3. Click the row — check all four JSON columns are populated:

| Column | What to check |
|---|---|
| `summary` | A readable 2–3 sentence string, not null |
| `key_topics` | Array with at least one `{ name, start_time }` entry |
| `objection_analysis` | Array — may be `[]` if the sample call had no objections |
| `what_went_well` | Array with at least one entry |

4. Check `raw_llm_output` — should contain the raw JSON string from the LLM. If `parsed` ever fails Zod validation, this column is what you inspect to see what the LLM actually returned.

> **`raw_llm_output` is empty when using Groq — this is expected and not a problem.**
> When LangChain uses `.withStructuredOutput()` with Groq, it implements structured output via function calling (tool use). In this mode, the model puts its output into the tool call arguments, not into the message content. So `raw.content` is `""` by design — the actual data came through correctly via `parsed`, which is why `summary`, `key_topics`, etc. are all populated. `raw_llm_output` is a debugging field only; it matters if `parsed` ever fails Zod validation, but has no effect on the pipeline when everything works correctly.

> **`objection_analysis: []` is valid.** 
> It means either the sample audio genuinely had no customer objections, or the model didn't detect any. 
> This is correct behaviour per the `SYSTEM_PROMPT` rule ("return an empty array [] if no genuine objections exist"). To verify objection detection is working, run the analysis against a transcript with clear customer pushback — Amy's test transcripts in `amy/llm-testing/` are a good test case.

---

#### 7.5 Common errors and fixes

| Error | Likely cause | Fix |
|---|---|---|
| `supabaseUrl is required` | `.env.local` loaded after Supabase client initializes | Use `npx tsx --env-file=.env.local` instead of plain `npx tsx` |
| `No transcript rows found` | Wrong `recording_id`, or Step 5 hasn't run yet | Open `sample-transcripts/recording-ids.json` for the correct UUID; run Step 5 first if the file doesn't exist |
| `Cannot find module '@langchain/anthropic'` | LangChain packages not installed | Run `npm install langchain @langchain/core @langchain/anthropic zod` |
| `OutputParserException` | LLM output didn't conform to the Zod schema | LangChain retries once automatically before throwing — check `SYSTEM_PROMPT` is clear; log `raw.content` to see what the LLM returned |
| `ZodError: invalid_type at ...` | LLM returned a field with the wrong type (e.g. a string where a number was expected) | Log `raw.content` to inspect the raw output; tighten the `.describe()` hint for the failing field in `AnalysisSchema` |
| `DB insert failed: null value in column "recording_id"` | UUID not passed through correctly | `console.log(recordingId)` at the top of `writeAnalysis` to confirm it's non-empty |
| `DB insert failed: violates foreign key constraint` | `recording_id` doesn't exist in the `recordings` table | The recording row must exist first — confirm Step 5 wrote to `recordings` before running this script |
| `Cannot find module './supabase'` | Import path wrong or `lib/supabase.ts` missing | Confirm `supabaseAdmin` is exported from `lib/supabase.ts` (added in Step 5) |

---

> ✅ If all four columns are populated and the row links to the correct `recording_id`, **Step 7 is complete.**

→ Next: Step 8 — Next.js API Routes

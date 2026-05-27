# Step 5 — Phase 1: Transcript Parsing & DB Write

*Part of [AI Pipeline MVP Outline](ai-pipeline-mvp-outline.md)*

---

This step takes the utterances saved by Step 4 and writes them to the Supabase `transcript` table. **You do not need to call the Deepgram API again** — the JSON file saved in Step 4 (`sample-transcripts/sample-audio-1.json`) is the input for this entire step.

Two versions of the text are produced per DB row: `content_raw` (filler words kept, sent to LLM in Step 7) and `content_clean` (filler words stripped, displayed in the UI in Step 9).

---

## What you will do in this step

1. **5.2** — Understand the data transformation (what changes on the way to the DB)
2. **5.3** — Add `stripFillerWords()` to `lib/deepgram.ts`
3. **5.4** — Add `createRecording()` and `writeTranscript()` to `lib/supabase.ts`
4. **5.5** — Create and run `scripts/test-transcript.ts` (reads JSON → writes to DB)
5. **5.6** — Verify the rows in Supabase
6. **5.7** — Common errors and fixes

---

#### 5.2 Understand the data transformation

Each JSON utterance becomes one row in the `transcript` table. Here is what changes:

```
JSON utterance                            transcript row
──────────────────────────────────────    ──────────────────────────────────────────────────────
speaker:    0                        →    speaker:            "Speaker 0"
transcript: "Yeah um I think the         content_raw:        "Yeah um I think the price is a bit high"
             price is a bit high"    →    content_clean:      "Yeah I think the price is a bit high"
start:      45.2                     →    sentence_start_sec: 45.2
```

Two transformations happen:

1. **Speaker label formatting** — The JSON has `speaker: 0` (integer). The DB stores `"Speaker 0"` (string) for readability.

2. **Filler word stripping** — `content_raw` is kept exactly as Deepgram returned it (filler words intact). `content_clean` has `um`, `uh`, `like`, `you know`, and similar words removed.
   - The LLM receives `content_raw` — filler words signal hesitation and are useful for objection detection.
   - The UI displays `content_clean` — easier to read.

---

#### 5.3 Add filler word stripping to `lib/deepgram.ts`

Open `lib/deepgram.ts`. At the bottom of the file, **after** the `transcribeFile` function, add:

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

Save the file.

> **Why `like` is in the list:** In sales calls, `like` almost always appears as a filler ("it's like, really expensive"). If you ever need to preserve it, remove `like` from the pattern.

---

#### 5.4 Add DB write helpers to `lib/supabase.ts`

Open `lib/supabase.ts`. After the existing Supabase client setup, add the following two functions.

**First**, add the import at the top of the file (with the other imports):

```typescript
import { DeepgramUtterance, stripFillerWords } from './deepgram'
```

**Then**, add these two functions at the bottom:

```typescript
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

Save the file.

> **Why `createRecording` must come first:** The `transcript` table has a foreign key (`recording_id`) pointing to the `recordings` table. If you try to insert transcript rows before the recording row exists, Supabase will reject the insert with a foreign key constraint error.

---

#### 5.5 Create and run the test script

**Step 1 — Create the file**

Create a new file at `scripts/test-transcript.ts` and paste in:

```typescript
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import fs from 'fs'
import { DeepgramUtterance } from '../lib/deepgram'
import { createRecording, writeTranscript } from '../lib/supabase'

// Points to the JSON saved by scripts/test-deepgram.ts in Step 4
// No Deepgram API call needed — utterances are already on disk
const JSON_FILE = './sample-transcripts/sample-audio-1.json'

async function run() {
  // 1. Load utterances from saved JSON
  console.log('📂 Loading utterances from saved JSON...')
  const utterances: DeepgramUtterance[] = JSON.parse(fs.readFileSync(JSON_FILE, 'utf-8'))
  console.log(`✅ Loaded ${utterances.length} utterances from ${JSON_FILE}`)

  // 2. Create a recordings row first (required — transcript has FK to recordings)
  console.log('\n📝 Creating recording row...')
  const recordingId = await createRecording({
    rep: 'Test Rep',
    client: 'Test Client',
    source: 'mvp-test',
  })
  console.log(`✅ Recording row created: ${recordingId}`)

  // 3. Write all transcript rows in one batch insert
  console.log('\n💾 Writing transcript rows to Supabase...')
  await writeTranscript(recordingId, utterances)
  console.log(`✅ ${utterances.length} transcript rows written`)

  // 4. Preview first 3 rows
  console.log('\nPreview (first 3 utterances):')
  utterances.slice(0, 3).forEach(u => {
    console.log(`  [${u.start.toFixed(1)}s] Speaker ${u.speaker}: ${u.transcript}`)
  })

  // Copy this UUID — needed for Step 7 (LLM call fetches transcript by recording_id)
  console.log(`\n📋 recording_id for Steps 7+: ${recordingId}`)
}

run().catch(err => console.error('❌', err.message))
```

**Step 2 — Run it**

```bash
npx ts-node --esm scripts/test-transcript.ts
```

**Step 3 — Check the output**

Expected output:

```
📂 Loading utterances from saved JSON...
✅ Loaded 24 utterances from ./sample-transcripts/sample-audio-1.json

📝 Creating recording row...
✅ Recording row created: a1b2c3d4-e5f6-...

💾 Writing transcript rows to Supabase...
✅ 24 transcript rows written

Preview (first 3 utterances):
  [0.0s] Speaker 0: Hi, thanks for calling GlobiFYE. How can I help you today?
  [3.2s] Speaker 1: Yeah, um, I was looking at your pricing page and I had a few questions.
  [6.8s] Speaker 0: Of course, happy to walk you through it.

📋 recording_id for Steps 7+: a1b2c3d4-e5f6-...
```

> **Copy the `recording_id`** printed at the end and save it somewhere — you will paste it into the Step 7 test script.

---

#### 5.6 Verify in Supabase

**Check the `recordings` table:**

1. Open your Supabase project → **Table Editor** → select `recordings`
2. You should see a new row at the top
3. Click on it and confirm the `call_metadata` column contains `{ "rep": "Test Rep", "client": "Test Client", "source": "mvp-test" }`

**Check the `transcript` table:**

1. Go to **Table Editor** → select `transcript`
2. In the filter bar, filter `recording_id` = the UUID printed in the terminal
3. You should see N rows (matching the utterance count from the terminal output)
4. Click into a few rows and check each column:

| Column | What to check |
|---|---|
| `speaker` | Values are `"Speaker 0"` or `"Speaker 1"` — string, not integer |
| `content_raw` | Contains filler words (`um`, `uh`, etc.) exactly as Deepgram returned |
| `content_clean` | Same text with filler words removed — should read more naturally |
| `sentence_start_sec` | Numbers that increase from row to row, matching the audio timeline |

---

#### 5.7 Common errors and fixes

| Error | Likely cause | Fix |
|---|---|---|
| `ENOENT: no such file or directory, open './sample-transcripts/sample-audio-1.json'` | Step 4 test script was not run, or file is in a different path | Run `scripts/test-deepgram.ts` first; confirm the file exists at `sample-transcripts/sample-audio-1.json` |
| `Transcript write failed: violates foreign key constraint` | `writeTranscript` called before `createRecording` | Always call `createRecording` first and pass the returned `id` to `writeTranscript` |
| `Failed to create recording row: ...` | Supabase keys missing or wrong | Check `SUPABASE_SERVICE_ROLE_KEY` and `NEXT_PUBLIC_SUPABASE_URL` in `.env.local` |
| `content_clean` is identical to `content_raw` | Filler words in audio don't match the regex | The `FILLER_PATTERN` uses the `i` flag — check if words like `"Like"` or `"Um"` appear at the sentence start |
| `speaker` column shows `"Speaker undefined"` | `diarize: true` was not set in Step 4 | Check `lib/deepgram.ts` — confirm `diarize: true` is in the options |
| `Cannot find module './deepgram'` in `supabase.ts` | Import path wrong | Use `'./deepgram'` — both files are in the same `lib/` folder |
| `sentence_start_sec` is `0` for all rows | Timestamps missing from utterance data | Confirm `utterances: true` is set in `transcribeFile` in `lib/deepgram.ts` |

---

> ✅ If the `transcript` table has rows with distinct speakers, `content_raw` containing filler words, and `content_clean` without them, **Step 5 is complete.** Move on to [Step 6 — LLM Analysis Prompt](ai-pipeline-mvp-outline.md#step-6--phase-2-llm-analysis-prompt).

# Step 4 — Deepgram Integration *(batch mode first, streaming later)*

*Part of [AI Pipeline MVP Outline](ai-pipeline-mvp-outline.md)*

---

This step gets Deepgram working end-to-end: account setup → API key → `lib/deepgram.ts` → test script → verified output. Streaming (WebSocket) comes in Step 10 — batch mode is enough to validate the full pipeline for the demo.

---

#### 4.1 Sign up for Deepgram and get free credits

1. Go to [https://deepgram.com](https://deepgram.com) and sign up
2. Deepgram offers free credits on new accounts
3. After sign-up, you'll land on the Deepgram Console dashboard

> ⚠️ Deepgram charges per audio-hour. Free credits cover testing, but don't run large audio files repeatedly once you're past validation.

---

#### 4.2 Get the API key

1. In the Deepgram Console, click **"API Keys"** in the left sidebar
2. Click **"Create a New API Key"**
3. Give it a name (e.g. `globifye-mvp`) and set permissions to **Member**
4. Copy the key — it is only shown once

Add it to `.env.local`:

```env
DEEPGRAM_API_KEY = your-deepgram-api-key-here
```

---

#### 4.3 Get a sample audio file

You need a test `.mp3` or `.wav` file of a two-person conversation to validate speaker diarization. 

Place the file in the project root as `sample-audio.mp3`:

```bash
# Confirm the file is there
ls -lh sample-audio.mp3
```

> ⚠️ Add `sample-audio.mp3` to `.gitignore` — don't commit audio files to the repo.

---

#### 4.4 Populate `lib/deepgram.ts`

Open `lib/deepgram.ts` and add:

```typescript
import { createClient } from '@deepgram/sdk'
import * as fs from 'fs'

const deepgram = createClient(process.env.DEEPGRAM_API_KEY!)

export type DeepgramUtterance = {
  speaker: number          // 0, 1, 2... — Deepgram's speaker index
  transcript: string       // raw text, filler words intact
  start: number            // utterance start time in seconds
  end: number              // utterance end time in seconds
}

/**
 * Transcribes a local audio file using Deepgram batch (pre-recorded) API.
 * Returns utterances — sentence-level segments with speaker labels and timestamps.
 *
 * Why utterances and not words?
 *   - utterances=true groups words into sentence-level chunks per speaker
 *   - Each utterance maps to one row in the transcript table
 *   - Word-level timestamps are not needed for this pipeline
 */
export async function transcribeFile(filePath: string): Promise<DeepgramUtterance[]> {
  const audioBuffer = fs.readFileSync(filePath)

  const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
    audioBuffer,
    {
      model: 'nova-3',       // best accuracy for English
      diarize: true,         // required: identifies and labels speakers
      punctuate: true,       // adds sentence-ending punctuation
      utterances: true,      // required: groups words into speaker-labeled segments
      smart_format: true,    // formats numbers, currencies, dates (useful for sales calls)
      // filler_words: false  // default — filler words (um, uh) are kept in output
                              // we strip them ourselves in Step 5 to produce content_clean
    }
  )

  if (error) throw new Error(`Deepgram transcription failed: ${error.message}`)

  const utterances = result?.results?.utterances
  if (!utterances || utterances.length === 0) {
    throw new Error(
      'Deepgram returned no utterances. Verify diarize=true and utterances=true are set, and that the audio file has audible speech.'
    )
  }

  return utterances.map(u => ({
    speaker: u.speaker ?? 0,
    transcript: u.transcript,
    start: u.start,
    end: u.end,
  }))
}
```

---

#### 4.5 Test the batch transcription

Create `scripts/test-deepgram.ts`:

```typescript
import { transcribeFile } from '../lib/deepgram'

const AUDIO_FILE = './sample-audio.mp3'

transcribeFile(AUDIO_FILE)
  .then(utterances => {
    console.log(`✅ Transcription complete — ${utterances.length} utterances\n`)
    utterances.forEach(u => {
      console.log(`[${u.start.toFixed(1)}s] Speaker ${u.speaker}: ${u.transcript}`)
    })
  })
  .catch(err => console.error('❌ Deepgram error:', err.message))
```

Run it:

```bash
npx ts-node --esm scripts/test-deepgram.ts
```

Expected output (abbreviated):

```
✅ Transcription complete — 24 utterances

[0.0s] Speaker 0: Hi, thanks for calling GlobiFYE. How can I help you today?
[3.2s] Speaker 1: Yeah, um, I was looking at your pricing page and I had a few questions.
[6.8s] Speaker 0: Of course, happy to walk you through it.
[8.5s] Speaker 1: So the thing is, uh, we're a pretty small team and the enterprise tier feels like a lot.
...
```

---

#### 4.6 Verify the output — four things to check

| What to check | What to look for | Problem if missing |
|---|---|---|
| **Multiple speakers** | At least `Speaker 0` and `Speaker 1` appear | Diarization failed — confirm `diarize: true` is set and the audio has two distinct voices |
| **Sentence-level segments** | Each line is a complete sentence or phrase, not a single word | `utterances: true` may not be set |
| **Filler words present** | Words like `um`, `uh`, `like`, `you know` appear in the transcript | They should be there — Nova-3 does not strip them by default. Needed for `content_raw` in Step 5 |
| **Timestamps make sense** | `[0.0s]` at the start, numbers increase throughout, roughly match the audio duration | If all timestamps are `0.0`, the audio file may be corrupt or in an unsupported format |

---

#### 4.7 Common errors and fixes

| Error | Likely cause | Fix |
|---|---|---|
| `DEEPGRAM_API_KEY` is `undefined` | Key not in `.env.local` or file not loaded | Confirm `.env.local` has `DEEPGRAM_API_KEY=...` and restart the terminal |
| `Deepgram returned no utterances` | Audio has no speech, or wrong format | Test with a different audio file; confirm it plays correctly before transcribing |
| `Error: ENOENT: no such file or directory` | `sample-audio.mp3` not found | Confirm the file is in the project root and the path matches |
| `401 Unauthorized` | Invalid or expired API key | Regenerate the key in the Deepgram Console |
| All utterances assigned to `Speaker 0` | Only one voice detected, or voices too similar | Normal for single-speaker audio — diarization works best with two distinct voices |

---

> ✅ If you see multiple speakers, sentence-level segments, and filler words in the output, **Step 4 is complete.**

→ Next: Step 5 — Transcript Parsing & DB Write *(file coming soon)*
